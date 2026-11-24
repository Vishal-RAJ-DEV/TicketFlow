const prisma = require('../config/prisma');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/error');
const {
  requireString,
  optionalString,
  parseDate,
  parseMinorUnits,
  parsePositiveInteger,
  normalizeCurrency,
} = require('../utils/validation');
const { assertOrganizerAccess } = require('./organizer.service');
const { createOutboxEvent } = require('./outbox.service');
const { KAFKA_TOPICS } = require('../../../shared/constants/kafka-topics');

const lockOccurrence = async (tx, occurrenceId) => {
  // Serializes every inventory configuration mutation for one occurrence.
  await tx.$queryRaw`SELECT id FROM event_occurrences WHERE id = ${occurrenceId} FOR UPDATE`;
};

const getAuthorizedOccurrence = async (occurrenceId, userId, roles = ['OWNER', 'ADMIN', 'EDITOR'], client = prisma) => {
  const occurrence = await client.eventOccurrence.findUnique({
    where: { id: occurrenceId },
    include: {
      event: { select: { id: true, organizerId: true, status: true } },
      venue: { select: { id: true, status: true } },
      layoutVersion: { select: { id: true, status: true, snapshot: true } },
    },
  });
  if (!occurrence) throw new NotFoundError('Event occurrence not found');
  await assertOrganizerAccess(client, occurrence.event.organizerId, userId, roles);
  return occurrence;
};

const normalizeSectionConfiguration = (mode, data, existing) => {
  if (mode === 'GENERAL_ADMISSION') {
    let allocations = data.sectionAllocations;
    if (allocations === undefined && data.sectionIds !== undefined) {
      if (!Array.isArray(data.sectionIds) || data.sectionIds.length !== 1) {
        throw new BadRequestError('For multi-section general admission, provide sectionAllocations with a capacity for each section');
      }
      allocations = [{
        sectionId: data.sectionIds[0],
        capacity: data.capacity !== undefined ? data.capacity : existing.capacity,
      }];
    }
    if (allocations === undefined && existing.sections?.length) {
      allocations = existing.sections.map((section) => ({
        sectionId: section.venueSectionId,
        capacity: section.capacity,
      }));
    }
    if (!Array.isArray(allocations) || allocations.length < 1) {
      throw new BadRequestError('General-admission ticket types require sectionAllocations');
    }

    const normalized = allocations.map((allocation, index) => {
      if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)) {
        throw new BadRequestError('Each sectionAllocations entry must be an object');
      }
      return {
        sectionId: requireString(allocation.sectionId, `sectionAllocations[${index}].sectionId`, 80),
        capacity: parsePositiveInteger(allocation.capacity, `sectionAllocations[${index}].capacity`, 10000000),
      };
    });
    const ids = normalized.map((allocation) => allocation.sectionId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestError('sectionAllocations must not contain duplicate sectionId values');
    }

    const totalCapacity = normalized.reduce((sum, allocation) => sum + allocation.capacity, 0);
    if (!Number.isSafeInteger(totalCapacity) || totalCapacity > 10000000) {
      throw new BadRequestError('The total GA allocation must be no greater than 10000000');
    }
    if (data.capacity !== undefined && parsePositiveInteger(data.capacity, 'capacity', 10000000) !== totalCapacity) {
      throw new BadRequestError('capacity must equal the sum of sectionAllocations capacities');
    }
    return { sectionIds: ids, sectionAllocations: normalized, capacity: totalCapacity };
  }

  if (data.sectionAllocations !== undefined) {
    throw new BadRequestError('sectionAllocations is only valid for GENERAL_ADMISSION ticket types');
  }
  if (data.capacity !== undefined && data.capacity !== null) {
    throw new BadRequestError('capacity must be omitted for assigned-seating ticket types');
  }
  const sectionIds = data.sectionIds !== undefined
    ? data.sectionIds
    : (existing.sections || []).map((section) => section.venueSectionId);
  if (!Array.isArray(sectionIds) || sectionIds.length < 1) {
    throw new BadRequestError('At least one eligible sectionId is required');
  }
  if (sectionIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new BadRequestError('Every sectionId must be a non-empty string');
  }
  if (new Set(sectionIds).size !== sectionIds.length) {
    throw new BadRequestError('sectionIds must not contain duplicates');
  }
  return {
    sectionIds,
    sectionAllocations: sectionIds.map((sectionId) => ({ sectionId, capacity: null })),
    capacity: null,
  };
};

