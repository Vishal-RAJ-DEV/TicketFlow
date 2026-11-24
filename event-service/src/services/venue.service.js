const prisma = require('../config/prisma');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/error');
const {
  requireString,
  optionalString,
  parsePositiveInteger,
  validateTimezone,
} = require('../utils/validation');
const { assertOrganizerAccess } = require('./organizer.service');
const { createOutboxEvent } = require('./outbox.service');

const ensureVenueAccess = async (client, venueId, userId, roles = ['OWNER', 'ADMIN', 'EDITOR']) => {
  const venue = await client.venue.findUnique({
    where: { id: venueId },
    select: { id: true, organizerId: true, status: true },
  });
  if (!venue) throw new NotFoundError('Venue not found');
  await assertOrganizerAccess(client, venue.organizerId, userId, roles);
  return venue;
};

const withDraftLayout = async (venueId, work) => prisma.$transaction(async (tx) => {
  // Serialize layout mutations against publication by locking the draft version row.
  const drafts = await tx.$queryRaw`
    SELECT id
    FROM venue_layout_versions
    WHERE "venueId" = ${venueId} AND status = 'DRAFT'
    ORDER BY version DESC
    LIMIT 1
    FOR UPDATE
  `;
  if (!drafts.length) {
    throw new ConflictError('Create a new draft layout version before changing venue sections or seats');
  }
  return work(tx, drafts[0].id);
});

const createVenue = async (organizerId, userId, data) => {
  await assertOrganizerAccess(prisma, organizerId, userId, ['OWNER', 'ADMIN', 'EDITOR']);
  const name = requireString(data.name, 'name', 160);
  const address = requireString(data.address, 'address', 500);
  const city = requireString(data.city, 'city', 120);
  const timezone = validateTimezone(data.timezone || 'Asia/Kolkata');

  return prisma.$transaction(async (tx) => {
    const venue = await tx.venue.create({
      data: {
        organizerId,
        name,
        address,
        city,
        state: optionalString(data.state, 'state', 120),
        country: data.country ? requireString(data.country, 'country', 80) : 'India',
        postalCode: optionalString(data.postalCode, 'postalCode', 24),
        timezone,
        description: optionalString(data.description, 'description', 2000),
      },
    });

    const layoutVersion = await tx.venueLayoutVersion.create({
      data: {
        venueId: venue.id,
        version: 1,
        createdBy: userId,
      },
    });

    return { ...venue, draftLayoutVersion: layoutVersion };
  });
};

