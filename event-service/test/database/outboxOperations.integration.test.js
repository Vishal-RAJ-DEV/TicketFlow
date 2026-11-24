'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);

test('dead-letter operations list and requeue a real PostgreSQL outbox record', { skip: !enabled }, async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const prisma = require('../../src/config/prisma');
  const eventId = randomUUID();
  const aggregateId = randomUUID();
  const now = new Date();

  try {
    await client.query(
      'INSERT INTO outbox_events (id, "aggregateType", "aggregateId", "aggregateVersion", "eventType", "payload", attempts, "nextAttemptAt", "lockedAt", "lockedBy", "lastError", "deadLetteredAt") VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)',
      [eventId, 'EVENT', aggregateId, 1, 'event.published', JSON.stringify({ data: { id: aggregateId } }), 12, new Date(now.getTime() + 60_000), now, 'dead-letter-worker', 'Kafka unavailable', now]
    );

    const operations = require('../../src/services/outboxOperations.service');
    const stats = await operations.getOutboxStats();
    assert.ok(Number.isFinite(stats.dead_lettered));
    assert.ok(stats.dead_lettered >= 1);

    const deadLetters = await operations.listDeadLetters(200);
    const row = deadLetters.find((item) => item.id === eventId);
    assert.ok(row, 'the inserted dead-letter event must be visible to operators');
    assert.equal(row.attempts, 12);
    assert.equal(row.lastError, 'Kafka unavailable');

    const result = await operations.retryDeadLetter(eventId);
    assert.deepEqual(result, { id: eventId, requeued: true });

    const stored = await client.query(
      'SELECT attempts, "nextAttemptAt", "lockedAt", "lockedBy", "lastError", "deadLetteredAt", "publishedAt" FROM outbox_events WHERE id = $1',
      [eventId]
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].attempts, 0);
    assert.equal(stored.rows[0].lockedAt, null);
    assert.equal(stored.rows[0].lockedBy, null);
    assert.equal(stored.rows[0].lastError, null);
    assert.equal(stored.rows[0].deadLetteredAt, null);
    assert.equal(stored.rows[0].publishedAt, null);
    assert.ok(stored.rows[0].nextAttemptAt.getTime() <= Date.now() + 5000);

    await assert.rejects(operations.retryDeadLetter(eventId), /Only an unpublished dead-lettered event can be retried/);
  } finally {
    await client.query('DELETE FROM outbox_events WHERE id = $1', [eventId]).catch(() => {});
    await client.end();
    await prisma.$disconnect().catch(() => {});
  }
});
