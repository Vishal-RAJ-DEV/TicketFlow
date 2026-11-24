const crypto = require('node:crypto');
const { config } = require('../config');
const { UnauthorizedError, ServiceUnavailableError } = require('../utils/error');
const matches = (provided, expected) => {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(provided); const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const tokenFrom = (req) => {
  const authorization = req.headers.authorization || '';
  if (authorization.startsWith('Bearer ')) return authorization.slice(7);
  return req.headers['x-ops-token'];
};
const requireOpsToken = (req, res, next) => {
  if (!config.OPS_TOKEN) return next(new ServiceUnavailableError('Event Service operations access is not configured'));
  if (!matches(String(tokenFrom(req) || ''), config.OPS_TOKEN)) return next(new UnauthorizedError('A valid operations token is required'));
  return next();
};
const requireMetricsToken = (req, res, next) => {
  if (!config.METRICS_TOKEN) return next(new ServiceUnavailableError('Event Service metrics access is not configured'));
  if (!matches(String(req.headers['x-metrics-token'] || ''), config.METRICS_TOKEN)) return next(new UnauthorizedError('A valid metrics token is required'));
  return next();
};
module.exports = { requireOpsToken, requireMetricsToken };
