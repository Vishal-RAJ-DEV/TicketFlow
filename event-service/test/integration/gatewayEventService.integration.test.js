const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const close = (server) => new Promise((resolve) => {
  if (!server?.listening) return resolve();
  server.close(() => resolve());
});

const jsonRequest = async (url, { method = 'GET', token, headers = {}, body } = {}) => {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { response, payload };
};

test('real Gateway proxy signs identity, rejects replay and enforces organizer membership', { skip: !enabled }, async () => {
  const secret = 'integration-gateway-assertion-secret-' + 'g'.repeat(32);
  const accessSecret = 'integration-access-secret-' + 'a'.repeat(32);
  const refreshSecret = 'integration-refresh-secret-' + 'r'.repeat(32);
  const internalKey = 'integration-user-service-key-' + 'u'.repeat(32);

  process.env.NODE_ENV = 'test';
  process.env.GATEWAY_ASSERTION_SECRET = secret;
  process.env.GATEWAY_ASSERTION_SECRET_PREVIOUS = '';
  process.env.JWT_ACCESS_SECRET = accessSecret;
  process.env.JWT_REFRESH_SECRET = refreshSecret;
  process.env.USER_SERVICE_INTERNAL_KEY = internalKey;
  process.env.USER_SERVICE_INTERNAL_KEY_PREVIOUS = '';
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

  let internalCalls = 0;
  const userService = http.createServer((req, res) => {
    const userId = decodeURIComponent(req.url.split('/').pop());
    if (req.method !== 'GET' || !req.url.startsWith('/user/internal/')) {
      res.writeHead(404).end();
      return;
    }
    if (req.headers['x-internal-service-key'] !== internalKey) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ success: false }));
      return;
    }
    internalCalls += 1;
    if (userId === 'missing-invite-user') {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ success: false }));
      return;
    }
    const active = userId !== 'suspended-invite-user';
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      success: true,
      data: { id: userId, active, status: active ? 'ACTIVE' : 'SUSPENDED' },
    }));
  });

  let eventServer;
  let gatewayServer;
  let organizerIds = [];
  let prisma;
  let redisClient;
  try {
    await listen(userService);
    process.env.USER_SERVICE_URL = 'http://127.0.0.1:' + userService.address().port;

    const eventApp = require('../../src/index').app;
    eventServer = await listen(http.createServer(eventApp));
    const eventUrl = 'http://127.0.0.1:' + eventServer.address().port;
    process.env.EVENT_SERVICE_URL = eventUrl;

    const jwt = require('../../../api-gateway/node_modules/jsonwebtoken');
    const express = require('../../../api-gateway/node_modules/express');
    const gatewayRoutes = require('../../../api-gateway/src/routes');
    const gatewayApp = express();
    gatewayApp.use(express.json({ limit: '1mb' }));
    gatewayApp.use('/api', gatewayRoutes);
    gatewayServer = await listen(http.createServer(gatewayApp));

    const ownerId = 'integration-owner-' + randomUUID();
    const otherUserId = 'integration-other-' + randomUUID();
    const ownerToken = jwt.sign({ id: ownerId }, accessSecret, { expiresIn: '5m' });
    const otherToken = jwt.sign({ id: otherUserId }, accessSecret, { expiresIn: '5m' });
    const gatewayBase = 'http://127.0.0.1:' + gatewayServer.address().port;

    const created = await jsonRequest(gatewayBase + '/api/events/organizers', {
      method: 'POST',
      token: ownerToken,
      headers: { 'x-user-id': 'attacker-controlled-user' },
      body: { name: 'Gateway Integration Organizer' },
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    const organizer = created.payload.data;
    organizerIds.push(organizer.id);
    assert.equal(organizer.ownerId, ownerId, 'Gateway must replace caller-supplied x-user-id with the verified JWT identity');

    const denied = await jsonRequest(gatewayBase + '/api/events/events/organizers/' + organizer.id, {
      method: 'POST',
      token: otherToken,
      body: { title: 'Unauthorized Event', category: 'music' },
    });
    assert.equal(denied.response.status, 403, 'an authenticated non-member must not manage another organizer');

    const invited = await jsonRequest(gatewayBase + '/api/events/organizers/' + organizer.id + '/members/active-invite-user', {
      method: 'PUT',
      token: ownerToken,
      body: { role: 'EDITOR' },
    });
    assert.equal(invited.response.status, 200, JSON.stringify(invited.payload));
    assert.equal(invited.payload.data.userId, 'active-invite-user');

    const suspended = await jsonRequest(gatewayBase + '/api/events/organizers/' + organizer.id + '/members/suspended-invite-user', {
      method: 'PUT',
      token: ownerToken,
      body: { role: 'VIEWER' },
    });
    assert.equal(suspended.response.status, 403, 'suspended users must not be invited');

    const missing = await jsonRequest(gatewayBase + '/api/events/organizers/' + organizer.id + '/members/missing-invite-user', {
      method: 'PUT',
      token: ownerToken,
      body: { role: 'VIEWER' },
    });
    assert.equal(missing.response.status, 404, 'non-existent users must not be invited');
    assert.ok(internalCalls >= 4, 'Event Service must call the authenticated User Service status endpoint');

    const invalidSignature = await jsonRequest(eventUrl + '/organizers', {
      method: 'POST',
      headers: {
        'x-user-id': ownerId,
        'x-gateway-timestamp': String(Date.now()),
        'x-gateway-nonce': 'a'.repeat(32),
        'x-gateway-signature': '0'.repeat(64),
      },
      body: { name: 'Invalid Signature Organizer' },
    });
    assert.equal(invalidSignature.response.status, 401);

    const { signGatewayAssertion } = require('../../../shared/utils/gatewayAssertion');
    const replayBody = { name: 'Replay Protection Organizer' };
    const assertion = signGatewayAssertion({
      secret,
      method: 'POST',
      path: '/organizers',
      userId: ownerId,
      body: replayBody,
    });
    const replayHeaders = {
      'x-user-id': ownerId,
      'x-gateway-timestamp': assertion.timestamp,
      'x-gateway-nonce': assertion.nonce,
      'x-gateway-signature': assertion.signature,
    };
    const firstUse = await jsonRequest(eventUrl + '/organizers', {
      method: 'POST', headers: replayHeaders, body: replayBody,
    });
    assert.equal(firstUse.response.status, 201, JSON.stringify(firstUse.payload));
    organizerIds.push(firstUse.payload.data.id);

    const replay = await jsonRequest(eventUrl + '/organizers', {
      method: 'POST', headers: replayHeaders, body: replayBody,
    });
    assert.equal(replay.response.status, 401, 'a previously accepted assertion nonce must be rejected');
  } finally {
    if (!prisma) {
      try { prisma = require('../../src/config/prisma'); } catch {}
    }
    if (organizerIds.length && prisma) {
      await prisma.organizer.deleteMany({ where: { id: { in: organizerIds } } }).catch(() => {});
    }
    if (prisma) await prisma.$disconnect().catch(() => {});
    await close(gatewayServer);
    await close(eventServer);
    await close(userService);
    try {
      redisClient = require('../../../api-gateway/src/config/redis').RedisClient;
      await redisClient.closeConnection();
    } catch {}
  }
});
