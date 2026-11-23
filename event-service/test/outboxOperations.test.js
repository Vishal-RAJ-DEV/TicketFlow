const test = require('node:test');
const assert = require('node:assert/strict');
const { getOutboxStats, listDeadLetters, retryDeadLetter } = require('../src/services/outboxOperations.service');
const { NotFoundError, ConflictError } = require('../src/utils/error');

test('converts PostgreSQL aggregate stats into numeric metrics', async () => {
  const client = {
    $queryRaw: async () => [{
      pending: 4n,
      dead_lettered: 2n,
      published: 9n,
      oldest_pending_seconds: 72.5,
      publish_attempts: 18n,
    }],
  };
  assert.deepEqual(await getOutboxStats(client), {
    pending: 4,
    dead_lettered: 2,
    published: 9,
    oldest_pending_seconds: 72.5,
    publish_attempts: 18,
  });
});

test('bounds dead-letter listing and returns operator-safe fields', async () => {
  let query;
  const client = {
    outboxEvent: {
      findMany: async (args) => { query = args; return [{ id: 'event-1', lastError: 'Kafka unavailable' }]; },
    },
  };
  const rows = await listDeadLetters(10000, client);
  assert.equal(query.take, 200);
  assert.deepEqual(query.where, { publishedAt: null, deadLetteredAt: { not: null } });
  assert.equal(rows[0].id, 'event-1');
});

test('requeues a dead-lettered event and clears stale lock/error state', async () => {
  let update;
  const client = {
    outboxEvent: {
      updateMany: async (args) => { update = args; return { count: 1 }; },
    },
  };
  const result = await retryDeadLetter('event-1', client);
  assert.deepEqual(result, { id: 'event-1', requeued: true });
  assert.deepEqual(update.where, { id: 'event-1', publishedAt: null, deadLetteredAt: { not: null } });
  assert.equal(update.data.attempts, 0);
  assert.equal(update.data.deadLetteredAt, null);
  assert.equal(update.data.lockedAt, null);
  assert.equal(update.data.lockedBy, null);
  assert.equal(update.data.lastError, null);
});

test('distinguishes missing events from events that are not dead-lettered', async () => {
  const missingClient = {
    outboxEvent: { updateMany: async () => ({ count: 0 }), findUnique: async () => null },
  };
  const publishedClient = {
    outboxEvent: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => ({ publishedAt: new Date(), deadLetteredAt: null }),
    },
  };
  await assert.rejects(retryDeadLetter('missing', missingClient), NotFoundError);
  await assert.rejects(retryDeadLetter('published', publishedClient), ConflictError);
});
