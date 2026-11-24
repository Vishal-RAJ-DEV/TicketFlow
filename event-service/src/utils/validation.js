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

const optionalUrl = (value, field, maxLength = 1000) => {
  const normalized = optionalString(value, field, maxLength);
  if (normalized === undefined || normalized === null) return normalized;
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new BadRequestError(field + ' must be a valid absolute URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new BadRequestError(field + ' must use HTTP or HTTPS and must not contain credentials');
  }
  return url.toString();
};

const parseDate = (value, field) => {
  const match = typeof value === 'string'
    ? value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/i)
    : null;
  if (!match) {
    throw new BadRequestError(field + ' must be an ISO-8601 date-time with a timezone');
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', fractionText = '', zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth ||
    hour > 23 || minute > 59 || second > 59
  ) {
    throw new BadRequestError(field + ' must be a valid calendar date and time');
  }

  if (zone.toUpperCase() !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) {
      throw new BadRequestError(field + ' must use a valid ISO-8601 timezone offset');
    }
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
  } catch {
    throw new BadRequestError(field + ' must fit in a non-negative PostgreSQL BIGINT');
  }
};

const parsePositiveInteger = (value, field, max = 1000000) => {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new BadRequestError(field + ' must be a positive integer no greater than ' + max);
  }
  return value;
};

const CURRENCY_CODES = new Set(
  typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('currency')
    : ['INR', 'USD', 'EUR', 'GBP', 'JPY']
);

const normalizeCurrency = (value = 'INR') => {
  const currency = requireString(value, 'currency', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency) || !CURRENCY_CODES.has(currency)) {
    throw new BadRequestError('currency must be a supported ISO 4217 currency code');
  }
  return currency;
};

const validateTimezone = (timezone) => {
  const value = requireString(timezone, 'timezone', 100);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new BadRequestError('timezone must be a valid IANA timezone');
  }
  return value;
};

const slugify = (value) => {
  const normalized = value.normalize('NFKD').toLowerCase().trim();
  let slug = '';
  let pendingSeparator = false;

  // One pass avoids ambiguous repeated regex matching on attacker-controlled input.
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    const isAsciiLetter = code >= 97 && code <= 122;
    const isAsciiDigit = code >= 48 && code <= 57;

    if (isAsciiLetter || isAsciiDigit) {
      if (pendingSeparator && slug.length > 0) slug += '-';
      slug += character;
      pendingSeparator = false;
    } else if (slug.length > 0) {
      pendingSeparator = true;
    }
  }

  return slug.slice(0, 80) || 'event';
};

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
  optionalUrl,
  parseDate,
  parseMinorUnits,
  parsePositiveInteger,
  normalizeCurrency,
  validateTimezone,
  slugify,
  validateTimeWindow,
};
