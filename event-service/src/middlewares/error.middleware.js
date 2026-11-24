const { AppError } = require('../utils/error');
const { config } = require('../config');
const logger = require('../config/logger');

module.exports = (error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      success: false,
      error: error.code,
      message: error.message,
    });
  }

  if (error.type === 'entity.parse.failed' || error instanceof SyntaxError && error.status === 400) {
    return res.status(400).json({ success: false, error: 'INVALID_JSON', message: 'Request body contains invalid JSON' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the 1 MB limit' });
  }

  const prismaErrors = {
    P2002: { status: 409, code: 'CONFLICT', message: 'A resource with the same unique value already exists' },
    P2004: { status: 409, code: 'CONSTRAINT_VIOLATION', message: 'The request violates a database constraint' },
    P2003: { status: 409, code: 'REFERENTIAL_INTEGRITY', message: 'The request conflicts with a related resource' },
    P2014: { status: 409, code: 'RELATIONSHIP_CONFLICT', message: 'The requested change violates a required relationship' },
    P2025: { status: 404, code: 'NOT_FOUND', message: 'The requested resource was not found' },
    P2000: { status: 400, code: 'VALUE_TOO_LONG', message: 'A supplied value exceeds the database field limit' },
    P2023: { status: 400, code: 'INVALID_DATA', message: 'A supplied value has an invalid format' },
    P2024: { status: 503, code: 'DATABASE_BUSY', message: 'The database connection pool is temporarily unavailable' },
    P1001: { status: 503, code: 'DATABASE_UNAVAILABLE', message: 'The database is temporarily unavailable' },
    P1002: { status: 503, code: 'DATABASE_TIMEOUT', message: 'The database connection timed out' },
    P1017: { status: 503, code: 'DATABASE_DISCONNECTED', message: 'The database connection was interrupted' },
  };

  // Prisma's raw-query wrapper may expose PostgreSQL CHECK/trigger violations as P2010.
  // Map only known integrity SQLSTATEs; never return the database message to callers.
  const databaseConstraintCode = String(error.meta?.code || '');
  if (error.code === 'P2010' && ['23503', '23505', '23514'].includes(databaseConstraintCode)) {
    return res.status(409).json({
      success: false,
      error: 'CONSTRAINT_VIOLATION',
      message: 'The request conflicts with a database integrity rule',
    });
  }

  if (prismaErrors[error.code]) {
    const mapped = prismaErrors[error.code];
    logger.warn('Mapped database request error', { code: error.code, path: req.path, method: req.method });
    return res.status(mapped.status).json({ success: false, error: mapped.code, message: mapped.message });
  }

  logger.error('Unhandled request error', {
    message: error.message,
    stack: config.NODE_ENV === 'production' ? undefined : error.stack,
    path: req.path,
    method: req.method,
  });
  return res.status(500).json({
    success: false,
    error: 'SERVER_ERROR',
    message: 'Internal Server Error',
  });
};
