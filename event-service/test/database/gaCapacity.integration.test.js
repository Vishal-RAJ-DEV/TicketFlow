const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);

const withFixture = async (run) => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const ids = {
    organizer: randomUUID(),
    venue: randomUUID(),
    section: randomUUID(),
    layout: randomUUID(),
    event: randomUUID(),
    occurrence: randomUUID(),
  };
  const now = new Date();
  const startsAt = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 3 * 60 * 60 * 1000);
  const salesOpenAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const salesCloseAt = new Date(startsAt.getTime() - 60 * 60 * 1000);

  try {
    await client.query(
      'INSERT INTO organizers (id, name, slug, "ownerId", "updatedAt") VALUES ($1, $2, $3, $4, $5)',
      [ids.organizer, 'Integration Test Organizer', 'it-' + ids.organizer, 'integration-test-user', now]
    );
    await client.query(
      'INSERT INTO venues (id, "organizerId", name, address, city, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6)',
      [ids.venue, ids.organizer, 'Integration Test Venue', '1 Test Road', 'Test City', now]
    );
    await client.query(
      'INSERT INTO venue_sections (id, "venueId", name, mode, capacity, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6)',
      [ids.section, ids.venue, 'Standing', 'GENERAL_ADMISSION', 1000, now]
    );

    const snapshot = {
      schemaVersion: 1,
      venueId: ids.venue,
      sections: [{ id: ids.section, name: 'Standing', mode: 'GENERAL_ADMISSION', capacity: 1000, seats: [] }],
    };
    await client.query(
      'INSERT INTO venue_layout_versions (id, "venueId", version, status, snapshot, "createdBy", "publishedAt", "updatedAt") VALUES ($1, $2, 1, $3, $4::jsonb, $5, $6, $7)',
      [ids.layout, ids.venue, 'PUBLISHED', JSON.stringify(snapshot), 'integration-test-user', now, now]
    );
    await client.query(
      'INSERT INTO events (id, "organizerId", title, slug, category, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6)',
      [ids.event, ids.organizer, 'Integration Test Event', 'it-' + ids.event, 'test', now]
    );
    await client.query(
      'INSERT INTO event_occurrences (id, "eventId", "venueId", "venueLayoutVersionId", "startsAt", "endsAt", "salesOpenAt", "salesCloseAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [ids.occurrence, ids.event, ids.venue, ids.layout, startsAt, endsAt, salesOpenAt, salesCloseAt, now]
    );

    return await run({ client, ids, salesOpenAt, salesCloseAt });
  } finally {
    try {
      await client.query('DELETE FROM ticket_types WHERE "occurrenceId" = $1', [ids.occurrence]);
      await client.query('DELETE FROM event_occurrences WHERE id = $1', [ids.occurrence]);
      await client.query('DELETE FROM events WHERE id = $1', [ids.event]);
      await client.query('DELETE FROM venue_layout_versions WHERE id = $1', [ids.layout]);
      await client.query('DELETE FROM venue_sections WHERE id = $1', [ids.section]);
      await client.query('DELETE FROM venues WHERE id = $1', [ids.venue]);
      await client.query('DELETE FROM organizers WHERE id = $1', [ids.organizer]);
    } finally {
      await client.end();
    }
  }
};

