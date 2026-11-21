const { randomUUID } = require('crypto');
const prisma = require('../config/prisma');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/error');
const { requireString, optionalString, slugify } = require('../utils/validation');
const { assertOrganizerAccess } = require('./organizer.service');
const { createOutboxEvent } = require('./outbox.service');

const createEvent = async (organizerId, userId, data) => {
  await assertOrganizerAccess(prisma, organizerId, userId, ['OWNER', 'ADMIN', 'EDITOR']);
  const title = requireString(data.title, 'title', 180);
  const category = requireString(data.category, 'category', 80);
  const id = randomUUID();
  const slug = slugify(data.slug || title) + '-' + id.slice(0, 8);

  return prisma.event.create({
    data: {
      id,
      organizerId,
      title,
      slug,
      description: optionalString(data.description, 'description', 10000),
      category,
      posterImageUrl: optionalString(data.posterImageUrl, 'posterImageUrl', 1000),
      bannerImageUrl: optionalString(data.bannerImageUrl, 'bannerImageUrl', 1000),
    },
  });
};

const listOrganizerEvents = async (organizerId, userId) => {
  await assertOrganizerAccess(prisma, organizerId, userId, ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);
  return prisma.event.findMany({
    where: { organizerId },
    include: {
      _count: { select: { occurrences: true } },
      occurrences: {
        select: { id: true, startsAt: true, status: true, venueId: true },
        orderBy: { startsAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
};

const getEventForOrganizer = async (eventId, userId) => {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: {
      organizer: { select: { id: true } },
      occurrences: {
        include: {
          venue: { select: { id: true, name: true, city: true, timezone: true } },
          layoutVersion: { select: { id: true, version: true, status: true } },
          ticketTypes: { include: { sections: true } },
        },
        orderBy: { startsAt: 'asc' },
      },
    },
  });
  if (!event) throw new NotFoundError('Event not found');
  await assertOrganizerAccess(prisma, event.organizerId, userId, ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);
  return {
    ...event,
    occurrences: event.occurrences.map((occurrence) => ({
      ...occurrence,
      ticketTypes: occurrence.ticketTypes.map((ticketType) => ({
        ...ticketType,
        priceMinorUnits: ticketType.priceMinorUnits.toString(),
      })),
    })),
  };
};

const updateEvent = async (eventId, userId, data) => {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new NotFoundError('Event not found');
  await assertOrganizerAccess(prisma, event.organizerId, userId, ['OWNER', 'ADMIN', 'EDITOR']);
  if (['CANCELLED', 'COMPLETED'].includes(event.status)) {
    throw new ConflictError('Cancelled or completed events cannot be edited');
  }

  const update = {};
  if (data.title !== undefined) update.title = requireString(data.title, 'title', 180);
  if (data.description !== undefined) update.description = optionalString(data.description, 'description', 10000);
  if (data.category !== undefined) update.category = requireString(data.category, 'category', 80);
  if (data.posterImageUrl !== undefined) update.posterImageUrl = optionalString(data.posterImageUrl, 'posterImageUrl', 1000);
  if (data.bannerImageUrl !== undefined) update.bannerImageUrl = optionalString(data.bannerImageUrl, 'bannerImageUrl', 1000);
  if (!Object.keys(update).length) throw new BadRequestError('No valid event fields were supplied');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.event.update({
      where: { id: eventId },
      data: { ...update, version: { increment: 1 } },
    });
    if (event.status === 'PUBLISHED') {
      await createOutboxEvent(tx, {
        aggregateType: 'EVENT',
        aggregateId: updated.id,
        aggregateVersion: updated.version,
        eventType: 'event.updated',
        data: {
          id: updated.id,
          slug: updated.slug,
          title: updated.title,
          description: updated.description,
          category: updated.category,
          posterImageUrl: updated.posterImageUrl,
          bannerImageUrl: updated.bannerImageUrl,
          status: updated.status,
        },
      });
    }
    return updated;
  });
};

const publishEvent = async (eventId, userId) => {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: {
      occurrences: {
        include: {
          layoutVersion: { select: { status: true } },
          ticketTypes: { where: { status: 'ACTIVE' }, select: { id: true } },
        },
      },
    },
  });
  if (!event) throw new NotFoundError('Event not found');
  await assertOrganizerAccess(prisma, event.organizerId, userId, ['OWNER', 'ADMIN', 'EDITOR']);
  if (event.status === 'PUBLISHED') return event;
  if (event.status !== 'DRAFT') throw new ConflictError('Only draft events can be published');
  if (!event.occurrences.length) throw new BadRequestError('Add at least one occurrence before publishing the event');
  for (const occurrence of event.occurrences) {
    if (occurrence.layoutVersion.status !== 'PUBLISHED') {
      throw new BadRequestError('Every occurrence must reference a published venue layout version');
    }
    if (!occurrence.ticketTypes.length) {
      throw new BadRequestError('Every occurrence must have at least one configured ticket type');
    }
  }

  return prisma.$transaction(async (tx) => {
    const transition = await tx.event.updateMany({
      where: { id: eventId, status: 'DRAFT' },
      data: { status: 'PUBLISHED', publishedAt: new Date(), version: { increment: 1 } },
    });
    if (!transition.count) {
      const current = await tx.event.findUnique({ where: { id: eventId } });
      if (current?.status === 'PUBLISHED') return current;
      throw new ConflictError('Event status changed before publication could complete');
    }
    const updated = await tx.event.findUnique({ where: { id: eventId } });
    await createOutboxEvent(tx, {
      aggregateType: 'EVENT',
      aggregateId: updated.id,
      aggregateVersion: updated.version,
      eventType: 'event.published',
      data: {
        id: updated.id,
        organizerId: updated.organizerId,
        title: updated.title,
        slug: updated.slug,
        description: updated.description,
        category: updated.category,
        posterImageUrl: updated.posterImageUrl,
        bannerImageUrl: updated.bannerImageUrl,
        publishedAt: updated.publishedAt,
      },
    });
    return updated;
  });
};

