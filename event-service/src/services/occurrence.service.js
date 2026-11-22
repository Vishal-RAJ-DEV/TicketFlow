const prisma = require('../config/prisma');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/error');
const { parseDate } = require('../utils/validation');
const { assertOrganizerAccess } = require('./organizer.service');
const { createOutboxEvent } = require('./outbox.service');
const { validateOccurrenceTicketAllocations } = require('../utils/gaCapacity');

const getAuthorizedEvent = async (eventId, userId, roles = ['OWNER', 'ADMIN', 'EDITOR'], client = prisma) => {
  const event = await client.event.findUnique({
    where: { id: eventId },
    select: { id: true, organizerId: true, status: true },
  });
  if (!event) throw new NotFoundError('Event not found');
  await assertOrganizerAccess(client, event.organizerId, userId, roles);
  return event;
};

const lockVenueSchedule = async (tx, venueId) => {
  // Serialize occurrence scheduling for this venue, including concurrent requests.
  await tx.$queryRaw`SELECT id FROM venues WHERE id = ${venueId} FOR UPDATE`;
};

const assertNoVenueScheduleConflict = async (tx, {
  venueId,
  startsAt,
  endsAt,
  excludeOccurrenceId,
}) => {
  const conflict = await tx.eventOccurrence.findFirst({
    where: {
      venueId,
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      ...(excludeOccurrenceId ? { id: { not: excludeOccurrenceId } } : {}),
    },
    select: { id: true, startsAt: true, endsAt: true },
  });
  if (conflict) {
    throw new ConflictError('The venue already has an overlapping event occurrence');
  }
};

const validateOccurrenceTimes = (data, existing = {}) => {
  const startsAt = data.startsAt !== undefined ? parseDate(data.startsAt, 'startsAt') : existing.startsAt;
  const endsAt = data.endsAt !== undefined ? parseDate(data.endsAt, 'endsAt') : existing.endsAt;
  const salesOpenAt = data.salesOpenAt !== undefined ? parseDate(data.salesOpenAt, 'salesOpenAt') : existing.salesOpenAt;
  const salesCloseAt = data.salesCloseAt !== undefined ? parseDate(data.salesCloseAt, 'salesCloseAt') : existing.salesCloseAt;
  if (endsAt <= startsAt) throw new BadRequestError('endsAt must be after startsAt');
  if (salesCloseAt <= salesOpenAt) throw new BadRequestError('salesCloseAt must be after salesOpenAt');
  if (salesCloseAt > startsAt) throw new BadRequestError('Ticket sales must close no later than the occurrence start time');
  return { startsAt, endsAt, salesOpenAt, salesCloseAt };
};

