const router = require('express').Router();
const authMiddleware = require('../middleware/auth.middleware');
const validate = require('../middleware/express.validator.middleware');
const {
  createManualDepositValidation,
  manualDepositIdValidation,
} = require('../validators/validation.rules');
const {
  createManualDeposit,
  getMyManualDeposits,
  getMyManualDepositById,
} = require('../controllers/manual.deposit.controller');

router.post('/deposits/manual', authMiddleware, createManualDepositValidation, validate, createManualDeposit);
router.get('/deposits', authMiddleware, validate, getMyManualDeposits);
router.get('/deposits/:id', authMiddleware, manualDepositIdValidation, validate, getMyManualDepositById);

module.exports = router;
