const { randomUUID } = require('crypto');
const { KAFKA_TOPICS } = require('../../../shared/constants/kafka-topics');

const EVENT_CATALOG_TOPICS = new Set([
  KAFKA_TOPICS.EVENT_PUBLISHED,
  KAFKA_TOPICS.EVENT_UPDATED,
  KAFKA_TOPICS.EVENT_CANCELLED,
  KAFKA_TOPICS.EVENT_OCCURRENCE_PUBLISHED,
  KAFKA_TOPICS.EVENT_OCCURRENCE_CANCELLED,
  KAFKA_TOPICS.EVENT_OCCURRENCE_SALES_OPENED,
  KAFKA_TOPICS.EVENT_OCCURRENCE_SALES_CLOSED,
  KAFKA_TOPICS.EVENT_OCCURRENCE_COMPLETED,
  KAFKA_TOPICS.VENUE_LAYOUT_VERSION_PUBLISHED,
]);

const createOutboxEvent = async (tx, {
  aggregateType,
  aggregateId,
  aggregateVersion,
  eventType,
  data,
}) => {
  if (!EVENT_CATALOG_TOPICS.has(eventType)) {
    throw new Error('Unsupported Event Service outbox topic: ' + eventType);
  }

  const eventId = randomUUID();
  const payload = {
    eventId,
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'event-service',
    aggregate: {
      type: aggregateType,
      id: aggregateId,
      version: aggregateVersion,
    },
    data,
  };

  await tx.outboxEvent.create({
    data: {
      id: eventId,
      aggregateType,
      aggregateId,
      aggregateVersion,
      eventType,
      eventVersion: 1,
      payload,
    },
  });

  return eventId;
};

module.exports = { createOutboxEvent };