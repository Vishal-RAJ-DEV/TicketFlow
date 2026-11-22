require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const logger = require('./config/logger');
const { config } = require('./config');
const asyncHandler = require('./utils/asyncHandler');
const { corsMiddleware } = require('./middlewares/cors.middleware');
const { reqLogger } = require('./middlewares/req.middleware');
const errorHandler = require('./middlewares/error.middleware');
const notFound = require('./middlewares/notFound.middleware');
const { gatewayAssertion } = require('./middlewares/gatewayAssertion.middleware');
const { BadRequestError } = require('./utils/error');
const organizerRoutes = require('./routes/organizer.route');
const venueRoutes = require('./routes/venue.route');
const eventRoutes = require('./routes/event.route');
const eventController = require('./controllers/event.controller');
const occurrenceRoutes = require('./routes/occurrence.route');
const ticketTypeRoutes = require('./routes/ticketType.route');
const { disconnectProducer } = require('./config/kafka');
const { startOutboxPublisher, stopOutboxPublisher } = require('./kafka/outbox.publisher');
const prisma = require('./config/prisma');

const app = express();

app.use(corsMiddleware);
app.use(helmet({
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(reqLogger);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb', parameterLimit: 100 }));
app.use(cookieParser());
app.use((req, res, next) => {
  req.body = req.body === undefined ? {} : req.body;
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Buffer.isBuffer(req.body)) {
    return next(new BadRequestError('Request body must be a JSON object'));
  }
  next();
});

app.get('/', (req, res) => {
  res.status(200).json({ success: true, service: config.SERVICE_NAME });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    service: config.SERVICE_NAME,
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

app.get('/ready', asyncHandler(async (req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.status(200).json({
    success: true,
    service: config.SERVICE_NAME,
    status: 'ready',
    dependencies: { database: 'available' },
    timestamp: new Date().toISOString(),
  });
}));

// Every business/catalog endpoint must be reached through the gateway.
// Liveness/readiness remain directly accessible to container orchestration.
app.use('/catalog', gatewayAssertion);
app.use('/organizers', gatewayAssertion, organizerRoutes);
app.use('/venues', gatewayAssertion, venueRoutes);
app.use('/events', gatewayAssertion, eventRoutes);
app.use('/occurrences', gatewayAssertion, occurrenceRoutes);
app.use('/ticket-types', gatewayAssertion, ticketTypeRoutes);

app.get('/catalog', eventController.listPublicEvents);
app.get('/catalog/:slug', eventController.getPublicEvent);

app.use(notFound);
app.use(errorHandler);

const startServer = () => {
  const server = app.listen(config.PORT, () => {
    logger.info(config.SERVICE_NAME + ' is running on port ' + config.PORT);
    startOutboxPublisher();
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Received ' + signal + ', shutting down Event Service');
    stopOutboxPublisher();

    server.close(async () => {
      try {
        await disconnectProducer();
        await prisma.$disconnect();
        logger.info('Event Service shut down cleanly');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown: ' + error.message);
        process.exit(1);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
};

if (require.main === module) startServer();

module.exports = { app, startServer };
