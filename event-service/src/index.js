require('dotenv').config();
const express = require('express');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const logger = require('./config/logger');
const { config } = require('./config');
const asyncHandler = require('./utils/asyncHandler');
const { corsMiddleware } = require('./middlewares/cors.middleware');
const { reqLogger } = require('./middlewares/req.middleware');
const errorHandler = require('./middlewares/error.middleware');
const notFound = require('./middlewares/notFound.middleware');
const { gatewayAssertion } = require('./middlewares/gatewayAssertion.middleware');
const { requireMtlsClient } = require('./middlewares/mtlsClient.middleware');
const { BadRequestError } = require('./utils/error');
const organizerRoutes = require('./routes/organizer.route');
const venueRoutes = require('./routes/venue.route');
const eventRoutes = require('./routes/event.route');
const eventController = require('./controllers/event.controller');
const occurrenceRoutes = require('./routes/occurrence.route');
const ticketTypeRoutes = require('./routes/ticketType.route');
const { disconnectProducer } = require('./config/kafka');
const { startOutboxPublisher, stopOutboxPublisher } = require('./kafka/outbox.publisher');
const { startOccurrenceLifecycleWorker, stopOccurrenceLifecycleWorker } = require('./kafka/occurrenceLifecycle.worker');
const opsRoutes = require('./routes/ops.route');
const prisma = require('./config/prisma');

const ipRateLimitKey = (req) => 'ip:' + ipKeyGenerator(req.ip || req.socket?.remoteAddress || '127.0.0.1');
const limitResponse = (_req, res) => res.status(429).json({
  success: false,
  message: 'Too many requests. Please retry after the rate-limit window.',
});

// The Gateway already enforces Redis-backed client quotas. This service-side
// limiter adds a coarse cap before HMAC verification to protect nonce persistence.
const requestRateLimit = rateLimit({
  windowMs: config.EDGE_RATE_LIMIT_WINDOW_MS,
  limit: config.EDGE_RATE_LIMIT_MAX_REQUESTS,
  keyGenerator: ipRateLimitKey,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: limitResponse,
});

// Once the signed Gateway assertion has populated req.user, enforce a per-user
// quota rather than grouping all callers behind the Gateway's internal IP.
const authenticatedApiRateLimit = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  limit: config.RATE_LIMIT_MAX_REQUESTS,
  keyGenerator: (req) => req.user?.id ? 'user:' + String(req.user.id) : ipRateLimitKey(req),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: limitResponse,
});

const operationsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: config.OPS_RATE_LIMIT_MAX_REQUESTS,
  keyGenerator: ipRateLimitKey,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: limitResponse,
});

const healthRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  keyGenerator: ipRateLimitKey,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: limitResponse,
});

const app = express();
app.use(corsMiddleware);
app.use(helmet({ crossOriginOpenerPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(reqLogger);
app.use(requireMtlsClient);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb', parameterLimit: 100 }));
app.use(cookieParser());
app.use((req, res, next) => {
  req.body = req.body === undefined ? {} : req.body;
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Buffer.isBuffer(req.body)) {
    return next(new BadRequestError('Request body must be a JSON object'));
  }
  return next();
});
// Apply a coarse request cap before HMAC verification so malformed traffic cannot
// turn the nonce table into an unbounded write path. Apply per-user limits after
// verified identity is populated by gatewayAssertion.
app.use('/catalog', requestRateLimit, gatewayAssertion);
app.use('/organizers', requestRateLimit, gatewayAssertion, authenticatedApiRateLimit, organizerRoutes);
app.use('/venues', requestRateLimit, gatewayAssertion, authenticatedApiRateLimit, venueRoutes);
app.use('/events', requestRateLimit, gatewayAssertion, authenticatedApiRateLimit, eventRoutes);
app.use('/occurrences', requestRateLimit, gatewayAssertion, authenticatedApiRateLimit, occurrenceRoutes);
app.use('/ticket-types', requestRateLimit, gatewayAssertion, authenticatedApiRateLimit, ticketTypeRoutes);
app.get('/catalog', eventController.listPublicEvents);
app.get('/catalog/:slug', eventController.getPublicEvent);
// Operational endpoints are private, mTLS-gated and rate-limited before token checks.
app.use('/internal', operationsRateLimit, opsRoutes);
app.use(notFound);
app.use(errorHandler);

// Health probes are served only inside the Event Service container. The public
// service listener never weakens TLS client-certificate verification for probes.
const healthApp = express();
healthApp.disable('x-powered-by');
healthApp.use(healthRateLimit);
healthApp.get('/', (req, res) => res.status(200).json({ success: true, service: config.SERVICE_NAME }));
healthApp.get('/health', (req, res) => res.status(200).json({
  success: true, service: config.SERVICE_NAME, status: 'healthy', timestamp: new Date().toISOString(),
}));
healthApp.get('/ready', asyncHandler(async (req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.status(200).json({ success: true, service: config.SERVICE_NAME, status: 'ready', dependencies: { database: 'available' }, timestamp: new Date().toISOString() });
}));

const startServer = () => {
  const server = config.TLS_ENABLED
    ? https.createServer({
        key: fs.readFileSync(config.TLS_KEY_FILE),
        cert: fs.readFileSync(config.TLS_CERT_FILE),
        ca: fs.readFileSync(config.MTLS_CA_FILE),
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      }, app)
    : http.createServer(app);
  const healthServer = http.createServer(healthApp);
  healthServer.listen(config.HEALTH_PORT, '127.0.0.1', () => {
    logger.info('Event Service loopback health listener is running on port ' + config.HEALTH_PORT);
  });

  server.listen(config.PORT, () => {
    logger.info(config.SERVICE_NAME + ' is running on port ' + config.PORT + (config.TLS_ENABLED ? ' with verified mTLS' : ''));
    startOutboxPublisher();
    startOccurrenceLifecycleWorker();
  });
  server.healthServer = healthServer;

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Received ' + signal + ', shutting down Event Service');
    stopOutboxPublisher();
    stopOccurrenceLifecycleWorker();
    server.close((serverError) => {
      healthServer.close(async (healthError) => {
        try {
          if (serverError) throw serverError;
          if (healthError) throw healthError;
          await disconnectProducer();
          await prisma.$disconnect();
          logger.info('Event Service shut down cleanly');
          process.exit(0);
        } catch (error) {
          logger.error('Error during shutdown: ' + error.message);
          process.exit(1);
        }
      });
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
};
if (require.main === module) startServer();
module.exports = {
  app,
  healthApp,
  startServer,
  requestRateLimit,
  authenticatedApiRateLimit,
  operationsRateLimit,
};
