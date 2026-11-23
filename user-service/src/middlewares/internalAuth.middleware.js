const crypto = require('node:crypto');
const { config } = require('../config');
const { ForbiddenError } = require('../utils/error');
const safeEqual = (provided, expected) => {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(provided); const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const internalAuth = (req, res, next) => {
  const serviceKey = req.headers['x-internal-service-key'];
  const acceptedKeys = [config.INTERNAL_SERVICE_KEY, config.INTERNAL_SERVICE_KEY_PREVIOUS].filter(Boolean);
  if (!serviceKey || !acceptedKeys.some((key) => safeEqual(String(serviceKey), key))) {
    return next(new ForbiddenError('Invalid or missing internal service key'));
  }
  return next();
};
module.exports = { internalAuth };
