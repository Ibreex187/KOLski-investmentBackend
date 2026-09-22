const { processActiveAlerts } = require('../services/alert.service');
const { resetDemoAccount } = require('../services/demo.service');
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

// GET|POST /api/v1/internal/cron/reset-demo
// Wipes and reseeds the shared public demo account. Returns ids only.
async function resetDemo(req, res) {
  try {
    const result = await resetDemoAccount();
    return success(res, result);
  } catch (err) {
    console.error('Demo reset failed:', err);
    return error(res, 'Demo reset failed', 500);
  }
}

module.exports = { checkAlerts, resetDemo };
