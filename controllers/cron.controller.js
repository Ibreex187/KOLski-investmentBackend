const { processActiveAlerts } = require('../services/alert.service');
const { success, error } = require('../utils/response');

// GET|POST /api/v1/internal/cron/check-alerts
// Runs one alert-checking pass. Returns counts only, never alert or user data.
async function checkAlerts(req, res) {
  try {
    const summary = await processActiveAlerts();
    return success(res, summary);
  } catch (err) {
    console.error('Cron alert check failed:', err);
    return error(res, 'Alert check failed', 500);
  }
}

module.exports = { checkAlerts };
