'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.EVENT_SERVICE_RATE_LIMIT_WINDOW_MS = '60000';
process.env.EVENT_SERVICE_RATE_LIMIT_MAX_REQUESTS = '2';
process.env.EVENT_SERVICE_EDGE_RATE_LIMIT_WINDOW_MS = '60000';
process.env.EVENT_SERVICE_EDGE_RATE_LIMIT_MAX_REQUESTS = '10';

const { authenticatedApiRateLimit, healthApp } = require('../src/index');

const withServer = async (app, run) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address();
    await run('http://127.0.0.1:' + address.port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
};

test('authenticated Event Service routes enforce a per-user request quota', async () => {
  const app = express();
  app.use((req, res, next) => {
    req.user = { id: req.headers['x-test-user'] || 'user-a' };
    next();
  });
  app.use(authenticatedApiRateLimit);
  app.get('/resource', (req, res) => res.status(200).send('ok'));

  await withServer(app, async (baseUrl) => {
    const request = (user) => fetch(baseUrl + '/resource', { headers: { 'x-test-user': user } });
    assert.equal((await request('user-a')).status, 200);
    assert.equal((await request('user-a')).status, 200);
    const limited = await request('user-a');
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('ratelimit'));
    assert.equal((await request('user-b')).status, 200);
  });
});

test('health probes are served by a separate loopback application', async () => {
  await withServer(healthApp, async (baseUrl) => {
    const response = await fetch(baseUrl + '/health');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'healthy');
  });
});
