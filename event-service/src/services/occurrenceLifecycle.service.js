const prisma = require('../config/prisma');
const { createOutboxEvent } = require('./outbox.service');

const transitionTopic = {
  ON_SALE: 'event.occurrence-sales-opened',
  SALES_CLOSED: 'event.occurrence-sales-closed',
  COMPLETED: 'event.occurrence-completed',
};

const transitionOccurrence = async (occurrenceId, now = new Date()) => prisma.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT id FROM event_occurrences WHERE id = ${occurrenceId} FOR UPDATE`;
  let occurrence = await tx.eventOccurrence.findUnique({
    where: { id: occurrenceId },
    include: {
      event: { select: { id: true, organizerId: true, title: true, slug: true } },
      venue: { select: { id: true, name: true, city: true, timezone: true } },
    },
  });
  if (!occurrence || ['DRAFT', 'CANCELLED', 'COMPLETED'].includes(occurrence.status)) return [];

  const targets = [];
  if (occurrence.endsAt <= now) {
    if (['SCHEDULED', 'ON_SALE'].includes(occurrence.status) && occurrence.salesCloseAt <= now) targets.push('SALES_CLOSED');
    targets.push('COMPLETED');
  } else if (['SCHEDULED', 'ON_SALE'].includes(occurrence.status) && occurrence.salesCloseAt <= now) {
    targets.push('SALES_CLOSED');
  } else if (occurrence.status === 'SCHEDULED' && occurrence.salesOpenAt <= now) {
    targets.push('ON_SALE');
  }

  const transitions = [];
  for (const status of targets) {
    const previousStatus = occurrence.status;
    const changed = await tx.eventOccurrence.updateMany({
      where: { id: occurrence.id, version: occurrence.version, status: previousStatus },
      data: { status, version: { increment: 1 } },
    });
    if (!changed.count) break;
    const updated = await tx.eventOccurrence.findUnique({ where: { id: occurrence.id } });
    await createOutboxEvent(tx, {
      aggregateType: 'EVENT_OCCURRENCE',
      aggregateId: updated.id,
      aggregateVersion: updated.version,
      eventType: transitionTopic[status],
      data: {
        occurrence: {
          id: updated.id,
          eventId: updated.eventId,
          venueId: updated.venueId,
          startsAt: updated.startsAt,
          endsAt: updated.endsAt,
          salesOpenAt: updated.salesOpenAt,
          salesCloseAt: updated.salesCloseAt,
          previousStatus,
          status: updated.status,
          version: updated.version,
        },
        event: occurrence.event,
        venue: occurrence.venue,
      },
    });
    transitions.push({ previousStatus, status, version: updated.version });
    occurrence = { ...occurrence, ...updated };
  }
  return transitions;
});

const runLifecycleBatch = async (now = new Date(), batchSize = 100) => {
  const candidates = await prisma.eventOccurrence.findMany({
    where: {
      status: { in: ['SCHEDULED', 'ON_SALE', 'SALES_CLOSED'] },
      OR: [
        { salesOpenAt: { lte: now } },
        { salesCloseAt: { lte: now } },
        { endsAt: { lte: now } },
      ],
    },
    select: { id: true },
    orderBy: [{ endsAt: 'asc' }, { id: 'asc' }],
    take: batchSize,
  });

  const results = [];
  for (const candidate of candidates) {
    const transitions = await transitionOccurrence(candidate.id, now);
    if (transitions.length) results.push({ occurrenceId: candidate.id, transitions });
  }
  return results;
};

module.exports = { runLifecycleBatch, transitionOccurrence };
