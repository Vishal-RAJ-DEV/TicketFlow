const { BadRequestError, ConflictError } = require('./error');

/**
 * Check that every GA ticket type divides its total capacity across explicit
 * section allocations and that all tiers share no more than the section cap.
 */
const validateOccurrenceTicketAllocations = (ticketTypes, snapshotSections) => {
  const sectionCapacities = new Map(
    (snapshotSections || []).map((section) => [section.id, section.capacity])
  );
  const allocatedBySection = new Map();

  for (const ticketType of ticketTypes) {
    if (ticketType.mode === 'GENERAL_ADMISSION') {
      const mappings = ticketType.sections || [];
      const totalAllocated = mappings.reduce((sum, mapping) => sum + (mapping.capacity || 0), 0);
      if (
        mappings.length === 0 ||
        mappings.some((mapping) => !Number.isInteger(mapping.capacity) || mapping.capacity < 1) ||
        totalAllocated !== ticketType.capacity
      ) {
        throw new BadRequestError('Every active GA ticket type must have section allocations that sum exactly to its capacity');
      }

      for (const mapping of mappings) {
        const sectionCapacity = sectionCapacities.get(mapping.venueSectionId);
        if (!Number.isInteger(sectionCapacity) || sectionCapacity < 1 || mapping.capacity > sectionCapacity) {
          throw new BadRequestError('A GA allocation exceeds or references a section without a published capacity');
        }
        const allocated = (allocatedBySection.get(mapping.venueSectionId) || 0) + mapping.capacity;
        if (allocated > sectionCapacity) {
          throw new ConflictError('Combined GA ticket-type allocations exceed a venue section capacity');
        }
        allocatedBySection.set(mapping.venueSectionId, allocated);
      }
    } else if (ticketType.mode === 'ASSIGNED') {
      if (
        ticketType.capacity !== null ||
        (ticketType.sections || []).some((mapping) => mapping.capacity !== null)
      ) {
        throw new BadRequestError('Assigned-seat ticket types must not define GA capacity allocations');
      }
    } else {
      throw new BadRequestError('Ticket type has an unsupported inventory mode');
    }
  }

  return true;
};

module.exports = { validateOccurrenceTicketAllocations };
