const { verifyGatewayAssertion } = require('../../../shared/utils/gatewayAssertion');
const { config } = require('../config');
const { UnauthorizedError, ServiceUnavailableError } = require('../utils/error');
const prisma = require('../config/prisma');
const logger = require('../config/logger');
const NONCE_RETENTION_MS = 60_000;
let lastNonceCleanupAt = 0;
const gatewayAssertion = async (req, res, next) => {
  const userId = req.headers['x-user-id'];
  const nonce = req.headers['x-gateway-nonce'];
  const verified = verifyGatewayAssertion({
    secrets: [config.GATEWAY_ASSERTION_SECRET, config.GATEWAY_ASSERTION_SECRET_PREVIOUS],
    method: req.method, path: req.baseUrl + req.url,
    userId: userId ? String(userId) : null, body: req.body,
    timestamp: req.headers['x-gateway-timestamp'], nonce, signature: req.headers['x-gateway-signature'],
  });
  if (!verified) return next(new UnauthorizedError('A valid, fresh API Gateway assertion is required'));
  const now = Date.now();
  if (now - lastNonceCleanupAt >= NONCE_RETENTION_MS) {
    lastNonceCleanupAt = now;
    prisma.gatewayRequestNonce.deleteMany({ where: { createdAt: { lt: new Date(now - NONCE_RETENTION_MS) } } }).catch((error) => {
      logger.warn('Could not prune expired gateway request nonces', { message: error.message });
    });
  }
  try {
    await prisma.gatewayRequestNonce.create({ data: { nonce } });
  } catch (error) {
    if (error.code === 'P2002') return next(new UnauthorizedError('Gateway assertion has already been used'));
    logger.error('Could not persist gateway assertion nonce', { message: error.message });
    return next(new ServiceUnavailableError('Gateway assertion verification is temporarily unavailable'));
  }
  if (userId) req.user = { id: String(userId) };
  return next();
};
module.exports = { gatewayAssertion };
