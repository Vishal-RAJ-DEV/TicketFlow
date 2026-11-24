'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);

test('published ticket types can be paused and resumed with idempotent transactional outbox events', { skip: !enabled }, async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const ids = {
    organizer: randomUUID(),
    venue: randomUUID(),
    section: randomUUID(),
    layout: randomUUID(),
    event: randomUUID(),
    occurrence: randomUUID(),
    ticketType: randomUUID(),
  };
  const userId = 'ticket-type-owner-' + randomUUID();
  const now = new Date();
  const startsAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const endsAt = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const salesOpenAt = new Date(now.getTime() - 5 * 60 * 1000);
  const salesCloseAt = new Date(startsAt.getTime() - 30 * 60 * 1000);

  try {
    await client.query(
      'INSERT INTO organizers (id, name, slug, "ownerId", "updatedAt") VALUES ($1, $2, $3, $4, $5)',
      [ids.organizer, 'Ticket Type Lifecycle Organizer', 'ticket-type-' + ids.organizer, userId, now]
    );
    await client.query(
      'INSERT INTO venues (id, "organizerId", name, address, city, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6)',
      [ids.venue, ids.organizer, 'Ticket Type Lifecycle Venue', '3 Test Road', 'Test City', now]
    );
    await client.query(
      'INSERT INTO venue_sections (id, "venueId", name, mode, capacity, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6)',
      [ids.section, ids.venue, 'Standing', 'GENERAL_ADMISSION', 500, now]
    );
    const snapshot = {
      schemaVersion: 1,
      venueId: ids.venue,
      sections: [{ id: ids.section, name: 'Standing', mode: 'GENERAL_ADMISSION', capacity: 500, seats: [] }],
    };
    await client.query(
      'INSERT INTO venue_layout_versions (id, "venueId", version, status, snapshot, "createdBy", "publishedAt", "updatedAt") VALUES ($1, $2, 1, $3, $4::jsonb, $5, $6, $7)',
      [ids.layout, ids.venue, 'PUBLISHED', JSON.stringify(snapshot), userId, now, now]
    );
    await client.query(
      'INSERT INTO events (id, "organizerId", title, slug, category, status, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [ids.event, ids.organizer, 'Ticket Type Lifecycle Event', 'ticket-type-' + ids.event, 'test', 'PUBLISHED', now]
    );
    await client.query(
      'INSERT INTO event_occurrences (id, "eventId", "venueId", "venueLayoutVersionId", "startsAt", "endsAt", "salesOpenAt", "salesCloseAt", status, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [ids.occurrence, ids.event, ids.venue, ids.layout, startsAt, endsAt, salesOpenAt, salesCloseAt, 'ON_SALE', now]
    );

    await client.query('BEGIN');
    try {
      await client.query(
        'INSERT INTO ticket_types (id, "occurrenceId", name, code, mode, "priceMinorUnits", currency, capacity, "salesStartsAt", "salesEndsAt", status, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
        [ids.ticketType, ids.occurrence, 'General Admission', 'GA', 'GENERAL_ADMISSION', 25000, 'INR', 200, salesOpenAt, salesCloseAt, 'ACTIVE', now]
      );
      await client.query(
        'INSERT INTO ticket_type_sections (id, "ticketTypeId", "venueSectionId", capacity) VALUES ($1, $2, $3, $4)',
        [randomUUID(), ids.ticketType, ids.section, 200]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    const { updateTicketTypeStatus } = require('../../src/services/ticketType.service');

    const paused = await updateTicketTypeStatus(ids.ticketType, userId, 'PAUSED');
    assert.equal(paused.status, 'PAUSED');
    assert.equal(paused.version, 2);

    const duplicatePause = await updateTicketTypeStatus(ids.ticketType, userId, 'PAUSED');
    assert.equal(duplicatePause.status, 'PAUSED');
    assert.equal(duplicatePause.version, 2);

    let outbox = await client.query(
      'SELECT "eventType", "aggregateVersion", payload FROM outbox_events WHERE "aggregateId" = $1 ORDER BY "aggregateVersion"',
      [ids.ticketType]
    );
    assert.equal(outbox.rows.length, 1);
    assert.equal(outbox.rows[0].eventType, 'event.ticket-type-status-changed');
    assert.equal(outbox.rows[0].aggregateVersion, 2);
    assert.equal(outbox.rows[0].payload.data.previousStatus, 'ACTIVE');
    assert.equal(outbox.rows[0].payload.data.ticketType.status, 'PAUSED');

    const resumed = await updateTicketTypeStatus(ids.ticketType, userId, 'ACTIVE');
    assert.equal(resumed.status, 'ACTIVE');
    assert.equal(resumed.version, 3);

    await assert.rejects(
      updateTicketTypeStatus(ids.ticketType, userId, 'ARCHIVED'),
      /Published ticket types can only transition between ACTIVE and PAUSED/
    );

    outbox = await client.query(
      'SELECT "eventType", "aggregateVersion", payload FROM outbox_events WHERE "aggregateId" = $1 ORDER BY "aggregateVersion"',
      [ids.ticketType]
    );
    assert.equal(outbox.rows.length, 2);
    assert.deepEqual(outbox.rows.map((row) => row.aggregateVersion), [2, 3]);
    assert.deepEqual(outbox.rows.map((row) => row.payload.data.ticketType.status), ['PAUSED', 'ACTIVE']);
  } finally {
    try {
      await client.query('DELETE FROM outbox_events WHERE "aggregateId" IN ($1, $2)', [ids.ticketType, ids.occurrence]);
      await client.query('DELETE FROM ticket_types WHERE id = $1', [ids.ticketType]);
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
});
