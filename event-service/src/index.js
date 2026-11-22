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
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

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

app.use('/organizers', organizerRoutes);
app.use('/venues', venueRoutes);
app.get('/catalog', eventController.listPublicEvents);
app.get('/catalog/:slug', eventController.getPublicEvent);
app.use('/events', eventRoutes);
app.use('/occurrences', occurrenceRoutes);
app.use('/ticket-types', ticketTypeRoutes);

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