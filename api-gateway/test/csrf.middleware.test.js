'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { randomBytes } = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-at-least-32-characters-long';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-32-characters-long';
process.env.GATEWAY_ASSERTION_SECRET = 'test-gateway-assertion-secret-at-least-32-characters';
process.env.CSRF_SECRET = 'test-csrf-hmac-secret-at-least-32-characters-long';

const {
  SESSION_COOKIE_NAME,
  ensureCsrfSession,
  generateCsrfToken,
  doubleCsrfProtection,
} = require('../src/middlewares/csrf.middleware');

const createTestApp = () => {
  const app = express();
  app.use(cookieParser());
  app.use('/api', ensureCsrfSession);
  app.get('/api/csrf', (req, res) => {
    const csrfToken = generateCsrfToken(req, res, { overwrite: Boolean(req.csrfSessionCreated) });
    res.status(200).json({ csrfToken });
  });
  app.use('/api', doubleCsrfProtection);
  app.post('/api/write', (req, res) => res.status(200).json({ success: true }));
  app.post('/api/payments/webhooks/razorpay', (req, res) => res.status(200).json({ webhook: true }));
  app.post('/api/native/write', (req, res) => res.status(200).json({ native: true }));
  return app;
};

const withServer = async (app, callback) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    await callback('http://127.0.0.1:' + server.address().port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
};

const getCookieHeader = (response) => {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  return setCookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
};

test('CSRF bootstrap issues a token and cookie that authorize same-session writes', async () => {
  await withServer(createTestApp(), async (baseUrl) => {
    const bootstrap = await fetch(baseUrl + '/api/csrf');
    assert.equal(bootstrap.status, 200);
    const { csrfToken } = await bootstrap.json();
    const cookie = getCookieHeader(bootstrap);
    assert.ok(csrfToken);
    assert.ok(cookie.includes(SESSION_COOKIE_NAME + '='));

    const write = await fetch(baseUrl + '/api/write', {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
    });
    assert.equal(write.status, 200);
  });
});

test('CSRF rejects missing and incorrect request tokens', async () => {
  await withServer(createTestApp(), async (baseUrl) => {
    const bootstrap = await fetch(baseUrl + '/api/csrf');
    const cookie = getCookieHeader(bootstrap);
    const { csrfToken } = await bootstrap.json();

    const missing = await fetch(baseUrl + '/api/write', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(missing.status, 403);

    const incorrect = await fetch(baseUrl + '/api/write', {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken + '-tampered' },
    });
    assert.equal(incorrect.status, 403);
  });
});

test('CSRF token cannot be replayed with another session cookie', async () => {
  await withServer(createTestApp(), async (baseUrl) => {
    const bootstrap = await fetch(baseUrl + '/api/csrf');
    const cookie = getCookieHeader(bootstrap);
    const { csrfToken } = await bootstrap.json();
    const otherSession = cookie.replace(
      new RegExp(SESSION_COOKIE_NAME + '=[^;]+'),
      SESSION_COOKIE_NAME + '=' + randomBytes(32).toString('base64url')
    );

    const response = await fetch(baseUrl + '/api/write', {
      method: 'POST',
      headers: { Cookie: otherSession, 'X-CSRF-Token': csrfToken },
    });
    assert.equal(response.status, 403);
  });
});

test('Bearer clients and the signature-verified Razorpay webhook are exempt', async () => {
  await withServer(createTestApp(), async (baseUrl) => {
    const native = await fetch(baseUrl + '/api/native/write', {
      method: 'POST',
      headers: { Authorization: 'Bearer mobile-client-token' },
    });
    assert.equal(native.status, 200);

    const webhook = await fetch(baseUrl + '/api/payments/webhooks/razorpay', { method: 'POST' });
    assert.equal(webhook.status, 200);
  });
});
