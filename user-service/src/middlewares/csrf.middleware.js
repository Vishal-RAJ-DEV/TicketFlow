'use strict';

const { doubleCsrf } = require('csrf-csrf');
const { config } = require('../config');

const isProduction = config.NODE_ENV === 'production';
const SESSION_COOKIE_NAME = isProduction ? '__Host-ticketflow-csrf-session' : 'ticketflow-csrf-session';
const CSRF_COOKIE_NAME = isProduction ? '__Host-ticketflow-csrf' : 'ticketflow-csrf';
const CSRF_MIRROR_COOKIE_NAME = isProduction ? '__Host-psifi.x-csrf-token' : 'x-csrf-token';

const csrfCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'strict',
  path: '/',
  maxAge: 24 * 60 * 60 * 1000,
};

const isCsrfExempt = (req) => {
  const authorization = req.headers.authorization;
  return typeof authorization === 'string' && /^Bearer\s+\S+$/i.test(authorization);
};

const {
  doubleCsrfProtection,
} = doubleCsrf({
  getSecret: () => config.CSRF_SECRET,
  getSessionIdentifier: (req) => req.cookies?.[SESSION_COOKIE_NAME] || '',
  cookieName: CSRF_COOKIE_NAME,
  cookieOptions: csrfCookieOptions,
  getCsrfTokenFromRequest: (req) => req.headers['x-csrf-token'],
  skipCsrfProtection: isCsrfExempt,
});

module.exports = {
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_MIRROR_COOKIE_NAME,
  csrfCookieOptions,
  doubleCsrfProtection,
};
