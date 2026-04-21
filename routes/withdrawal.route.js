const router = require('express').Router();
const authMiddleware = require('../middleware/auth.middleware');
const validate = require('../middleware/express.validator.middleware');
const {
  createManualWithdrawalValidation,
  manualWithdrawalIdValidation,
} = require('../validators/validation.rules');
const {
  createManualWithdrawal,
  getMyManualWithdrawals,
  getMyManualWithdrawalById,
} = require('../controllers/manual.withdrawal.controller');

router.post('/withdrawals/manual', authMiddleware, createManualWithdrawalValidation, validate, createManualWithdrawal);
router.get('/withdrawals', authMiddleware, validate, getMyManualWithdrawals);
router.get('/withdrawals/:id', authMiddleware, manualWithdrawalIdValidation, validate, getMyManualWithdrawalById);

module.exports = router;