const createOccurrence = async (eventId, userId, data) => {
  const venueId = data.venueId;
  const venueLayoutVersionId = data.venueLayoutVersionId;
  if (!venueId || !venueLayoutVersionId) {
    throw new BadRequestError('venueId and venueLayoutVersionId are required');
  }
  const times = validateOccurrenceTimes(data);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM events WHERE id = ${eventId} FOR UPDATE`;
    const event = await getAuthorizedEvent(eventId, userId, ['OWNER', 'ADMIN', 'EDITOR'], tx);
    if (['CANCELLED', 'COMPLETED'].includes(event.status)) throw new ConflictError('Cannot add an occurrence to a cancelled or completed event');
    await tx.$queryRaw`SELECT id FROM venues WHERE id = ${venueId} FOR UPDATE`;
    const venue = await tx.venue.findFirst({ where: { id: venueId, status: 'ACTIVE' }, select: { id: true, organizerId: true } });
    if (!venue) throw new NotFoundError('Active venue not found');
    if (venue.organizerId !== event.organizerId) throw new BadRequestError('The venue must belong to the same organizer as the event');
    const layoutVersion = await tx.venueLayoutVersion.findFirst({ where: { id: venueLayoutVersionId, venueId, status: 'PUBLISHED' }, select: { id: true } });
    if (!layoutVersion) throw new BadRequestError('venueLayoutVersionId must reference a published layout version belonging to the selected venue');
    await assertNoVenueScheduleConflict(tx, { venueId, startsAt: times.startsAt, endsAt: times.endsAt });
    return tx.eventOccurrence.create({ data: { eventId, venueId, venueLayoutVersionId, ...times }, include: { venue: { select: { id: true, name: true, city: true, timezone: true } }, layoutVersion: { select: { id: true, version: true, status: true } } } });
  });
};

const listOccurrences = async (eventId, userId) => {
  await getAuthorizedEvent(eventId, userId, ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);
  return prisma.eventOccurrence.findMany({
    where: { eventId },
    include: {
      venue: { select: { id: true, name: true, city: true, timezone: true } },
      layoutVersion: { select: { id: true, version: true, status: true } },
      _count: { select: { ticketTypes: true } },
    },
    orderBy: { startsAt: 'asc' },
  });
};

const getOccurrence = async (occurrenceId, userId) => {
  const occurrence = await prisma.eventOccurrence.findUnique({
    where: { id: occurrenceId },
    include: {
      event: { select: { id: true, organizerId: true, title: true, slug: true, status: true } },
      venue: { select: { id: true, name: true, city: true, address: true, timezone: true } },
      layoutVersion: { select: { id: true, version: true, snapshot: true, status: true } },
      ticketTypes: { include: { sections: { include: { venueSection: true } } } },
    },
  });
  if (!occurrence) throw new NotFoundError('Event occurrence not found');
  await assertOrganizerAccess(prisma, occurrence.event.organizerId, userId, ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);
  return {
    ...occurrence,
    ticketTypes: occurrence.ticketTypes.map((ticketType) => ({
      ...ticketType,
      priceMinorUnits: ticketType.priceMinorUnits.toString(),
    })),
  };
};

const updateOccurrence = async (occurrenceId, userId, data) => prisma.$transaction(async (tx) => {
  // Use one lock order for every occurrence mutation: occurrence first, then venue.
  await tx.$queryRaw`SELECT id FROM event_occurrences WHERE id = ${occurrenceId} FOR UPDATE`;
  const occurrence = await tx.eventOccurrence.findUnique({
    where: { id: occurrenceId },
    include: { event: { select: { organizerId: true } } },
  });
  if (!occurrence) throw new NotFoundError('Event occurrence not found');
  await assertOrganizerAccess(tx, occurrence.event.organizerId, userId, ['OWNER', 'ADMIN', 'EDITOR']);
  if (occurrence.status !== 'DRAFT') {
    throw new ConflictError('Only draft occurrences can be edited');
  }

  const update = validateOccurrenceTimes(data, occurrence);
  if (data.venueId !== undefined || data.venueLayoutVersionId !== undefined) {
    const venueId = data.venueId || occurrence.venueId;
    const layoutVersionId = data.venueLayoutVersionId || occurrence.venueLayoutVersionId;
    const venueChanged = venueId !== occurrence.venueId;
    const layoutChanged = layoutVersionId !== occurrence.venueLayoutVersionId;
    if (venueChanged || layoutChanged) {
      const ticketTypeCount = await tx.ticketType.count({ where: { occurrenceId } });
      const activeTicketTypeCount = await tx.ticketType.count({
        where: { occurrenceId, status: { not: 'ARCHIVED' } },
      });
      if (venueChanged && ticketTypeCount > 0) {
        throw new ConflictError('Archive or remove every ticket type before changing the occurrence venue');
      }
      if (layoutChanged && activeTicketTypeCount > 0) {
        throw new ConflictError('Archive every ticket type before switching to a new immutable layout version');
      }
    }
    const layout = await tx.venueLayoutVersion.findFirst({
      where: {
        id: layoutVersionId,
        venueId,
        status: 'PUBLISHED',
        venue: { status: 'ACTIVE', organizerId: occurrence.event.organizerId },
      },
      select: { id: true },
    });
    if (!layout) throw new BadRequestError('Select a published layout version belonging to an active venue');
    update.venueId = venueId;
    update.venueLayoutVersionId = layoutVersionId;
  }

  const venueId = update.venueId || occurrence.venueId;
  await lockVenueSchedule(tx, venueId);
  await assertNoVenueScheduleConflict(tx, {
    venueId,
    startsAt: update.startsAt,
    endsAt: update.endsAt,
    excludeOccurrenceId: occurrenceId,
  });

  const changed = await tx.eventOccurrence.updateMany({
    where: { id: occurrenceId, status: 'DRAFT', version: occurrence.version },
    data: { ...update, version: { increment: 1 } },
  });
  if (!changed.count) {
    throw new ConflictError('Occurrence was modified by another request; reload it and retry');
  }
  return tx.eventOccurrence.findUnique({ where: { id: occurrenceId } });
});

const publishOccurrence = async (occurrenceId, userId) => {
  const initial = await prisma.eventOccurrence.findUnique({ where: { id: occurrenceId }, include: { event: { select: { organizerId: true } } } });
  if (!initial) throw new NotFoundError('Event occurrence not found');
  await assertOrganizerAccess(prisma, initial.event.organizerId, userId, ['OWNER', 'ADMIN', 'EDITOR']);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM event_occurrences WHERE id = ${occurrenceId} FOR UPDATE`;
    let occurrence = await tx.eventOccurrence.findUnique({
      where: { id: occurrenceId },
      include: {
        event: true,
        venue: true,
        layoutVersion: true,
        ticketTypes: { where: { status: 'ACTIVE' }, include: { sections: { include: { venueSection: true } } } },
      },
    });
    if (!occurrence) throw new NotFoundError('Event occurrence not found');
    // Serialize publication against venue metadata changes and re-read after acquiring the venue lock.
    await tx.$queryRaw`SELECT id FROM venues WHERE id = ${occurrence.venueId} FOR UPDATE`;
    const currentVenue = await tx.venue.findUnique({ where: { id: occurrence.venueId } });
    if (!currentVenue) throw new NotFoundError('Occurrence venue not found');
    occurrence = { ...occurrence, venue: currentVenue };
    await assertOrganizerAccess(tx, occurrence.event.organizerId, userId, ['OWNER', 'ADMIN', 'EDITOR']);
    if (occurrence.status !== 'DRAFT') {
      if (['SCHEDULED', 'ON_SALE', 'SALES_CLOSED'].includes(occurrence.status)) return occurrence;
      throw new ConflictError('Only draft occurrences can be published');
    }
    if (occurrence.event.status !== 'PUBLISHED') throw new ConflictError('Publish the parent event before publishing its occurrence');
    if (occurrence.venue.status !== 'ACTIVE') throw new ConflictError('The selected venue is inactive');
    if (occurrence.venue.organizerId !== occurrence.event.organizerId) throw new ConflictError('The occurrence venue must belong to the event organizer');
    if (occurrence.layoutVersion.status !== 'PUBLISHED' || !occurrence.layoutVersion.snapshot) throw new ConflictError('The selected venue layout is not published');
    if (!occurrence.ticketTypes.length) throw new BadRequestError('At least one active ticket type is required before publishing an occurrence');

    validateOccurrenceTicketAllocations(occurrence.ticketTypes, occurrence.layoutVersion.snapshot.sections || []);
    const now = new Date();
    if (occurrence.startsAt <= now || occurrence.salesCloseAt <= now) throw new BadRequestError('An occurrence cannot be published after its start or sales-close time');
    for (const ticketType of occurrence.ticketTypes) {
      if (ticketType.salesStartsAt < occurrence.salesOpenAt || ticketType.salesEndsAt > occurrence.salesCloseAt) {
        throw new BadRequestError('Ticket type sales windows must be contained within the occurrence sales window');
      }
    }
    const status = now < occurrence.salesOpenAt ? 'SCHEDULED' : 'ON_SALE';
    const transition = await tx.eventOccurrence.updateMany({
      where: { id: occurrenceId, status: 'DRAFT', version: occurrence.version },
      data: { status, publishedAt: now, version: { increment: 1 } },
    });
    if (!transition.count) throw new ConflictError('Occurrence configuration changed before publication could complete');
    const published = await tx.eventOccurrence.findUnique({ where: { id: occurrenceId } });
    const data = {
      occurrence: {
        id: published.id,
        eventId: published.eventId,
        venueId: published.venueId,
        venueLayoutVersionId: published.venueLayoutVersionId,
        startsAt: published.startsAt,
        endsAt: published.endsAt,
        salesOpenAt: published.salesOpenAt,
        salesCloseAt: published.salesCloseAt,
        status: published.status,
        version: published.version,
      },
      event: { id: occurrence.event.id, organizerId: occurrence.event.organizerId, title: occurrence.event.title, slug: occurrence.event.slug, category: occurrence.event.category },
      venue: { id: occurrence.venue.id, name: occurrence.venue.name, city: occurrence.venue.city, timezone: occurrence.venue.timezone },
      layoutVersion: { id: occurrence.layoutVersion.id, version: occurrence.layoutVersion.version, snapshot: occurrence.layoutVersion.snapshot },
      ticketTypes: occurrence.ticketTypes.map((ticketType) => ({
        id: ticketType.id,
        occurrenceId: ticketType.occurrenceId,
        name: ticketType.name,
        code: ticketType.code,
        description: ticketType.description,
        mode: ticketType.mode,
        priceMinorUnits: ticketType.priceMinorUnits.toString(),
        currency: ticketType.currency,
        capacity: ticketType.capacity,
        minPerOrder: ticketType.minPerOrder,
        maxPerOrder: ticketType.maxPerOrder,
        salesStartsAt: ticketType.salesStartsAt,
        salesEndsAt: ticketType.salesEndsAt,
        status: ticketType.status,
        version: ticketType.version,
        sectionIds: ticketType.sections.map((entry) => entry.venueSectionId),
        sectionAllocations: ticketType.sections.map((entry) => ({ sectionId: entry.venueSectionId, capacity: entry.capacity })),
      })),
    };
    await createOutboxEvent(tx, {
      aggregateType: 'EVENT_OCCURRENCE',
      aggregateId: published.id,
      aggregateVersion: published.version,
      eventType: 'event.occurrence-published',
      data,
    });
    return published;
  });
};

module.exports = {
  createOccurrence,
  listOccurrences,
  getOccurrence,
  updateOccurrence,
  publishOccurrence,
};