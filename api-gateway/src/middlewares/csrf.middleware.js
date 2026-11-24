'use strict';

const { randomBytes } = require('node:crypto');
const { doubleCsrf } = require('csrf-csrf');
const { config } = require('../config');

const isProduction = config.NODE_ENV === 'production';
const SESSION_COOKIE_NAME = isProduction ? '__Host-ticketflow-csrf-session' : 'ticketflow-csrf-session';
const CSRF_COOKIE_NAME = isProduction ? '__Host-ticketflow-csrf' : 'ticketflow-csrf';
const CSRF_MIRROR_COOKIE_NAME = isProduction ? '__Host-ticketflow-csrf-mirror' : 'ticketflow-csrf-mirror';
const COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const csrfCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'strict',
  path: '/',
  maxAge: COOKIE_MAX_AGE_MS,
};

// Use a random, host-only cookie as the CSRF session identifier. The signed
// double-submit token is HMAC-bound to this identifier and cannot be replayed
// in another browser session.
const ensureCsrfSession = (req, res, next) => {
  const current = req.cookies?.[SESSION_COOKIE_NAME];
  const valid = typeof current === 'string' && /^[A-Za-z0-9_-]{43}$/.test(current);
  const sessionId = valid ? current : randomBytes(32).toString('base64url');

  if (!valid) {
    res.cookie(SESSION_COOKIE_NAME, sessionId, csrfCookieOptions);
    req.csrfSessionCreated = true;
  }

  req.csrfSessionId = sessionId;
  return next();
};

const setCsrfTokenCookie = (res, csrfToken) => {
  // This mirror is also HttpOnly. The frontend receives the token in the
  // /api/csrf JSON response and echoes it in X-CSRF-Token.
  res.cookie(CSRF_MIRROR_COOKIE_NAME, csrfToken, csrfCookieOptions);
};

const isCsrfExempt = (req) => {
  const requestPath = (req.originalUrl || req.url || '').split('?')[0];
  if (req.method === 'POST' && requestPath === '/api/payments/webhooks/razorpay') return true;

  // Browsers do not attach Authorization headers cross-site. Native/mobile clients
  // using explicit Bearer authentication therefore do not need cookie CSRF tokens.
  const authorization = req.headers.authorization;
  return typeof authorization === 'string' && /^Bearer\s+\S+$/i.test(authorization);
};

const validateCsrfDoubleSubmit = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || isCsrfExempt(req)) return next();

  // Explicit cookie/header equality is an additional double-submit check.
  // The following doubleCsrfProtection middleware verifies HMAC and session binding.
  const csrfCookie = req.cookies?.[CSRF_MIRROR_COOKIE_NAME];
  const csrfHeader = req.headers['x-csrf-token'];
  if (typeof csrfCookie !== 'string' || typeof csrfHeader !== 'string' || csrfCookie !== csrfHeader) {
    const error = new Error('Invalid CSRF token');
    error.statusCode = 403;
    error.code = 'EBADCSRFTOKEN';
    return next(error);
  }
  return next();
};

const {
  generateCsrfToken,
  doubleCsrfProtection,
} = doubleCsrf({
  getSecret: () => config.CSRF_SECRET,
  getSessionIdentifier: (req) => req.csrfSessionId,
  cookieName: CSRF_COOKIE_NAME,
  cookieOptions: csrfCookieOptions,
  getCsrfTokenFromRequest: (req) => req.headers['x-csrf-token'],
  skipCsrfProtection: isCsrfExempt,
});

module.exports = {
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_MIRROR_COOKIE_NAME,
  ensureCsrfSession,
  generateCsrfToken,
  setCsrfTokenCookie,
  validateCsrfDoubleSubmit,
  doubleCsrfProtection,
};
