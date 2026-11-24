const test = require('node:test');
const assert = require('node:assert/strict');
const { validateOccurrenceTicketAllocations } = require('../src/utils/gaCapacity');

const snapshot = [
  { id: 'standing', name: 'Standing', mode: 'GENERAL_ADMISSION', capacity: 1000, seats: [] },
  { id: 'balcony', name: 'Balcony', mode: 'GENERAL_ADMISSION', capacity: 200, seats: [] },
];

test('accepts GA ticket tiers whose per-section allocations fit the shared section capacity', () => {
  assert.equal(validateOccurrenceTicketAllocations([
    { mode: 'GENERAL_ADMISSION', capacity: 700, sections: [{ venueSectionId: 'standing', capacity: 700 }] },
    { mode: 'GENERAL_ADMISSION', capacity: 300, sections: [{ venueSectionId: 'standing', capacity: 300 }] },
    { mode: 'GENERAL_ADMISSION', capacity: 200, sections: [{ venueSectionId: 'balcony', capacity: 200 }] },
  ], snapshot), true);
});

test('rejects GA ticket tiers that over-allocate one shared section', () => {
  assert.throws(() => validateOccurrenceTicketAllocations([
    { mode: 'GENERAL_ADMISSION', capacity: 700, sections: [{ venueSectionId: 'standing', capacity: 700 }] },
    { mode: 'GENERAL_ADMISSION', capacity: 400, sections: [{ venueSectionId: 'standing', capacity: 400 }] },
  ], snapshot), /Combined GA ticket-type allocations exceed/);
});

test('requires each GA tier capacity to equal its section-allocation sum', () => {
  assert.throws(() => validateOccurrenceTicketAllocations([
    { mode: 'GENERAL_ADMISSION', capacity: 500, sections: [{ venueSectionId: 'standing', capacity: 400 }] },
  ], snapshot), /sum exactly to its capacity/);
});

test('supports a tier split across multiple sections without duplicating capacity', () => {
  assert.equal(validateOccurrenceTicketAllocations([
    {
      mode: 'GENERAL_ADMISSION',
      capacity: 500,
      sections: [
        { venueSectionId: 'standing', capacity: 400 },
        { venueSectionId: 'balcony', capacity: 100 },
      ],
    },
  ], snapshot), true);
});

test('rejects GA allocations without a configured section capacity', () => {
  assert.throws(() => validateOccurrenceTicketAllocations([
    { mode: 'GENERAL_ADMISSION', capacity: 100, sections: [{ venueSectionId: 'unknown', capacity: 100 }] },
  ], snapshot), /without a published capacity/);
});
