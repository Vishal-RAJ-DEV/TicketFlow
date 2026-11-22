const crypto = require('node:crypto');

const MAX_CLOCK_SKEW_MS = 30_000;
const NONCE_PATTERN = /^[a-f0-9]{32}$/i;

const requestBodyDigest = (body) => {
  const normalizedBody = body === undefined || (body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0)
    ? null
    : body;
  return crypto.createHash('sha256').update(JSON.stringify(normalizedBody)).digest('hex');
};

const normalizeRequestPath = (path) => {
  const value = String(path || '/');
  const queryIndex = value.indexOf('?');
  let pathname = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : value.slice(queryIndex);
  while (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  return pathname + query;
};

const buildSigningPayload = ({ timestamp, nonce, method, path, userId, bodyDigest }) => [
  String(timestamp),
  String(nonce),
  String(method).toUpperCase(),
  normalizeRequestPath(path),
  userId ? String(userId) : '',
  String(bodyDigest),
].join('\n');

const signGatewayAssertion = ({ secret, method, path, userId, body }) => {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('GATEWAY_ASSERTION_SECRET must contain at least 32 characters');
  }
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyDigest = requestBodyDigest(body);
  const payload = buildSigningPayload({ timestamp, nonce, method, path, userId, bodyDigest });
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { timestamp, nonce, signature, bodyDigest };
};

const verifyGatewayAssertion = ({
  secret,
  method,
  path,
  userId,
  body,
  timestamp,
  nonce,
  signature,
  now = Date.now(),
  maxClockSkewMs = MAX_CLOCK_SKEW_MS,
}) => {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  if (typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp)) return false;
  const issuedAt = Number(timestamp);
  if (!Number.isSafeInteger(issuedAt) || Math.abs(now - issuedAt) > maxClockSkewMs) return false;
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return false;
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;

  const bodyDigest = requestBodyDigest(body);
  const payload = buildSigningPayload({ timestamp, nonce, method, path, userId, bodyDigest });
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  const provided = Buffer.from(signature, 'hex');
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
};

module.exports = {
  MAX_CLOCK_SKEW_MS,
  NONCE_PATTERN,
  requestBodyDigest,
  signGatewayAssertion,
  verifyGatewayAssertion,
};
