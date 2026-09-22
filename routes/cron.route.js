const router = require('express').Router();
const requireCronSecret = require('../middleware/cron.auth.middleware');
const { checkAlerts } = require('../controllers/cron.controller');

// Vercel Cron issues GET requests; other schedulers commonly use POST.
router.get('/check-alerts', requireCronSecret, checkAlerts);
router.post('/check-alerts', requireCronSecret, checkAlerts);

module.exports = router;
