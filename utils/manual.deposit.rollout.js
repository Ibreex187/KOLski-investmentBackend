function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function buildManualDepositRolloutStatus(now = new Date(), env = process.env) {
  const rawFlag = env.MANUAL_DEPOSITS_ENABLED;
  const baseEnabled = rawFlag === undefined ? true : rawFlag === 'true';

  const startDate = parseDate(env.MANUAL_DEPOSITS_WINDOW_START);
  const endDate = parseDate(env.MANUAL_DEPOSITS_WINDOW_END);

  if (!baseEnabled) {
    return {
      enabled: false,
      reason: 'MANUAL_DEPOSITS_ENABLED is disabled',
      window_start: startDate ? startDate.toISOString() : null,
      window_end: endDate ? endDate.toISOString() : null,
    };
  }

  if (startDate && now < startDate) {
    return {
      enabled: false,
      reason: 'Manual deposits are not active yet for the rollout window',
      window_start: startDate.toISOString(),
      window_end: endDate ? endDate.toISOString() : null,
    };
  }

  if (endDate && now > endDate) {
    return {
      enabled: false,
      reason: 'Manual deposits are outside the rollout window',
      window_start: startDate ? startDate.toISOString() : null,
      window_end: endDate.toISOString(),
    };
  }

  return {
    enabled: true,
    reason: null,
    window_start: startDate ? startDate.toISOString() : null,
    window_end: endDate ? endDate.toISOString() : null,
  };
}

module.exports = {
  buildManualDepositRolloutStatus,
};
