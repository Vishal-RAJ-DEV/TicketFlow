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
  if (error.code === 'P2002') {
    return res.status(409).json({
      success: false,
      error: 'CONFLICT',
      message: 'A resource with the same unique value already exists',
    });
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