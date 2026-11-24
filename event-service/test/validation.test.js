const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseMinorUnits,
  parseDate,
  parsePositiveInteger,
  normalizeCurrency,
  validateTimeWindow,
  slugify,
  optionalUrl,
} = require('../src/utils/validation');

test('parses integer minor currency units without floating point', () => {
  assert.equal(parseMinorUnits(12500), 12500n);
  assert.equal(parseMinorUnits('9007199254740993'), 9007199254740993n);
  assert.throws(() => parseMinorUnits(12.5), /safe integer/);
  assert.throws(() => parseMinorUnits(-1), /non-negative/);
  assert.throws(() => parseMinorUnits('9223372036854775808'), /PostgreSQL BIGINT/);
});

test('validates positive purchase limits', () => {
  assert.equal(parsePositiveInteger(6, 'maxPerOrder'), 6);
  assert.throws(() => parsePositiveInteger(0, 'maxPerOrder'), /positive integer/);
});

test('normalizes and validates currency', () => {
  assert.equal(normalizeCurrency('inr'), 'INR');
  assert.throws(() => normalizeCurrency('IN'), /ISO 4217/);
  assert.throws(() => normalizeCurrency('ZZZ'), /ISO 4217/);
});

test('requires explicit timezone offsets for date-time inputs', () => {
  assert.equal(parseDate('2026-12-01T10:00:00+05:30', 'startsAt').toISOString(), '2026-12-01T04:30:00.000Z');
  assert.throws(() => parseDate('2026-12-01T10:00:00', 'startsAt'), /with a timezone/);
  assert.throws(() => parseDate('2026-12-01', 'startsAt'), /with a timezone/);
});

test('validates chronological time windows', () => {
  const result = validateTimeWindow('2026-12-01T10:00:00Z', '2026-12-01T12:00:00Z', 'start', 'end');
  assert.ok(result.endDate > result.startDate);
  assert.throws(() => validateTimeWindow('2026-12-01T12:00:00Z', '2026-12-01T10:00:00Z', 'start', 'end'), /must be after/);
});

test('slugifies very long separator runs in linear time without regex backtracking', () => {
  const input = 'A'.repeat(64) + '-'.repeat(200000) + 'B';
  assert.equal(slugify(input), 'a'.repeat(64) + '-b');
  assert.equal(slugify('---Café---Music---'), 'cafe-music');
  assert.equal(slugify('CaféMusic'), 'cafemusic');
});

test('creates URL-safe slugs and normalizes accents', () => {
  assert.equal(slugify('Live Music & Arts Festival'), 'live-music-arts-festival');
  assert.equal(slugify('Café Music & Arts'), 'cafe-music-arts');
});
test('rejects normalized impossible calendar dates and invalid timezone offsets', () => {
  assert.throws(() => parseDate('2026-02-30T10:00:00Z', 'startsAt'), /valid calendar date/);
  assert.throws(() => parseDate('2025-02-29T10:00:00Z', 'startsAt'), /valid calendar date/);
  assert.throws(() => parseDate('2026-12-01T10:00:00+14:30', 'startsAt'), /valid ISO-8601 timezone offset/);
  assert.equal(parseDate('2024-02-29T10:00:00Z', 'startsAt').toISOString(), '2024-02-29T10:00:00.000Z');
});

test('accepts only absolute HTTP and HTTPS URLs without embedded credentials', () => {
  assert.equal(optionalUrl('https://cdn.example.com/poster.png', 'posterImageUrl'), 'https://cdn.example.com/poster.png');
  assert.throws(() => optionalUrl('javascript:alert(1)', 'posterImageUrl'), /HTTP or HTTPS/);
  assert.throws(() => optionalUrl('https://user:pass@example.com/image.png', 'posterImageUrl'), /must not contain credentials/);
  assert.throws(() => optionalUrl('/relative/image.png', 'posterImageUrl'), /absolute URL/);
});
