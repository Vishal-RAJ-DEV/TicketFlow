const crypto = require('node:crypto');
const { redis } = require('../config/redis');
const { config } = require('../config');
const { TooManyRequestsError, ServiceUnavailableError } = require('../utils/error');
const logger = require('../config/logger');

async function rateLimiter(key, maxRequests, windowMs) {
     const now = Date.now();
     const windowStart = now - windowMs;

     try {
          // MULTI keeps cleanup, insertion and counting atomic under concurrent requests.
          const transaction = redis.multi();
          transaction.zremrangebyscore(key, 0, windowStart);
          transaction.zadd(key, now, `${now}-${crypto.randomUUID()}`);
          transaction.zcard(key);
          transaction.expire(key, Math.ceil(windowMs / 1000));

          const results = await transaction.exec();
          if (!Array.isArray(results) || results.some((result) => !result || result[0])) {
               throw new Error('Redis rate-limit transaction returned a command error');
          }

          const requestCount = Number(results[2][1]);
          if (!Number.isFinite(requestCount)) throw new Error('Redis rate-limit count was invalid');

          if (requestCount > maxRequests) {
               const oldestRequest = await redis.zrange(key, 0, 0, 'WITHSCORES');
               const resetTime = oldestRequest.length >= 2 ? Number(oldestRequest[1]) + windowMs : now + windowMs;
               const retryAfter = Math.max(1, Math.ceil((resetTime - now) / 1000));
               return { allowed: false, remaining: 0, resetTime, retryAfter };
          }

          return { allowed: true, remaining: Math.max(0, maxRequests - requestCount), resetTime: now + windowMs };
     } catch (err) {
          logger.error('Rate limiter unavailable; rejecting request:', { message: err.message });
          return { allowed: false, unavailable: true, remaining: 0, resetTime: now + windowMs };
     }
}

function applyRateLimitHeaders(res, maxRequests, result) {
     res.setHeader('X-RateLimit-Limit', maxRequests);
     res.setHeader('X-RateLimit-Remaining', result.remaining);
     res.setHeader('X-RateLimit-Reset', new Date(result.resetTime).toISOString());
}

function rejectOrContinue(result, next, message) {
     if (result.unavailable) return next(new ServiceUnavailableError('Rate limiting is temporarily unavailable'));
     if (!result.allowed) {
          return next(new TooManyRequestsError(`${message} Please try again in ${result.retryAfter} seconds`, result.retryAfter));
     }
     return next();
}

function ipRateLimit(options = {}) {
     const maxRequests = options.max || config.RATE_LIMIT_MAX_REQUESTS;
     const windowMs = options.windowMs || config.RATE_LIMIT_WINDOW_MS;
     return async (req, res, next) => {
          const ip = req.ip || req.socket?.remoteAddress || 'unknown';
          const result = await rateLimiter(`ratelimit:ip:${ip}`, maxRequests, windowMs);
          applyRateLimitHeaders(res, maxRequests, result);
          if (!result.allowed && !result.unavailable) res.setHeader('Retry-After', result.retryAfter);
          if (!result.allowed) logger.warn(`IP rate limit rejected request from ${ip}`);
          rejectOrContinue(result, next, 'Too many requests.');
     };
}

function userRateLimit(options = {}) {
     const maxRequests = options.max || config.RATE_LIMIT_MAX_REQUESTS * 10;
     const windowMs = options.windowMs || config.RATE_LIMIT_WINDOW_MS;
     return async (req, res, next) => {
          if (!req.user?.id) return next();
          const userId = String(req.user.id);
          const result = await rateLimiter(`ratelimit:user:${userId}`, maxRequests, windowMs);
          applyRateLimitHeaders(res, maxRequests, result);
          if (!result.allowed && !result.unavailable) res.setHeader('Retry-After', result.retryAfter);
          if (!result.allowed) logger.warn(`User rate limit rejected request for user ${userId}`);
          rejectOrContinue(result, next, 'Too many requests.');
     };
}

function endpointRateLimit(maxRequests, windowMs) {
     return async (req, res, next) => {
          const ip = req.ip || req.socket?.remoteAddress || 'unknown';
          const endpoint = `${req.method}:${req.path}`;
          const result = await rateLimiter(`ratelimit:endpoint:${endpoint}:${ip}`, maxRequests, windowMs);
          applyRateLimitHeaders(res, maxRequests, result);
          if (!result.allowed && !result.unavailable) res.setHeader('Retry-After', result.retryAfter);
          if (!result.allowed) logger.warn(`Endpoint rate limit rejected ${endpoint} from ${ip}`);
          rejectOrContinue(result, next, 'Too many requests to this endpoint.');
     };
}

function combinedRateLimit(ipOptions = {}, userOptions = {}) {
     const ipLimiter = ipRateLimit(ipOptions);
     const userLimiter = userRateLimit(userOptions);
     return async (req, res, next) => {
          ipLimiter(req, res, (err) => {
               if (err) return next(err);
               userLimiter(req, res, next);
          });
     };
}

module.exports = { ipRateLimit, userRateLimit, endpointRateLimit, combinedRateLimit };
