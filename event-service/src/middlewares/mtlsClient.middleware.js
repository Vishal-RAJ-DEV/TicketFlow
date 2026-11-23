const { config } = require('../config');
const { UnauthorizedError } = require('../utils/error');

const requireMtlsClient = (req, res, next) => {
  if (!config.TLS_ENABLED || req.path === '/' || req.path === '/health' || req.path === '/ready') return next();
  const socket = req.socket;
  const certificate = socket.getPeerCertificate?.();
  if (!socket.authorized || !certificate?.subject || certificate.subject.CN !== config.MTLS_CLIENT_CN) {
    return next(new UnauthorizedError('A trusted API Gateway client certificate is required'));
  }
  return next();
};

module.exports = { requireMtlsClient };
