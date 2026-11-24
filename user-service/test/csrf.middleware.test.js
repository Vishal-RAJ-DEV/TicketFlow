'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { randomBytes } = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.GOOGLE_CLIENT_ID = 'unit-test-google-client';
process.env.SENDGRID_API_KEY = 'unit-test-sendgrid-key';
process.env.MAIL_SEND = 'false';
process.env.CSRF_SECRET = 'user-service-test-csrf-hmac-secret-at-least-32-characters';

const { validateUserServiceCsrfCookie } = require('../src/index');
const {
  SESSION_COOKIE_NAME,
  CSRF_MIRROR_COOKIE_NAME,
  csrfCookieOptions,
  generateCsrfToken,
  doubleCsrfProtection,
} = require('../src/middlewares/csrf.middleware');

const createApp = () => {
  const app = express();
  app.use(cookieParser());
  app.use((req, res, next) => {
    if (req.path === '/csrf' && !req.cookies[SESSION_COOKIE_NAME]) {
      const sessionId = randomBytes(32).toString('base64url');
      res.cookie(SESSION_COOKIE_NAME, sessionId, csrfCookieOptions);
      req.cookies[SESSION_COOKIE_NAME] = sessionId;
    }
    next();
  });
  app.use(validateUserServiceCsrfCookie);
  app.use(doubleCsrfProtection);
  app.get('/csrf', (req, res) => {
    const csrfToken = generateCsrfToken(req, res);
    res.cookie(CSRF_MIRROR_COOKIE_NAME, csrfToken, csrfCookieOptions);
    res.status(200).json({ csrfToken });
  });
  app.post('/write', (req, res) => res.status(200).json({ success: true }));
  app.post('/bearer-write', (req, res) => res.status(200).json({ success: true, client: 'bearer' }));
  app.use((error, req, res, next) => {
    if (error?.code === 'EBADCSRFTOKEN') {
      return res.status(403).json({ success: false, error: 'CSRF_INVALID' });
    }
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  });
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

test('User Service accepts a valid session-bound token and rejects missing or mismatched tokens', async () => {
  await withServer(createApp(), async (baseUrl) => {
    const bootstrap = await fetch(baseUrl + '/csrf');
    assert.equal(bootstrap.status, 200);
    const { csrfToken } = await bootstrap.json();
    const cookie = getCookieHeader(bootstrap);
    assert.ok(cookie.includes(SESSION_COOKIE_NAME + '='));
    assert.ok(cookie.includes(CSRF_MIRROR_COOKIE_NAME + '='));

    const valid = await fetch(baseUrl + '/write', {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
    });
    assert.equal(valid.status, 200);

    const missing = await fetch(baseUrl + '/write', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(missing.status, 403);

    const mismatched = await fetch(baseUrl + '/write', {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken + '-tampered' },
    });
    assert.equal(mismatched.status, 403);
  });
});

test('User Service CSRF guard preserves Bearer clients and safe methods', async () => {
  await withServer(createApp(), async (baseUrl) => {
    const bearer = await fetch(baseUrl + '/bearer-write', {
      method: 'POST',
      headers: { Authorization: 'Bearer mobile-client-token' },
    });
    assert.equal(bearer.status, 200);

    const safe = await fetch(baseUrl + '/csrf');
    assert.equal(safe.status, 200);
  });
});
