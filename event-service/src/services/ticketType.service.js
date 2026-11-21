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

const lockOccurrence = async (tx, occurrenceId) => {
  // All ticket configuration mutations serialize with occurrence publication.
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

  const capacity = data.capacity !== undefined ? data.capacity : existing.capacity;
  if (mode === 'GENERAL_ADMISSION') {
    parsePositiveInteger(capacity, 'capacity', 10000000);
  } else if (capacity !== undefined && capacity !== null) {
    throw new BadRequestError('capacity must be omitted for assigned-seating ticket types');
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

  const sectionIds = data.sectionIds !== undefined
    ? data.sectionIds
    : (existing.sections || []).map((section) => section.venueSectionId);
  if (!Array.isArray(sectionIds) || sectionIds.length < 1) {
    throw new BadRequestError('At least one eligible sectionId is required');
  }
  if (new Set(sectionIds).size !== sectionIds.length) {
    throw new BadRequestError('sectionIds must not contain duplicates');
  }

  const snapshotSections = occurrence.layoutVersion.snapshot?.sections || [];
  const selectedSnapshotSections = sectionIds.map((sectionId) =>
    snapshotSections.find((section) => section.id === sectionId)
  );
  if (selectedSnapshotSections.some((section) => !section)) {
    throw new BadRequestError('Every selected section must belong to the occurrence layout version');
  }
  if (selectedSnapshotSections.some((section) => section.mode !== mode)) {
    throw new BadRequestError('Ticket type mode must match the mode of every eligible venue section');
  }
  if (mode === 'ASSIGNED' && selectedSnapshotSections.some((section) => !section.seats.length)) {
    throw new BadRequestError('Assigned ticket types require sections with seats');
  }
  if (mode === 'GENERAL_ADMISSION' && selectedSnapshotSections.some((section) => section.seats.length)) {
    throw new BadRequestError('General-admission ticket types cannot target sections with individual seats');
  }

  const sections = await client.venueSection.findMany({
    where: { id: { in: sectionIds }, venueId: occurrence.venueId },
    select: { id: true },
  });
  if (sections.length !== sectionIds.length) {
    throw new BadRequestError('One or more selected venue sections do not belong to this venue');
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
    capacity: mode === 'GENERAL_ADMISSION' ? capacity : null,
    minPerOrder,
    maxPerOrder,
    salesStartsAt,
    salesEndsAt,
    sectionIds,
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
      sections: { create: values.sectionIds.map((venueSectionId) => ({ venueSectionId })) },
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
        sections: { create: values.sectionIds.map((venueSectionId) => ({ venueSectionId })) },
      },
      include: { sections: true },
    });
    return { ...updated, priceMinorUnits: updated.priceMinorUnits.toString() };
  });
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
      include: { occurrence: { include: { event: { select: { organizerId: true } } } } },
    });
    if (!ticketType) throw new NotFoundError('Ticket type not found');
    await assertOrganizerAccess(tx, ticketType.occurrence.event.organizerId, userId, ['OWNER', 'ADMIN']);
    if (ticketType.occurrence.status !== 'DRAFT') {
      throw new ConflictError('Ticket type status cannot be changed after occurrence publication');
    }

    const updated = await tx.ticketType.update({
      where: { id: ticketTypeId },
      data: { status, version: { increment: 1 } },
    });
    return { ...updated, priceMinorUnits: updated.priceMinorUnits.toString() };
  });
};

module.exports = {
  createTicketType,
  listTicketTypes,
  updateTicketType,
  updateTicketTypeStatus,
};