const cancelEvent = async (eventId, userId, reason) => {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new NotFoundError('Event not found');
  await assertOrganizerAccess(prisma, event.organizerId, userId, ['OWNER', 'ADMIN']);
  if (event.status === 'CANCELLED') return event;
  if (event.status === 'COMPLETED') throw new ConflictError('Completed events cannot be cancelled');

  return prisma.$transaction(async (tx) => {
    // Serialize cancellation with occurrence creation for this event.
    await tx.$queryRaw`SELECT id FROM events WHERE id = ${eventId} FOR UPDATE`;
    const occurrences = await tx.eventOccurrence.findMany({
      where: { eventId, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
      select: { id: true },
    });
    const transition = await tx.event.updateMany({
      where: { id: eventId, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });
    if (!transition.count) {
      const current = await tx.event.findUnique({ where: { id: eventId } });
      if (current?.status === 'CANCELLED') return current;
      throw new ConflictError('Event status changed before cancellation could complete');
    }
    const updated = await tx.event.findUnique({ where: { id: eventId } });
    await tx.eventOccurrence.updateMany({
      where: { eventId, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });
    await createOutboxEvent(tx, {
      aggregateType: 'EVENT',
      aggregateId: updated.id,
      aggregateVersion: updated.version,
      eventType: 'event.cancelled',
      data: {
        eventId: updated.id,
        slug: updated.slug,
        reason: optionalString(reason, 'reason', 500) || 'Cancelled by organizer',
        occurrenceIds: occurrences.map((occurrence) => occurrence.id),
      },
    });
    return updated;
  });
};

const listPublicEvents = async ({ category, city, limit = 20, cursor } = {}) => {
  const take = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const where = {
    status: 'PUBLISHED',
    ...(category ? { category: { equals: category, mode: 'insensitive' } } : {}),
    occurrences: {
      some: {
        status: { in: ['SCHEDULED', 'ON_SALE'] },
        ...(city ? { venue: { city: { equals: city, mode: 'insensitive' } } } : {}),
        startsAt: { gt: new Date() },
      },
    },
  };
  return prisma.event.findMany({
    where,
    take,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    include: {
      occurrences: {
        where: { status: { in: ['SCHEDULED', 'ON_SALE'] }, startsAt: { gt: new Date() } },
        include: { venue: { select: { id: true, name: true, city: true, timezone: true } } },
        orderBy: { startsAt: 'asc' },
      },
    },
    orderBy: { publishedAt: 'desc' },
  });
};

const getPublicEventBySlug = async (slug) => {
  const event = await prisma.event.findFirst({
    where: { slug, status: 'PUBLISHED' },
    include: {
      organizer: { select: { id: true, name: true, slug: true } },
      occurrences: {
        where: { status: { in: ['SCHEDULED', 'ON_SALE'] }, startsAt: { gt: new Date() } },
        include: {
          venue: { select: { id: true, name: true, address: true, city: true, state: true, country: true, timezone: true } },
          layoutVersion: { select: { id: true, version: true, snapshot: true } },
          ticketTypes: {
            where: { status: 'ACTIVE' },
            select: {
              id: true, name: true, code: true, description: true, mode: true,
              priceMinorUnits: true, currency: true, capacity: true,
              minPerOrder: true, maxPerOrder: true, salesStartsAt: true, salesEndsAt: true,
            },
          },
        },
        orderBy: { startsAt: 'asc' },
      },
    },
  });
  if (!event) throw new NotFoundError('Published event not found');
  return {
    ...event,
    occurrences: event.occurrences.map((occurrence) => ({
      ...occurrence,
      ticketTypes: occurrence.ticketTypes.map((ticketType) => ({
        ...ticketType,
        priceMinorUnits: ticketType.priceMinorUnits.toString(),
      })),
    })),
  };
};

module.exports = {
  createEvent,
  listOrganizerEvents,
  getEventForOrganizer,
  updateEvent,
  publishEvent,
  cancelEvent,
  listPublicEvents,
  getPublicEventBySlug,
};