const insertTier = async (client, ids, { capacity, allocation, code = randomUUID() }) => {
  await client.query('BEGIN');
  try {
    const now = new Date();
    await client.query(
      'INSERT INTO ticket_types (id, "occurrenceId", name, code, mode, capacity, "salesStartsAt", "salesEndsAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [randomUUID(), ids.occurrence, 'Integration Tier', code, 'GENERAL_ADMISSION', capacity, now, new Date(now.getTime() + 60 * 60 * 1000), now]
    );
    const ticketType = await client.query(
      'SELECT id FROM ticket_types WHERE "occurrenceId" = $1 AND code = $2',
      [ids.occurrence, code]
    );
    await client.query(
      'INSERT INTO ticket_type_sections (id, "ticketTypeId", "venueSectionId", capacity) VALUES ($1, $2, $3, $4)',
      [randomUUID(), ticketType.rows[0].id, ids.section, allocation]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
};

test('PostgreSQL rejects aggregate GA allocations above the immutable section capacity', { skip: !enabled }, async () => {
  await withFixture(async ({ client, ids }) => {
    await insertTier(client, ids, { capacity: 700, allocation: 700 });
    await assert.rejects(
      insertTier(client, ids, { capacity: 400, allocation: 400 }),
      (error) => error.code === '23514'
    );

    const result = await client.query(
      'SELECT COALESCE(SUM(mapping.capacity), 0)::int AS total FROM ticket_type_sections AS mapping JOIN ticket_types AS ticket ON ticket.id = mapping."ticketTypeId" WHERE ticket."occurrenceId" = $1',
      [ids.occurrence]
    );
    assert.equal(result.rows[0].total, 700);
  });
});

test('PostgreSQL deferred constraint rejects ticket-type totals that differ from section allocations', { skip: !enabled }, async () => {
  await withFixture(async ({ client, ids, salesOpenAt, salesCloseAt }) => {
    await client.query('BEGIN');
    try {
      const ticketTypeId = randomUUID();
      const now = new Date();
      await client.query(
        'INSERT INTO ticket_types (id, "occurrenceId", name, code, mode, capacity, "salesStartsAt", "salesEndsAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [ticketTypeId, ids.occurrence, 'Mismatched Tier', 'MISMATCH-' + ticketTypeId, 'GENERAL_ADMISSION', 200, salesOpenAt, salesCloseAt, now]
      );
      await client.query(
        'INSERT INTO ticket_type_sections (id, "ticketTypeId", "venueSectionId", capacity) VALUES ($1, $2, $3, $4)',
        [randomUUID(), ticketTypeId, ids.section, 150]
      );
      await assert.rejects(
        client.query('SET CONSTRAINTS ALL IMMEDIATE'),
        (error) => error.code === '23514'
      );
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
});

test('concurrent GA tier creation cannot over-allocate the same section', { skip: !enabled }, async () => {
  await withFixture(async ({ client: fixtureClient, ids }) => {
    const clients = [new Client({ connectionString: process.env.DATABASE_URL }), new Client({ connectionString: process.env.DATABASE_URL })];
    await Promise.all(clients.map((connection) => connection.connect()));

    let arrivals = 0;
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const attempt = async (connection, capacity, code) => {
      await connection.query('BEGIN');
      try {
        // Synchronize before taking the occurrence lock so both insertions
        // contend for the same row without a test-side lock/barrier cycle.
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
        const now = new Date();
        await connection.query(
          'INSERT INTO ticket_types (id, "occurrenceId", name, code, mode, capacity, "salesStartsAt", "salesEndsAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [randomUUID(), ids.occurrence, 'Concurrent Tier', code, 'GENERAL_ADMISSION', capacity, now, new Date(now.getTime() + 60 * 60 * 1000), now]
        );
        const ticketType = await connection.query(
          'SELECT id FROM ticket_types WHERE "occurrenceId" = $1 AND code = $2',
          [ids.occurrence, code]
        );
        await connection.query(
          'INSERT INTO ticket_type_sections (id, "ticketTypeId", "venueSectionId", capacity) VALUES ($1, $2, $3, $4)',
          [randomUUID(), ticketType.rows[0].id, ids.section, capacity]
        );
        await connection.query('COMMIT');
        return 'committed';
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    };

    try {
      const outcomes = await Promise.allSettled([
        attempt(clients[0], 600, 'RACE-A-' + randomUUID()),
        attempt(clients[1], 500, 'RACE-B-' + randomUUID()),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      assert.equal(rejected.reason.code, '23514');

      const total = await fixtureClient.query(
        'SELECT COALESCE(SUM(mapping.capacity), 0)::int AS total FROM ticket_type_sections AS mapping JOIN ticket_types AS ticket ON ticket.id = mapping."ticketTypeId" WHERE ticket."occurrenceId" = $1',
        [ids.occurrence]
      );
      assert.ok(total.rows[0].total <= 1000);
    } finally {
      await Promise.all(clients.map((connection) => connection.end()));
    }
  });
});