const validateTicketTypeInput = async (client, occurrence, data, existing = {}) => {
  const name = data.name !== undefined ? requireString(data.name, 'name', 100) : existing.name;
  const code = data.code !== undefined ? requireString(data.code, 'code', 32).toUpperCase() : existing.code;
  const mode = data.mode !== undefined ? data.mode : existing.mode;
  if (!['ASSIGNED', 'GENERAL_ADMISSION'].includes(mode)) {
    throw new BadRequestError('mode must be ASSIGNED or GENERAL_ADMISSION');
  }

  const priceMinorUnits = data.priceMinorUnits !== undefined
    ? parseMinorUnits(data.priceMinorUnits)
    : existing.priceMinorUnits;
  const currency = data.currency !== undefined
    ? normalizeCurrency(data.currency)
    : (existing.currency || 'INR');

  const minPerOrder = data.minPerOrder !== undefined
    ? parsePositiveInteger(data.minPerOrder, 'minPerOrder', 100)
    : (existing.minPerOrder || 1);
  const maxPerOrder = data.maxPerOrder !== undefined
    ? parsePositiveInteger(data.maxPerOrder, 'maxPerOrder', 100)
    : (existing.maxPerOrder || 6);
  if (maxPerOrder < minPerOrder) {
    throw new BadRequestError('maxPerOrder must be greater than or equal to minPerOrder');
  }

  const salesStartsAt = data.salesStartsAt !== undefined
    ? parseDate(data.salesStartsAt, 'salesStartsAt')
    : existing.salesStartsAt;
  const salesEndsAt = data.salesEndsAt !== undefined
    ? parseDate(data.salesEndsAt, 'salesEndsAt')
    : existing.salesEndsAt;
  if (!salesStartsAt || !salesEndsAt || salesEndsAt <= salesStartsAt) {
    throw new BadRequestError('salesEndsAt must be after salesStartsAt');
  }
  if (salesStartsAt < occurrence.salesOpenAt || salesEndsAt > occurrence.salesCloseAt) {
    throw new BadRequestError('Ticket type sales windows must be contained within the occurrence sales window');
  }

  const allocation = normalizeSectionConfiguration(mode, data, existing);
  const snapshotSections = occurrence.layoutVersion.snapshot?.sections || [];
  const selectedSnapshotSections = allocation.sectionIds.map((sectionId) =>
    snapshotSections.find((section) => section.id === sectionId)
  );
  if (selectedSnapshotSections.some((section) => !section)) {
    throw new BadRequestError('Every selected section must belong to the occurrence layout version');
  }
  if (selectedSnapshotSections.some((section) => section.mode !== mode)) {
    throw new BadRequestError('Ticket type mode must match the mode of every eligible venue section');
  }
  if (mode === 'ASSIGNED' && selectedSnapshotSections.some((section) => !Array.isArray(section.seats) || !section.seats.length)) {
    throw new BadRequestError('Assigned ticket types require sections with seats');
  }
  if (mode === 'GENERAL_ADMISSION') {
    for (const section of selectedSnapshotSections) {
      if (Array.isArray(section.seats) && section.seats.length) {
        throw new BadRequestError('General-admission ticket types cannot target sections with individual seats');
      }
      if (!Number.isInteger(section.capacity) || section.capacity < 1) {
        throw new BadRequestError('Every general-admission section must have a positive capacity in the published layout snapshot');
      }
    }
    for (const entry of allocation.sectionAllocations) {
      const snapshot = selectedSnapshotSections.find((section) => section.id === entry.sectionId);
      if (entry.capacity > snapshot.capacity) {
        throw new BadRequestError('A section allocation cannot exceed that section capacity');
      }
    }
  }

  const sections = await client.venueSection.findMany({
    where: { id: { in: allocation.sectionIds }, venueId: occurrence.venueId },
    select: { id: true },
  });
  if (sections.length !== allocation.sectionIds.length) {
    throw new BadRequestError('One or more selected sections do not belong to the occurrence venue');
  }

  if (mode === 'GENERAL_ADMISSION') {
    const otherAllocations = await client.ticketTypeSection.findMany({
      where: {
        venueSectionId: { in: allocation.sectionIds },
        ...(existing.id ? { ticketTypeId: { not: existing.id } } : {}),
        ticketType: { occurrenceId: occurrence.id, status: { not: 'ARCHIVED' } },
      },
      select: { venueSectionId: true, capacity: true },
    });
    const allocatedBySection = new Map();
    for (const entry of otherAllocations) {
      if (!Number.isInteger(entry.capacity) || entry.capacity < 1) {
        throw new ConflictError('An existing GA ticket type has no valid section allocation; reconfigure it before adding another allocation');
      }
      allocatedBySection.set(entry.venueSectionId, (allocatedBySection.get(entry.venueSectionId) || 0) + entry.capacity);
    }
    for (const entry of allocation.sectionAllocations) {
      const snapshot = selectedSnapshotSections.find((section) => section.id === entry.sectionId);
      const alreadyAllocated = allocatedBySection.get(entry.sectionId) || 0;
      if (alreadyAllocated + entry.capacity > snapshot.capacity) {
        throw new ConflictError(
          `GA allocations for section ${snapshot.name} exceed its configured capacity of ${snapshot.capacity}`
        );
      }
    }
  }

  return {
    name,
    code,
    description: data.description !== undefined
      ? optionalString(data.description, 'description', 1000)
      : existing.description,
    mode,
    priceMinorUnits,
    currency,
    capacity: allocation.capacity,
    minPerOrder,
    maxPerOrder,
    salesStartsAt,
    salesEndsAt,
    sectionIds: allocation.sectionIds,
    sectionAllocations: allocation.sectionAllocations,
  };
};

