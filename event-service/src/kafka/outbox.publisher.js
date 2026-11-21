const { randomUUID } = require('crypto');
const prisma = require('../config/prisma');
const logger = require('../config/logger');
const { config } = require('../config');
const { sendEvent } = require('../config/kafka');

const workerId = 'event-service-' + process.pid + '-' + randomUUID();
let stopped = true;
let timer = null;

const claimPendingEvents = async () => prisma.$queryRawUnsafe(
  'WITH candidates AS (' +
  ' SELECT id FROM outbox_events' +
  ' WHERE "publishedAt" IS NULL AND "nextAttemptAt" <= NOW()' +
  " AND (\"lockedAt\" IS NULL OR \"lockedAt\" < NOW() - ($1 * INTERVAL '1 millisecond'))" +
  ' ORDER BY "createdAt" ASC LIMIT $2 FOR UPDATE SKIP LOCKED' +
  ')' +
  ' UPDATE outbox_events AS outbox' +
  ' SET "lockedAt" = NOW(), "lockedBy" = $3' +
  ' FROM candidates WHERE outbox.id = candidates.id' +
  ' RETURNING outbox.id, outbox."eventType", outbox."aggregateId", outbox.payload, outbox.attempts',
  config.OUTBOX_LOCK_TIMEOUT_MS,
  config.OUTBOX_BATCH_SIZE,
  workerId
);

const publishBatch = async () => {
  const events = await claimPendingEvents();
  for (const event of events) {
    try {
      await sendEvent(event.eventType, event.aggregateId, event.payload);
      await prisma.outboxEvent.updateMany({
        where: { id: event.id, lockedBy: workerId, publishedAt: null },
        data: { publishedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null },
      });
      logger.info('Published outbox event ' + event.eventType + ' (' + event.id + ')');
    } catch (error) {
      const nextAttempt = Math.min(300000, 1000 * (2 ** Math.min(event.attempts, 8)));
      await prisma.outboxEvent.updateMany({
        where: { id: event.id, lockedBy: workerId, publishedAt: null },
        data: {
          attempts: { increment: 1 },
          nextAttemptAt: new Date(Date.now() + nextAttempt),
          lockedAt: null,
          lockedBy: null,
          lastError: String(error.message || error).slice(0, 2000),
        },
      });
      logger.error('Outbox publish failed for ' + event.id + ': ' + error.message);
    }
  }
};

const scheduleNextPoll = () => {
  if (stopped) return;
  timer = setTimeout(async () => {
    try {
      await publishBatch();
    } catch (error) {
      logger.error('Outbox polling failed: ' + error.message);
    } finally {
      scheduleNextPoll();
    }
  }, config.OUTBOX_POLL_INTERVAL_MS);
  if (timer.unref) timer.unref();
};

const startOutboxPublisher = () => {
  if (!stopped) return;
  stopped = false;
  scheduleNextPoll();
  logger.info('Transactional outbox publisher started');
};

const stopOutboxPublisher = () => {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
};

module.exports = { startOutboxPublisher, stopOutboxPublisher, publishBatch };