const { readSecret } = require('../../../shared/utils/readSecret');

const config = {
  SERVICE_NAME: require('../../package.json').name,
  PORT: Number(process.env.PORT) || 4001,
  NODE_ENV: process.env.NODE_ENV || "development",
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  KAFKA_BROKER: process.env.KAFKA_BROKER,
  KAFKA_CLIENT_ID: process.env.KAFKA_CLIENT_ID,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,

  OTP_TTL: process.env.OTP_TTL || 300,
  OTP_RATE_MAX_PER_HOUR: process.env.OTP_RATE_MAX_PER_HOUR || 5,
  OTP_MAX_VERIFY_ATTEMPTS: process.env.OTP_MAX_VERIFY_ATTEMPTS || 5,
  OTP_HMAC_SECRET: readSecret('OTP_HMAC_SECRET', process.env.NODE_ENV === 'production' ? '' : 'dev-only-change-this-otp-secret-before-deployment'),

  JWT_ACCESS_SECRET: readSecret('JWT_ACCESS_SECRET', process.env.NODE_ENV === 'production' ? '' : 'dev-only-change-this-access-secret-before-deployment'),
  JWT_REFRESH_SECRET: readSecret('JWT_REFRESH_SECRET', process.env.NODE_ENV === 'production' ? '' : 'dev-only-change-this-refresh-secret-before-deployment'),
  ACCESS_TOKEN_EXP: process.env.ACCESS_TOKEN_EXP || "15m",
  REFRESH_TOKEN_EXP: process.env.REFRESH_TOKEN_EXP || "7d",
  ACCESS_TOKEN_EXP_SEC: Number(process.env.ACCESS_TOKEN_EXP_SEC || 900),
  REFRESH_TOKEN_EXP_SEC: Number(process.env.REFRESH_TOKEN_EXP_SEC || 604800),
  REDIS_USER_TTL: Number(process.env.REDIS_USER_TTL || 86400),


  MAIL_SEND: process.env.MAIL_SEND,
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,

  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,

  INTERNAL_SERVICE_KEY: readSecret('INTERNAL_SERVICE_KEY'),
  INTERNAL_SERVICE_KEY_PREVIOUS: readSecret('INTERNAL_SERVICE_KEY_PREVIOUS'),
}


if (config.NODE_ENV === 'production' && (!config.JWT_ACCESS_SECRET || config.JWT_ACCESS_SECRET.length < 32 || !config.JWT_REFRESH_SECRET || config.JWT_REFRESH_SECRET.length < 32 || !config.OTP_HMAC_SECRET || config.OTP_HMAC_SECRET.length < 32)) {
  throw new Error('JWT and OTP secrets must contain at least 32 characters in production');
}
if (config.NODE_ENV === 'production' && (!config.INTERNAL_SERVICE_KEY || config.INTERNAL_SERVICE_KEY.length < 32)) {
  throw new Error('INTERNAL_SERVICE_KEY must contain at least 32 characters in production');
}

if (!config.GOOGLE_CLIENT_ID) {
  throw new Error("GOOGLE_CLIENT_ID environment variable is required");
}

if (!config.SENDGRID_API_KEY) {
  throw new Error('SENDGRID_API_KEY missing');
}

if (!config.MAIL_SEND) {
  throw new Error('MAIL_SEND missing');
}
module.exports = { config };