const createTicketType = async (occurrenceId, userId, data) => prisma.$transaction(async (tx) => {
  await lockOccurrence(tx, occurrenceId);
  const occurrence = await getAuthorizedOccurrence(occurrenceId, userId, ['OWNER', 'ADMIN', 'EDITOR'], tx);
  if (occurrence.status !== 'DRAFT') {
    throw new ConflictError('Ticket types can only be added before occurrence publication');
  }
  if (occurrence.layoutVersion.status !== 'PUBLISHED' || !occurrence.layoutVersion.snapshot) {
    throw new ConflictError('Publish the venue layout before configuring ticket types');
  }

  const values = await validateTicketTypeInput(tx, occurrence, data);
  const existingCurrency = await tx.ticketType.findFirst({
    where: { occurrenceId, status: { not: 'ARCHIVED' } },
    select: { currency: true },
  });
  if (existingCurrency && existingCurrency.currency !== values.currency) {
    throw new BadRequestError('All ticket types within an occurrence must use the same currency');
  }

  const ticketType = await tx.ticketType.create({
    data: {
      occurrenceId,
      name: values.name,
      code: values.code,
      description: values.description,
      mode: values.mode,
      priceMinorUnits: values.priceMinorUnits,
      currency: values.currency,
      capacity: values.capacity,
      minPerOrder: values.minPerOrder,
      maxPerOrder: values.maxPerOrder,
      salesStartsAt: values.salesStartsAt,
      salesEndsAt: values.salesEndsAt,
      sections: {
        create: values.sectionAllocations.map((entry) => ({
          venueSectionId: entry.sectionId,
          capacity: entry.capacity,
        })),
      },
    },
    include: { sections: true },
  });
  return { ...ticketType, priceMinorUnits: ticketType.priceMinorUnits.toString() };
});

