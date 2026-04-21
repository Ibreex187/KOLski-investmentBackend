const router = require('express').Router();
const authMiddleware = require('../middleware/auth.middleware');
const validate = require('../middleware/express.validator.middleware');
const { deleteAlertValidation } = require('../validators/validation.rules');
const {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} = require('../controllers/notification.controller');

router.get('/', authMiddleware, listNotifications);
router.patch('/read-all', authMiddleware, markAllNotificationsRead);
router.patch('/:id/read', authMiddleware, deleteAlertValidation, validate, markNotificationRead);

module.exports = router;
