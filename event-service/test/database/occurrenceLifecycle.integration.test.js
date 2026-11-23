const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);

const withFixture = async (run) => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const userId = 'lifecycle-owner-' + randomUUID();
  const ids = { organizer: randomUUID(), venue: randomUUID(), layout: randomUUID(), event: randomUUID() };
  const now = new Date();
  const startsAt = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const endsAt = new Date(now.getTime() + 5 * 60 * 60 * 1000);
  try {
    await client.query(
      'INSERT INTO organizers (id, name, slug, "ownerId", "updatedAt") VALUES ($1, $2, $3, $4, $5)',
      [ids.organizer, 'Lifecycle Organizer', 'lifecycle-' + ids.organizer, userId, now]
    );
    await client.query(
      'INSERT INTO venues (id, "organizerId", name, address, city, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6)',
      [ids.venue, ids.organizer, 'Lifecycle Venue', '2 Test Road', 'Test City', now]
    );
    await client.query(
      'INSERT INTO venue_layout_versions (id, "venueId", version, status, snapshot, "createdBy", "publishedAt", "updatedAt") VALUES ($1, $2, 1, $3, $4::jsonb, $5, $6, $7)',
      [ids.layout, ids.venue, 'PUBLISHED', JSON.stringify({ schemaVersion: 1, venueId: ids.venue, sections: [] }), userId, now, now]
    );
    await client.query(
      'INSERT INTO events (id, "organizerId", title, slug, category, status, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [ids.event, ids.organizer, 'Lifecycle Event', 'lifecycle-' + ids.event, 'test', 'PUBLISHED', now]
    );
    return await run({ client, ids, userId, now, startsAt, endsAt });
  } finally {
    try {
      await client.query('DELETE FROM outbox_events WHERE "aggregateId" IN (SELECT id FROM event_occurrences WHERE "eventId" = $1)', [ids.event]);
      await client.query('DELETE FROM event_occurrences WHERE "eventId" = $1', [ids.event]);
      await client.query('DELETE FROM events WHERE id = $1', [ids.event]);
      await client.query('DELETE FROM venue_layout_versions WHERE id = $1', [ids.layout]);
      await client.query('DELETE FROM venues WHERE id = $1', [ids.venue]);
      await client.query('DELETE FROM organizers WHERE id = $1', [ids.organizer]);
    } finally {
      await client.end();
    }
  }
};

const insertOccurrence = async (client, ids, { status, salesOpenAt, salesCloseAt, startsAt, endsAt }) => {
  const occurrenceId = randomUUID();
  await client.query(
    'INSERT INTO event_occurrences (id, "eventId", "venueId", "venueLayoutVersionId", "startsAt", "endsAt", "salesOpenAt", "salesCloseAt", status, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [occurrenceId, ids.event, ids.venue, ids.layout, startsAt, endsAt, salesOpenAt, salesCloseAt, status, new Date()]
  );
  return occurrenceId;
};

test('scheduled occurrence advances through ON_SALE, SALES_CLOSED and COMPLETED with outbox facts', { skip: !enabled }, async () => {
  await withFixture(async ({ client, ids, now, startsAt, endsAt }) => {
    const occurrenceId = await insertOccurrence(client, ids, {
      status: 'SCHEDULED',
      salesOpenAt: new Date(now.getTime() - 60_000),
      salesCloseAt: new Date(now.getTime() + 60 * 60 * 1000),
      startsAt,
      endsAt,
    });
    const { transitionOccurrence } = require('../src/services/occurrenceLifecycle.service');
    const opened = await transitionOccurrence(occurrenceId, now);
    assert.deepEqual(opened.map((item) => item.status), ['ON_SALE']);
    const closed = await transitionOccurrence(occurrenceId, new Date(now.getTime() + 2 * 60 * 60 * 1000));
    assert.deepEqual(closed.map((item) => item.status), ['SALES_CLOSED']);
    const completed = await transitionOccurrence(occurrenceId, new Date(now.getTime() + 6 * 60 * 60 * 1000));
    assert.deepEqual(completed.map((item) => item.status), ['COMPLETED']);

    const current = await client.query('SELECT status, version FROM event_occurrences WHERE id = $1', [occurrenceId]);
    assert.equal(current.rows[0].status, 'COMPLETED');
    assert.equal(current.rows[0].version, 4);
    const outbox = await client.query(
      'SELECT "eventType" FROM outbox_events WHERE "aggregateId" = $1 ORDER BY "aggregateVersion"',
      [occurrenceId]
    );
    assert.deepEqual(outbox.rows.map((row) => row.eventType), [
      'event.occurrence-sales-opened',
      'event.occurrence-sales-closed',
      'event.occurrence-completed',
    ]);
  });
});

test('organizer can cancel an individual occurrence with a reason and transactional outbox event', { skip: !enabled }, async () => {
  await withFixture(async ({ client, ids, userId, now, startsAt, endsAt }) => {
    const occurrenceId = await insertOccurrence(client, ids, {
      status: 'SCHEDULED',
      salesOpenAt: new Date(now.getTime() + 30 * 60 * 1000),
      salesCloseAt: new Date(startsAt.getTime() - 30 * 60 * 1000),
      startsAt,
      endsAt,
    });
    const { cancelOccurrence } = require('../src/services/occurrence.service');
    const result = await cancelOccurrence(occurrenceId, userId, { reason: 'Venue unavailable' });
    assert.equal(result.status, 'CANCELLED');
    assert.ok(result.cancelledAt instanceof Date);
    assert.equal(result.cancellationReason, 'Venue unavailable');
    const outbox = await client.query('SELECT "eventType", payload FROM outbox_events WHERE "aggregateId" = $1', [occurrenceId]);
    assert.equal(outbox.rows.length, 1);
    assert.equal(outbox.rows[0].eventType, 'event.occurrence-cancelled');
    assert.equal(outbox.rows[0].payload.data.reason, 'Venue unavailable');
  });
});