const listTicketTypes = async (occurrenceId, userId) => {
  await getAuthorizedOccurrence(occurrenceId, userId, ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);
  const ticketTypes = await prisma.ticketType.findMany({
    where: { occurrenceId },
    include: { sections: { include: { venueSection: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return ticketTypes.map((ticketType) => ({
    ...ticketType,
    priceMinorUnits: ticketType.priceMinorUnits.toString(),
  }));
};

const updateTicketType = async (ticketTypeId, userId, data) => {
  const initial = await prisma.ticketType.findUnique({
    where: { id: ticketTypeId },
    select: { occurrenceId: true },
  });
  if (!initial) throw new NotFoundError('Ticket type not found');

  return prisma.$transaction(async (tx) => {
    await lockOccurrence(tx, initial.occurrenceId);
    const ticketType = await tx.ticketType.findUnique({
      where: { id: ticketTypeId },
      include: {
        occurrence: {
          include: {
            event: { select: { organizerId: true } },
            layoutVersion: { select: { status: true, snapshot: true } },
          },
        },
        sections: true,
      },
    });
    if (!ticketType) throw new NotFoundError('Ticket type not found');
    await assertOrganizerAccess(tx, ticketType.occurrence.event.organizerId, userId, ['OWNER', 'ADMIN', 'EDITOR']);
    if (ticketType.occurrence.status !== 'DRAFT') {
      throw new ConflictError('Ticket types are immutable after occurrence publication; create a new occurrence for a new sale configuration');
    }

    const values = await validateTicketTypeInput(tx, ticketType.occurrence, data, ticketType);
    const otherCurrency = await tx.ticketType.findFirst({
      where: { occurrenceId: ticketType.occurrenceId, id: { not: ticketTypeId }, status: { not: 'ARCHIVED' } },
      select: { currency: true },
    });
    if (otherCurrency && otherCurrency.currency !== values.currency) {
      throw new BadRequestError('All ticket types within an occurrence must use the same currency');
    }

    await tx.ticketTypeSection.deleteMany({ where: { ticketTypeId } });
    const updated = await tx.ticketType.update({
      where: { id: ticketTypeId },
      data: {
        name: values.name,
        code: values.code,
        description: values.description,
        mode: values.mode,
        priceMinorUnits: values.priceMinorUnits,
        currency: values.currency,
        capacity: values.capacity,
        minPerOrder: values.minPerOrder,
        maxPerOrder: values.maxPerOrder,
        salesStartsAt: values.salesStartsAt,
        salesEndsAt: values.salesEndsAt,
        version: { increment: 1 },
        sections: {
          create: values.sectionAllocations.map((entry) => ({
            venueSectionId: entry.sectionId,
            capacity: entry.capacity,
          })),
        },
      },
      include: { sections: true },
    });
    return { ...updated, priceMinorUnits: updated.priceMinorUnits.toString() };
  });
};

const validateReactivationCapacity = async (tx, occurrence, ticketType) => {
  if (ticketType.mode !== 'GENERAL_ADMISSION') return;
  if (!Number.isInteger(ticketType.capacity) || ticketType.capacity < 1 || !ticketType.sections.length) {
    throw new ConflictError('This GA ticket type has no valid section allocation and cannot be reactivated');
  }
  const snapshots = occurrence.layoutVersion?.snapshot?.sections || [];
  const otherAllocations = await tx.ticketTypeSection.findMany({
    where: {
      venueSectionId: { in: ticketType.sections.map((entry) => entry.venueSectionId) },
      ticketTypeId: { not: ticketType.id },
      ticketType: { occurrenceId: occurrence.id, status: { not: 'ARCHIVED' } },
    },
    select: { venueSectionId: true, capacity: true },
  });
  for (const allocation of ticketType.sections) {
    const section = snapshots.find((item) => item.id === allocation.venueSectionId);
    if (!section || !Number.isInteger(section.capacity) || !Number.isInteger(allocation.capacity)) {
      throw new ConflictError('This GA ticket type references a section without a valid capacity allocation');
    }
    const otherTotal = otherAllocations
      .filter((item) => item.venueSectionId === allocation.venueSectionId)
      .reduce((sum, item) => sum + (item.capacity || 0), 0);
    if (otherTotal + allocation.capacity > section.capacity) {
      throw new ConflictError(`Reactivating this ticket type would exceed the capacity of section ${section.name}`);
    }
  }
};

const updateTicketTypeStatus = async (ticketTypeId, userId, status) => {
  const initial = await prisma.ticketType.findUnique({
    where: { id: ticketTypeId },
    select: { occurrenceId: true },
  });
  if (!initial) throw new NotFoundError('Ticket type not found');
  if (!['ACTIVE', 'PAUSED', 'ARCHIVED'].includes(status)) {
    throw new BadRequestError('status must be ACTIVE, PAUSED, or ARCHIVED');
  }

  return prisma.$transaction(async (tx) => {
    await lockOccurrence(tx, initial.occurrenceId);
    const ticketType = await tx.ticketType.findUnique({
      where: { id: ticketTypeId },
      include: {
        occurrence: {
          include: {
            event: { select: { organizerId: true } },
            layoutVersion: { select: { snapshot: true } },
          },
        },
        sections: true,
      },
    });
    if (!ticketType) throw new NotFoundError('Ticket type not found');
    await assertOrganizerAccess(tx, ticketType.occurrence.event.organizerId, userId, ['OWNER', 'ADMIN']);

    // Idempotent no-op: avoid a version bump and duplicate event for repeated requests.
    if (ticketType.status === status) {
      return { ...ticketType, priceMinorUnits: ticketType.priceMinorUnits.toString() };
    }

    const occurrenceStatus = ticketType.occurrence.status;
    const isDraft = occurrenceStatus === 'DRAFT';

    if (isDraft) {
      if (status !== 'ARCHIVED' && ticketType.status === 'ARCHIVED') {
        await validateReactivationCapacity(tx, ticketType.occurrence, ticketType);
      }
    } else {
      // Published ticket configuration is immutable; only pause/resume is allowed
      // while new sales are still possible.
      if (!['SCHEDULED', 'ON_SALE'].includes(occurrenceStatus)) {
        throw new ConflictError('Ticket type sales cannot be changed after the occurrence sales window has closed or the occurrence is terminal');
      }
      if (!['ACTIVE', 'PAUSED'].includes(ticketType.status) || !['ACTIVE', 'PAUSED'].includes(status)) {
        throw new ConflictError('Published ticket types can only transition between ACTIVE and PAUSED');
      }
    }

    const changed = await tx.ticketType.updateMany({
      where: { id: ticketTypeId, version: ticketType.version },
      data: { status, version: { increment: 1 } },
    });
    if (!changed.count) {
      throw new ConflictError('Ticket type was modified by another request; reload it and retry');
    }

    const updated = await tx.ticketType.findUnique({ where: { id: ticketTypeId } });
    if (!isDraft) {
      await createOutboxEvent(tx, {
        aggregateType: 'TICKET_TYPE',
        aggregateId: updated.id,
        aggregateVersion: updated.version,
        eventType: KAFKA_TOPICS.EVENT_TICKET_TYPE_STATUS_CHANGED,
        data: {
          previousStatus: ticketType.status,
          occurrence: {
            id: ticketType.occurrence.id,
            eventId: ticketType.occurrence.eventId,
            status: ticketType.occurrence.status,
            version: ticketType.occurrence.version,
          },
          ticketType: {
            id: updated.id,
            occurrenceId: updated.occurrenceId,
            status: updated.status,
            version: updated.version,
          },
        },
      });
    }

    return { ...updated, priceMinorUnits: updated.priceMinorUnits.toString() };
  });
};

module.exports = {
  createTicketType,
  listTicketTypes,
  updateTicketType,
  updateTicketTypeStatus,
};
