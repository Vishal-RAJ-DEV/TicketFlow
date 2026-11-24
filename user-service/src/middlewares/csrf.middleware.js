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

function validateUserServiceCsrfCookie(req, res, next) {
     const authorization = req.headers.authorization;
     const isBearerRequest = typeof authorization === 'string' && /^Bearer\s+\S+$/i.test(authorization);
     if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || isBearerRequest) return next();

     const csrfCookie =
          (req.cookies && req.cookies['x-csrf-token']) ||
          (req.cookies && req.cookies['__Host-psifi.x-csrf-token']);
     const csrfHeader = req.headers['x-csrf-token'];
     req.csrfHeaderMatchesCookie = csrfCookie === csrfHeader;

     if (typeof csrfCookie !== 'string' || typeof csrfHeader !== 'string' || !req.csrfHeaderMatchesCookie) {
          const error = new Error('Invalid CSRF token');
          error.statusCode = 403;
          error.code = 'EBADCSRFTOKEN';
          return next(error);
     }
     return next();
}


const isCsrfExempt = (req) => {
  const authorization = req.headers.authorization;
  return typeof authorization === 'string' && /^Bearer\s+\S+$/i.test(authorization);
};

const {
  generateCsrfToken,
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
  validateUserServiceCsrfCookie,
  generateCsrfToken,
  doubleCsrfProtection,
};
