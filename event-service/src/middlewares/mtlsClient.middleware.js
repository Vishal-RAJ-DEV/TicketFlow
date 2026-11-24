const { config } = require('../config');
const { UnauthorizedError } = require('../utils/error');

const requireMtlsClient = (req, res, next) => {
  if (!config.TLS_ENABLED) return next();
  const socket = req.socket;
  const certificate = socket.getPeerCertificate?.();
  const allowedCommonNames = Array.isArray(config.MTLS_CLIENT_CNS) && config.MTLS_CLIENT_CNS.length
    ? config.MTLS_CLIENT_CNS
    : [config.MTLS_CLIENT_CN];
  if (!socket.authorized || !certificate?.subject || !allowedCommonNames.includes(certificate.subject.CN)) {
    return next(new UnauthorizedError('A trusted API Gateway client certificate is required'));
  }
  return next();
};

module.exports = { requireMtlsClient };
