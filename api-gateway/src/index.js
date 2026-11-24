require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const { config } = require('./config');
const logger = require('./config/logger');
const errorHandler = require('./middlewares/error.middleware');
const { notFound } = require('./middlewares/notFound.middleware');
const { reqLogger } = require('./middlewares/req.middleware');
const { corsMiddleware } = require('./middlewares/cors.middleware');
const routes = require('./routes');
const { RedisClient } = require('./config/redis');
const { endpointRateLimit } = require('./middlewares/rateLimiting.middleware');
const { ensureCsrfSession, generateCsrfToken, doubleCsrfProtection } = require('./middlewares/csrf.middleware');

const app = express();
app.use(corsMiddleware);
app.use(helmet({ crossOriginOpenerPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(reqLogger);

// Keep the Razorpay webhook body raw so Payment Service can verify the exact signature bytes.
app.use((req, res, next) => {
  if (req.path === '/api/payments/webhooks/razorpay') {
    return express.raw({ type: 'application/json', limit: '10mb' })(req, res, next);
  }
  return express.json({ limit: '10mb' })(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: '10mb', parameterLimit: 100 }));
app.use(cookieParser());
if (config.NODE_ENV === 'development') app.use(morgan('dev'));

// Browser clients bootstrap a signed CSRF token, then echo it in X-CSRF-Token
// for every state-changing request that relies on cookies.
app.use('/api', ensureCsrfSession);
app.get('/api/csrf', endpointRateLimit(60, 60000), (req, res) => {
  const csrfToken = generateCsrfToken(req, res, { overwrite: Boolean(req.csrfSessionCreated) });
  res.status(200).json({ success: true, csrfToken });
});
app.use('/api', doubleCsrfProtection);

app.get('/health', (req, res) => res.status(200).json({
  success: true,
  message: 'API Gateway is running',
  timestamp: new Date().toISOString(),
  environment: config.NODE_ENV,
}));
app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);

const startServer = (port = config.PORT) => {
  const server = app.listen(port, () => {
    logger.info(`API Gateway running on port ${server.address().port} in ${config.NODE_ENV} mode`);
  });
  if (require.main === module) {
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('Received ' + signal + ', closing API Gateway');
      server.close(async () => {
        await RedisClient.closeConnection();
        process.exit(0);
      });
      const forceExit = setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 30000);
      if (forceExit.unref) forceExit.unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (error) => {
      logger.error('Unhandled rejection in API Gateway', { message: error.message });
      shutdown('unhandledRejection');
    });
  }
  return server;
};

if (require.main === module) startServer();
module.exports = { app, startServer };
