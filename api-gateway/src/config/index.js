const { readSecret } = require('../../../shared/utils/readSecret');

const config = {
     PORT: process.env.PORT || 4000,
     SERVICE_NAME: 'api-gateway',
     NODE_ENV: process.env.NODE_ENV || 'development',

     REDIS_URL: readSecret('REDIS_URL'),
     ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:3000',

     JWT_ACCESS_SECRET: readSecret('JWT_ACCESS_SECRET'),
     JWT_REFRESH_SECRET: readSecret('JWT_REFRESH_SECRET'),
     GATEWAY_ASSERTION_SECRET: readSecret('GATEWAY_ASSERTION_SECRET'),
     GATEWAY_ASSERTION_SECRET_PREVIOUS: readSecret('GATEWAY_ASSERTION_SECRET_PREVIOUS'),
     EVENT_SERVICE_TLS_CA_FILE: process.env.EVENT_SERVICE_TLS_CA_FILE || '',
     EVENT_SERVICE_TLS_CLIENT_CERT_FILE: process.env.EVENT_SERVICE_TLS_CLIENT_CERT_FILE || '',
     EVENT_SERVICE_TLS_CLIENT_KEY_FILE: process.env.EVENT_SERVICE_TLS_CLIENT_KEY_FILE || '',
     ACCESS_TOKEN_EXP: process.env.ACCESS_TOKEN_EXP,
     REFRESH_TOKEN_EXP: process.env.REFRESH_TOKEN_EXP,
     ACCESS_TOKEN_EXP_SEC: parseInt(process.env.ACCESS_TOKEN_EXP_SEC || '900', 10),
     REFRESH_TOKEN_EXP_SEC: parseInt(process.env.REFRESH_TOKEN_EXP_SEC || '604800', 10),

     RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
     RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),

     SERVICES: {
          USER_SERVICE_URL: process.env.USER_SERVICE_URL || 'http://localhost:4001',
          SEARCH_SERVICE_URL: process.env.SEARCH_SERVICE_URL || 'http://localhost:4002',
          EVENT_SERVICE_URL: process.env.EVENT_SERVICE_URL || 'http://localhost:4003',
          NOTIFICATION_SERVICE_URL: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:4004',
          BOOKING_SERVICE_URL: process.env.BOOKING_SERVICE_URL || 'http://localhost:4005',
          PAYMENT_SERVICE_URL: process.env.PAYMENT_SERVICE_URL || 'http://localhost:4006',
          INVENTORY_SERVICE_URL: process.env.INVENTORY_SERVICE_URL || 'http://localhost:4007'
     },

     SERVICE_TIMEOUT_MS: parseInt(process.env.SERVICE_TIMEOUT_MS || '60000', 10),

     CIRCUIT_BREAKER_THRESHOLD: parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '5', 10),
     CIRCUIT_BREAKER_TIMEOUT: parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT || '60000', 10),
};

const requiredConfig = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'GATEWAY_ASSERTION_SECRET'];

requiredConfig.forEach((key) => {
     if (!config[key]) {
          throw new Error(`Missing required environment variable: ${key}`);
     }
});

if (config.GATEWAY_ASSERTION_SECRET.length < 32) {
     throw new Error('GATEWAY_ASSERTION_SECRET must contain at least 32 characters');
}

if (config.NODE_ENV === 'production') {
     const eventServiceUrl = new URL(config.SERVICES.EVENT_SERVICE_URL);
     const userServiceUrl = new URL(config.SERVICES.USER_SERVICE_URL);
     if (eventServiceUrl.protocol !== 'https:') throw new Error('EVENT_SERVICE_URL must use HTTPS in production');
     if (userServiceUrl.protocol !== 'https:') throw new Error('USER_SERVICE_URL must use HTTPS in production');
     if (!config.EVENT_SERVICE_TLS_CA_FILE || !config.EVENT_SERVICE_TLS_CLIENT_CERT_FILE || !config.EVENT_SERVICE_TLS_CLIENT_KEY_FILE) {
          throw new Error('Gateway-to-Event-Service mTLS CA, client certificate and private key files are required in production');
     }
}

module.exports = { config };
