const config = {
  PORT: Number(process.env.PORT) || 4003,
  SERVICE_NAME: 'event-service',
  NODE_ENV: process.env.NODE_ENV || 'development',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  DATABASE_URL: process.env.DATABASE_URL,
  GATEWAY_ASSERTION_SECRET: process.env.GATEWAY_ASSERTION_SECRET,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '',
  KAFKA_BROKER: process.env.KAFKA_BROKER || 'localhost:9093',
  KAFKA_CLIENT_ID: process.env.KAFKA_CLIENT_ID || 'event-service',
  OUTBOX_POLL_INTERVAL_MS: Number(process.env.OUTBOX_POLL_INTERVAL_MS || 1000),
  OUTBOX_BATCH_SIZE: Number(process.env.OUTBOX_BATCH_SIZE || 50),
  OUTBOX_LOCK_TIMEOUT_MS: Number(process.env.OUTBOX_LOCK_TIMEOUT_MS || 60000),
};

if (!config.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}
if (typeof config.GATEWAY_ASSERTION_SECRET !== 'string' || config.GATEWAY_ASSERTION_SECRET.length < 32) {
  throw new Error('GATEWAY_ASSERTION_SECRET must contain at least 32 characters');
}

module.exports = { config };
