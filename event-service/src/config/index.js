const { readSecret } = require('../../../shared/utils/readSecret');

const config = {
  PORT: Number(process.env.PORT) || 4003,
  SERVICE_NAME: 'event-service',
  NODE_ENV: process.env.NODE_ENV || 'development',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  DATABASE_URL: readSecret('DATABASE_URL'),
  GATEWAY_ASSERTION_SECRET: readSecret('GATEWAY_ASSERTION_SECRET'),
  GATEWAY_ASSERTION_SECRET_PREVIOUS: readSecret('GATEWAY_ASSERTION_SECRET_PREVIOUS'),
  USER_SERVICE_URL: process.env.USER_SERVICE_URL || 'http://localhost:4001',
  USER_SERVICE_INTERNAL_KEY: readSecret('USER_SERVICE_INTERNAL_KEY'),
  USER_SERVICE_TIMEOUT_MS: Number(process.env.USER_SERVICE_TIMEOUT_MS || 3000),
  USER_STATUS_CACHE_TTL_MS: Number(process.env.USER_STATUS_CACHE_TTL_MS || 15000),
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '',
  KAFKA_BROKER: process.env.KAFKA_BROKER || 'localhost:9093',
  KAFKA_CLIENT_ID: process.env.KAFKA_CLIENT_ID || 'event-service',
  KAFKA_SSL: String(process.env.KAFKA_SSL || 'false').toLowerCase() === 'true',
  KAFKA_SASL_MECHANISM: process.env.KAFKA_SASL_MECHANISM || '',
  KAFKA_SASL_USERNAME: process.env.KAFKA_SASL_USERNAME || '',
  KAFKA_SASL_PASSWORD: readSecret('KAFKA_SASL_PASSWORD'),
  KAFKA_CA_FILE: process.env.KAFKA_CA_FILE || '',
  KAFKA_CERT_FILE: process.env.KAFKA_CERT_FILE || '',
  KAFKA_KEY_FILE: process.env.KAFKA_KEY_FILE || '',
  KAFKA_ALLOW_AUTO_TOPIC_CREATION: String(process.env.KAFKA_ALLOW_AUTO_TOPIC_CREATION || 'true').toLowerCase() === 'true',
  OUTBOX_POLL_INTERVAL_MS: Number(process.env.OUTBOX_POLL_INTERVAL_MS || 1000),
  OUTBOX_BATCH_SIZE: Number(process.env.OUTBOX_BATCH_SIZE || 50),
  OUTBOX_LOCK_TIMEOUT_MS: Number(process.env.OUTBOX_LOCK_TIMEOUT_MS || 60000),
  OUTBOX_MAX_ATTEMPTS: Number(process.env.OUTBOX_MAX_ATTEMPTS || 12),
  OCCURRENCE_LIFECYCLE_POLL_INTERVAL_MS: Number(process.env.OCCURRENCE_LIFECYCLE_POLL_INTERVAL_MS || 15000),
  OCCURRENCE_LIFECYCLE_BATCH_SIZE: Number(process.env.OCCURRENCE_LIFECYCLE_BATCH_SIZE || 100),
  OPS_TOKEN: readSecret('EVENT_SERVICE_OPS_TOKEN'),
  METRICS_TOKEN: readSecret('EVENT_SERVICE_METRICS_TOKEN'),
  TLS_ENABLED: String(process.env.EVENT_SERVICE_TLS_ENABLED || 'false').toLowerCase() === 'true',
  TLS_CERT_FILE: process.env.EVENT_SERVICE_TLS_CERT_FILE || '',
  TLS_KEY_FILE: process.env.EVENT_SERVICE_TLS_KEY_FILE || '',
  MTLS_CA_FILE: process.env.EVENT_SERVICE_MTLS_CA_FILE || '',
  MTLS_CLIENT_CN: process.env.EVENT_SERVICE_MTLS_CLIENT_CN || 'ticketflow-api-gateway',
  MTLS_CLIENT_CNS: String(process.env.EVENT_SERVICE_MTLS_CLIENT_CNS || process.env.EVENT_SERVICE_MTLS_CLIENT_CN || 'ticketflow-api-gateway').split(',').map((value) => value.trim()).filter(Boolean),
};
if (!config.DATABASE_URL) throw new Error('DATABASE_URL environment variable is required');
if (typeof config.GATEWAY_ASSERTION_SECRET !== 'string' || config.GATEWAY_ASSERTION_SECRET.length < 32) throw new Error('GATEWAY_ASSERTION_SECRET must contain at least 32 characters');
if (config.NODE_ENV === 'production' && (!config.USER_SERVICE_INTERNAL_KEY || config.USER_SERVICE_INTERNAL_KEY.length < 32)) throw new Error('USER_SERVICE_INTERNAL_KEY must be configured in production');
if (config.USER_SERVICE_INTERNAL_KEY && config.USER_SERVICE_INTERNAL_KEY.length < 32) throw new Error('USER_SERVICE_INTERNAL_KEY must contain at least 32 characters');
if (config.TLS_ENABLED && (!config.TLS_CERT_FILE || !config.TLS_KEY_FILE || !config.MTLS_CA_FILE)) throw new Error('Event Service TLS requires certificate, private key and mTLS CA files');
if (config.NODE_ENV === 'production' && !config.TLS_ENABLED) throw new Error('EVENT_SERVICE_TLS_ENABLED must be true in production');
if (config.NODE_ENV === 'production' && config.KAFKA_ALLOW_AUTO_TOPIC_CREATION) throw new Error('KAFKA_ALLOW_AUTO_TOPIC_CREATION must be false in production');
if (config.KAFKA_SASL_USERNAME || config.KAFKA_SASL_PASSWORD) {
  if (!config.KAFKA_SASL_USERNAME || !config.KAFKA_SASL_PASSWORD || !['plain', 'scram-sha-256', 'scram-sha-512'].includes(config.KAFKA_SASL_MECHANISM)) throw new Error('Kafka SASL requires username, password and a supported mechanism');
}
if (config.NODE_ENV === 'production' && (!config.KAFKA_SSL || !config.KAFKA_SASL_USERNAME || !config.KAFKA_SASL_PASSWORD)) throw new Error('Production Kafka requires TLS and SASL credentials');
if (config.NODE_ENV === 'production' && (!config.OPS_TOKEN || config.OPS_TOKEN.length < 32 || !config.METRICS_TOKEN || config.METRICS_TOKEN.length < 32)) throw new Error('Event Service ops and metrics tokens must contain at least 32 characters in production');
if (config.NODE_ENV === 'production') {
  let userServiceUrl;
  try { userServiceUrl = new URL(config.USER_SERVICE_URL); } catch { throw new Error('USER_SERVICE_URL must be a valid absolute URL'); }
  if (userServiceUrl.protocol !== 'https:' || userServiceUrl.username || userServiceUrl.password) throw new Error('USER_SERVICE_URL must use HTTPS without embedded credentials in production');
  if (!config.MTLS_CLIENT_CNS.length) throw new Error('At least one trusted Event Service mTLS client certificate CN is required in production');
  if (!config.KAFKA_CA_FILE) throw new Error('KAFKA_CA_FILE must be configured for authenticated production Kafka TLS');
}

module.exports = { config };
