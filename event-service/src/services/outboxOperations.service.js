const prisma = require('../config/prisma');
const { NotFoundError, ConflictError } = require('../utils/error');

const getOutboxStats = async (client = prisma) => {
  const rows = await client.$queryRaw`
    SELECT
      COUNT(*) FILTER (WHERE "publishedAt" IS NULL AND "deadLetteredAt" IS NULL)::bigint AS pending,
      COUNT(*) FILTER (WHERE "publishedAt" IS NULL AND "deadLetteredAt" IS NOT NULL)::bigint AS dead_lettered,
      COUNT(*) FILTER (WHERE "publishedAt" IS NOT NULL)::bigint AS published,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN("createdAt") FILTER (WHERE "publishedAt" IS NULL AND "deadLetteredAt" IS NULL))), 0)::double precision AS oldest_pending_seconds,
      COALESCE(SUM("attempts"), 0)::bigint AS publish_attempts
    FROM "outbox_events"
  `;
  const row = rows[0] || {};
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value || 0)]));
};

const listDeadLetters = async (limit = 100, client = prisma) => client.outboxEvent.findMany({
  where: { publishedAt: null, deadLetteredAt: { not: null } },
  select: { id: true, eventType: true, aggregateType: true, aggregateId: true, aggregateVersion: true, attempts: true, lastError: true, deadLetteredAt: true, createdAt: true },
  orderBy: [{ deadLetteredAt: 'asc' }, { id: 'asc' }],
  take: Math.min(Math.max(Number(limit) || 100, 1), 200),
});

const retryDeadLetter = async (eventId, client = prisma) => {
  const changed = await client.outboxEvent.updateMany({
    where: { id: eventId, publishedAt: null, deadLetteredAt: { not: null } },
    data: {
      attempts: 0,
      nextAttemptAt: new Date(),
      deadLetteredAt: null,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
  if (!changed.count) {
    const existing = await client.outboxEvent.findUnique({ where: { id: eventId }, select: { publishedAt: true, deadLetteredAt: true } });
    if (!existing) throw new NotFoundError('Outbox event not found');
    throw new ConflictError('Only an unpublished dead-lettered event can be retried');
  }
  return { id: eventId, requeued: true };
};

module.exports = { getOutboxStats, listDeadLetters, retryDeadLetter };
