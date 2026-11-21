const { BadRequestError } = require('./error');

const requireString = (value, field, maxLength = 255) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestError(field + ' is required');
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new BadRequestError(field + ' must be at most ' + maxLength + ' characters');
  }
  return normalized;
};

const optionalString = (value, field, maxLength = 2000) => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return requireString(value, field, maxLength);
};

const parseDate = (value, field) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new BadRequestError(field + ' must be an ISO-8601 date-time with a timezone');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError(field + ' must be a valid ISO-8601 date-time');
  }
  return date;
};

const parseMinorUnits = (value, field = 'priceMinorUnits') => {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new BadRequestError(field + ' must be a non-negative safe integer');
  }
  if (typeof value === 'string' && !/^(0|[1-9]\d*)$/.test(value)) {
    throw new BadRequestError(field + ' must be a non-negative integer string');
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new BadRequestError(field + ' must be supplied as integer minor currency units');
  }
  try {
    const amount = BigInt(value);
    if (amount < 0n || amount > 9223372036854775807n) throw new Error('out of range');
    return amount;
  } catch (error) {
    throw new BadRequestError(field + ' must fit in a non-negative PostgreSQL BIGINT');
  }
};

const parsePositiveInteger = (value, field, max = 1000000) => {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new BadRequestError(field + ' must be a positive integer no greater than ' + max);
  }
  return value;
};

const normalizeCurrency = (value = 'INR') => {
  const currency = requireString(value, 'currency', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new BadRequestError('currency must be a three-letter currency code');
  }
  return currency;
};

const validateTimezone = (timezone) => {
  const value = requireString(timezone, 'timezone', 100);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch (error) {
    throw new BadRequestError('timezone must be a valid IANA timezone');
  }
  return value;
};

const slugify = (value) => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80) || 'event';

const validateTimeWindow = (start, end, startField, endField) => {
  const startDate = parseDate(start, startField);
  const endDate = parseDate(end, endField);
  if (endDate <= startDate) {
    throw new BadRequestError(endField + ' must be after ' + startField);
  }
  return { startDate, endDate };
};

module.exports = {
  requireString,
  optionalString,
  parseDate,
  parseMinorUnits,
  parsePositiveInteger,
  normalizeCurrency,
  validateTimezone,
  slugify,
  validateTimeWindow,
};