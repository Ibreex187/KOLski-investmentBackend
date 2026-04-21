const router = require('express').Router();
const authMiddleware = require('../middleware/auth.middleware');
const validate = require('../middleware/express.validator.middleware');
const {
  approveManualDepositValidation,
  rejectManualDepositValidation,
  approveManualWithdrawalValidation,
  rejectManualWithdrawalValidation,
} = require('../validators/validation.rules');
const {
  getAdminOverview,
  getSecurityStatus,
  getAdminUsers,
  getAdminAlerts,
  getAdminTransactions,
} = require('../controllers/admin.controller');
const {
  listAdminManualDeposits,
  approveManualDeposit,
  rejectManualDeposit,
} = require('../controllers/manual.deposit.controller');
const {
  listAdminManualWithdrawals,
  approveManualWithdrawal,
  rejectManualWithdrawal,
} = require('../controllers/manual.withdrawal.controller');

const requireAdmin = typeof authMiddleware.requireRole === 'function'
  ? authMiddleware.requireRole('admin')
  : (req, res, next) => {
      if ((req.user?.role || 'user') !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: insufficient privileges' });
      }
      return next();
    };

router.get('/overview', authMiddleware, requireAdmin, getAdminOverview);
router.get('/security-status', authMiddleware, requireAdmin, getSecurityStatus);
router.get('/users', authMiddleware, requireAdmin, getAdminUsers);
router.get('/alerts', authMiddleware, requireAdmin, getAdminAlerts);
router.get('/transactions', authMiddleware, requireAdmin, getAdminTransactions);
router.get('/deposits', authMiddleware, requireAdmin, validate, listAdminManualDeposits);
router.post('/deposits/:id/approve', authMiddleware, requireAdmin, approveManualDepositValidation, validate, approveManualDeposit);
router.post('/deposits/:id/reject', authMiddleware, requireAdmin, rejectManualDepositValidation, validate, rejectManualDeposit);
router.get('/withdrawals', authMiddleware, requireAdmin, validate, listAdminManualWithdrawals);
router.post('/withdrawals/:id/approve', authMiddleware, requireAdmin, approveManualWithdrawalValidation, validate, approveManualWithdrawal);
router.post('/withdrawals/:id/reject', authMiddleware, requireAdmin, rejectManualWithdrawalValidation, validate, rejectManualWithdrawal);

module.exports = router;
