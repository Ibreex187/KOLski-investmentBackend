const router = require('express').Router();
const { demoLoginLimiter } = require('../middleware/rateLimit.middleware');
const { demoLogin } = require('../controllers/demo.controller');

router.post('/demo/login', demoLoginLimiter, demoLogin);

module.exports = router;