const listVenues = async (organizerId, userId) => {
  await assertOrganizerAccess(prisma, organizerId, userId, ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);
  return prisma.venue.findMany({
    where: { organizerId },
    include: {
      _count: { select: { sections: true, occurrences: true, layoutVersions: true } },
      layoutVersions: {
        where: { status: 'PUBLISHED' },
        orderBy: { version: 'desc' },
        take: 1,
        select: { id: true, version: true, publishedAt: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
};

const getVenue = async (venueId, userId) => {
  await ensureVenueAccess(prisma, venueId, userId, ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);
  return prisma.venue.findUnique({
    where: { id: venueId },
    include: {
      sections: {
        where: { isActive: true },
        include: { seats: { where: { isActive: true }, orderBy: [{ rowLabel: 'asc' }, { seatLabel: 'asc' }] } },
        orderBy: { sortOrder: 'asc' },
      },
      layoutVersions: { orderBy: { version: 'desc' } },
    },
  });
};

const updateVenue = async (venueId, userId, data) => {
  await ensureVenueAccess(prisma, venueId, userId, ['OWNER', 'ADMIN', 'EDITOR']);
  const update = {};
  if (data.name !== undefined) update.name = requireString(data.name, 'name', 160);
  if (data.address !== undefined) update.address = requireString(data.address, 'address', 500);
  if (data.city !== undefined) update.city = requireString(data.city, 'city', 120);
  if (data.state !== undefined) update.state = optionalString(data.state, 'state', 120);
  if (data.country !== undefined) update.country = requireString(data.country, 'country', 80);
  if (data.postalCode !== undefined) update.postalCode = optionalString(data.postalCode, 'postalCode', 24);
  if (data.timezone !== undefined) update.timezone = validateTimezone(data.timezone);
  if (data.description !== undefined) update.description = optionalString(data.description, 'description', 2000);
  if (data.status !== undefined) {
    if (!['ACTIVE', 'INACTIVE'].includes(data.status)) throw new BadRequestError('status must be ACTIVE or INACTIVE');
    update.status = data.status;
  }
  if (!Object.keys(update).length) throw new BadRequestError('No valid venue fields were supplied');

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM venues WHERE id = ${venueId} FOR UPDATE`;
    const current = await tx.venue.findUnique({ where: { id: venueId } });
    if (!current) throw new NotFoundError('Venue not found');

    const catalogFields = ['name', 'address', 'city', 'state', 'country', 'postalCode', 'timezone', 'status'];
    const changesCatalogData = catalogFields.some((field) =>
      update[field] !== undefined && update[field] !== current[field]
    );
    if (changesCatalogData) {
      const liveOccurrences = await tx.eventOccurrence.count({
        where: { venueId, status: { in: ['SCHEDULED', 'ON_SALE', 'SALES_CLOSED'] } },
      });
      if (liveOccurrences > 0) {
        throw new ConflictError(
          'Venue identity and location fields are frozen while it has published future occurrences; cancel those occurrences or wait until they complete'
        );
      }
    }

    return tx.venue.update({ where: { id: venueId }, data: update });
  });
};

const createLayoutVersion = async (venueId, userId) => {
  await ensureVenueAccess(prisma, venueId, userId, ['OWNER', 'ADMIN', 'EDITOR']);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM venues WHERE id = ${venueId} FOR UPDATE`;
    const existingDraft = await tx.venueLayoutVersion.findFirst({ where: { venueId, status: 'DRAFT' } });
    if (existingDraft) throw new ConflictError('A draft layout version already exists for this venue');
    const latest = await tx.venueLayoutVersion.findFirst({
      where: { venueId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return tx.venueLayoutVersion.create({
      data: { venueId, version: (latest?.version || 0) + 1, createdBy: userId },
    });
  });
};

const listLayoutVersions = async (venueId, userId) => {
  await ensureVenueAccess(prisma, venueId, userId, ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);
  return prisma.venueLayoutVersion.findMany({
    where: { venueId },
    orderBy: { version: 'desc' },
    select: { id: true, venueId: true, version: true, status: true, publishedAt: true, createdAt: true },
  });
};

const createSection = async (venueId, userId, data) => {
  await ensureVenueAccess(prisma, venueId, userId);
  const name = requireString(data.name, 'name', 100);
  const mode = data.mode;
  if (!['ASSIGNED', 'GENERAL_ADMISSION'].includes(mode)) {
    throw new BadRequestError('mode must be ASSIGNED or GENERAL_ADMISSION');
  }
  const capacity = mode === 'GENERAL_ADMISSION'
    ? parsePositiveInteger(data.capacity, 'capacity', 10000000)
    : null;
  if (mode === 'ASSIGNED' && data.capacity !== undefined && data.capacity !== null) {
    throw new BadRequestError('capacity is only valid for GENERAL_ADMISSION sections');
  }
  return withDraftLayout(venueId, (tx) => tx.venueSection.create({
    data: {
      venueId,
      name,
      code: optionalString(data.code, 'code', 24),
      mode,
      capacity,
      description: optionalString(data.description, 'description', 500),
      sortOrder: Number.isInteger(data.sortOrder) ? data.sortOrder : 0,
    },
  }));
};

const listSections = async (venueId, userId) => {
  await ensureVenueAccess(prisma, venueId, userId, ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);
  return prisma.venueSection.findMany({
    where: { venueId, isActive: true },
    include: { seats: { where: { isActive: true }, orderBy: [{ rowLabel: 'asc' }, { seatLabel: 'asc' }] } },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
};

const updateSection = async (venueId, sectionId, userId, data) => {
  await ensureVenueAccess(prisma, venueId, userId);
  return withDraftLayout(venueId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM venues WHERE id = ${venueId} FOR UPDATE`;
    const section = await tx.venueSection.findFirst({ where: { id: sectionId, venueId, isActive: true } });
    if (!section) throw new NotFoundError('Venue section not found');

    const update = {};
    if (data.name !== undefined) update.name = requireString(data.name, 'name', 100);
    if (data.code !== undefined) update.code = optionalString(data.code, 'code', 24);
    if (data.description !== undefined) update.description = optionalString(data.description, 'description', 500);
    if (data.sortOrder !== undefined) {
      if (!Number.isInteger(data.sortOrder)) throw new BadRequestError('sortOrder must be an integer');
      update.sortOrder = data.sortOrder;
    }

    const nextMode = data.mode !== undefined ? data.mode : section.mode;
    if (!['ASSIGNED', 'GENERAL_ADMISSION'].includes(nextMode)) {
      throw new BadRequestError('mode must be ASSIGNED or GENERAL_ADMISSION');
    }
    if (data.mode !== undefined && data.mode !== section.mode) {
      const activeSeats = await tx.venueSeat.count({ where: { sectionId, isActive: true } });
      if (nextMode === 'GENERAL_ADMISSION' && activeSeats) {
        throw new ConflictError('Remove or deactivate assigned seats before changing this section to general admission');
      }
      update.mode = nextMode;
    }

    if (nextMode === 'GENERAL_ADMISSION') {
      const nextCapacity = data.capacity !== undefined
        ? parsePositiveInteger(data.capacity, 'capacity', 10000000)
        : section.capacity;
      if (!nextCapacity) {
        throw new BadRequestError('A GENERAL_ADMISSION section requires a positive capacity');
      }
      if (data.capacity !== undefined && nextCapacity !== section.capacity) {
        // Capacity is captured in immutable layout snapshots. Updating the
        // mutable section row affects only layout versions published later.
        update.capacity = nextCapacity;
      }
    } else {
      if (data.capacity !== undefined && data.capacity !== null) {
        throw new BadRequestError('capacity is only valid for GENERAL_ADMISSION sections');
      }
      if (section.capacity !== null || section.mode !== nextMode) update.capacity = null;
    }

    if (!Object.keys(update).length) throw new BadRequestError('No valid section fields were supplied');
    return tx.venueSection.update({ where: { id: sectionId }, data: update });
  });
};

const deactivateSection = async (venueId, sectionId, userId) => {
  await ensureVenueAccess(prisma, venueId, userId);
  return withDraftLayout(venueId, async (tx) => {
    const result = await tx.venueSection.updateMany({
      where: { id: sectionId, venueId, isActive: true },
      data: { isActive: false },
    });
    if (!result.count) throw new NotFoundError('Venue section not found');
    return { deactivated: true };
  });
};

const addSeats = async (venueId, sectionId, userId, seats) => {
  await ensureVenueAccess(prisma, venueId, userId);
  if (!Array.isArray(seats) || seats.length < 1 || seats.length > 500) {
    throw new BadRequestError('seats must be an array containing between 1 and 500 seats');
  }
  return withDraftLayout(venueId, async (tx) => {
  const section = await tx.venueSection.findFirst({ where: { id: sectionId, venueId, isActive: true } });
  if (!section) throw new NotFoundError('Venue section not found');
  if (section.mode !== 'ASSIGNED') throw new BadRequestError('Seats can only be added to assigned-seating sections');

  const normalized = seats.map((seat) => {
    if (!seat || typeof seat !== 'object' || Array.isArray(seat)) throw new BadRequestError('Each seat entry must be an object');
    const rowLabel = requireString(seat.rowLabel, 'rowLabel', 24);
    const seatLabel = requireString(seat.seatLabel, 'seatLabel', 24);
    if (seat.x !== undefined && (typeof seat.x !== 'number' || !Number.isFinite(seat.x))) {
      throw new BadRequestError('seat x coordinate must be a finite number');
    }
    if (seat.y !== undefined && (typeof seat.y !== 'number' || !Number.isFinite(seat.y))) {
      throw new BadRequestError('seat y coordinate must be a finite number');
    }
    return { sectionId, rowLabel, seatLabel, x: seat.x ?? null, y: seat.y ?? null };
  });

  const keys = normalized.map((seat) => seat.rowLabel + '|' + seat.seatLabel);
  if (new Set(keys).size !== keys.length) throw new BadRequestError('The request contains duplicate row/seat labels');

  await tx.venueSeat.createMany({ data: normalized });
  return tx.venueSeat.findMany({
    where: { sectionId, isActive: true },
    orderBy: [{ rowLabel: 'asc' }, { seatLabel: 'asc' }],
  });
  });
};

const updateSeat = async (venueId, sectionId, seatId, userId, data) => {
  await ensureVenueAccess(prisma, venueId, userId);
  return withDraftLayout(venueId, async (tx) => {
  const seat = await tx.venueSeat.findFirst({ where: { id: seatId, sectionId, section: { venueId }, isActive: true } });
  if (!seat) throw new NotFoundError('Venue seat not found');
  const update = {};
  if (data.rowLabel !== undefined) update.rowLabel = requireString(data.rowLabel, 'rowLabel', 24);
  if (data.seatLabel !== undefined) update.seatLabel = requireString(data.seatLabel, 'seatLabel', 24);
  for (const coordinate of ['x', 'y']) {
    if (data[coordinate] !== undefined) {
      if (data[coordinate] !== null && (typeof data[coordinate] !== 'number' || !Number.isFinite(data[coordinate]))) {
        throw new BadRequestError(coordinate + ' coordinate must be a finite number or null');
      }
      update[coordinate] = data[coordinate];
    }
  }
  if (!Object.keys(update).length) throw new BadRequestError('No valid seat fields were supplied');
  return tx.venueSeat.update({ where: { id: seatId }, data: update });
  });
};

const deactivateSeat = async (venueId, sectionId, seatId, userId) => {
  await ensureVenueAccess(prisma, venueId, userId);
  return withDraftLayout(venueId, async (tx) => {
    const result = await tx.venueSeat.updateMany({
      where: { id: seatId, sectionId, section: { venueId }, isActive: true },
      data: { isActive: false },
    });
    if (!result.count) throw new NotFoundError('Venue seat not found');
    return { deactivated: true };
  });
};

const publishLayoutVersion = async (venueId, layoutVersionId, userId) => {
  await ensureVenueAccess(prisma, venueId, userId);
  return prisma.$transaction(async (tx) => {
    // Lock the same row used by every section/seat mutation before capturing the snapshot.
    const lockedVersions = await tx.$queryRaw`
      SELECT id
      FROM venue_layout_versions
      WHERE id = ${layoutVersionId} AND "venueId" = ${venueId} AND status = 'DRAFT'
      FOR UPDATE
    `;
    if (!lockedVersions.length) throw new NotFoundError('Draft venue layout version not found');
    const version = await tx.venueLayoutVersion.findUnique({ where: { id: layoutVersionId } });

    const venue = await tx.venue.findUnique({ where: { id: venueId } });
    const sections = await tx.venueSection.findMany({
      where: { venueId, isActive: true },
      include: {
        seats: {
          where: { isActive: true },
          select: { id: true, rowLabel: true, seatLabel: true, x: true, y: true },
          orderBy: [{ rowLabel: 'asc' }, { seatLabel: 'asc' }],
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    if (!sections.length) throw new BadRequestError('A venue layout must contain at least one active section');
    for (const section of sections) {
      if (section.mode === 'ASSIGNED' && !section.seats.length) {
        throw new BadRequestError('Assigned section ' + section.name + ' must contain at least one active seat');
      }
      if (section.mode === 'GENERAL_ADMISSION' && section.seats.length) {
        throw new BadRequestError('General-admission section ' + section.name + ' cannot contain individual seats');
      }
      if (section.mode === 'GENERAL_ADMISSION' && (!Number.isInteger(section.capacity) || section.capacity < 1)) {
        throw new BadRequestError('General-admission section ' + section.name + ' must have a positive capacity before publishing the layout');
      }
    }

    const snapshot = {
      schemaVersion: 1,
      venueId,
      layoutVersionId: version.id,
      version: version.version,
      capturedAt: new Date().toISOString(),
      sections: sections.map((section) => ({
        id: section.id,
        name: section.name,
        code: section.code,
        mode: section.mode,
        capacity: section.capacity,
        sortOrder: section.sortOrder,
        seats: section.seats,
      })),
    };

    const transition = await tx.venueLayoutVersion.updateMany({
      where: { id: version.id, status: 'DRAFT' },
      data: { status: 'PUBLISHED', snapshot, publishedAt: new Date() },
    });
    if (!transition.count) throw new ConflictError('Venue layout version was already published or changed');
    const published = await tx.venueLayoutVersion.findUnique({ where: { id: version.id } });

    await createOutboxEvent(tx, {
      aggregateType: 'VENUE_LAYOUT_VERSION',
      aggregateId: published.id,
      aggregateVersion: published.version,
      eventType: 'venue.layout-version-published',
      data: {
        venue: {
          id: venue.id,
          organizerId: venue.organizerId,
          name: venue.name,
          city: venue.city,
          timezone: venue.timezone,
        },
        layoutVersion: {
          id: published.id,
          version: published.version,
          snapshot,
          publishedAt: published.publishedAt,
        },
      },
    });

    return published;
  });
};

module.exports = {
  createVenue, listVenues, getVenue, updateVenue,
  createLayoutVersion, listLayoutVersions,
  createSection, listSections, updateSection, deactivateSection,
  addSeats, updateSeat, deactivateSeat, publishLayoutVersion,
  ensureVenueAccess,
};