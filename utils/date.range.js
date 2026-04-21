function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function buildCreatedAtFilter({ startDate, endDate, field = 'createdAt' } = {}) {
  if (!startDate && !endDate) {
    return { filter: null, error: null };
  }

  const start = parseDate(startDate);
  if (startDate && !start) {
    return { filter: null, error: 'Invalid startDate. Use ISO date format (YYYY-MM-DD).' };
  }

  const end = parseDate(endDate);
  if (endDate && !end) {
    return { filter: null, error: 'Invalid endDate. Use ISO date format (YYYY-MM-DD).' };
  }

  if (start && end && start > end) {
    return { filter: null, error: 'startDate cannot be later than endDate.' };
  }

  const range = {};
  if (start) {
    range.$gte = start;
  }

  if (end) {
    const inclusiveEnd = new Date(end);
    inclusiveEnd.setUTCHours(23, 59, 59, 999);
    range.$lte = inclusiveEnd;
  }

  return {
    filter: { [field]: range },
    error: null,
  };
}

module.exports = {
  buildCreatedAtFilter,
};
