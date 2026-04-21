
const router = require('express').Router();
const authMiddleware  = require('../middleware/auth.middleware');
const validate = require('../middleware/express.validator.middleware');
const { createAlertValidation, deleteAlertValidation } = require('../validators/validation.rules');
const {
  getPortfolio,
  buyStock,
  sellStock,
  deposit,
  withdraw,
  getTransactions,
  exportTransactions,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getPortfolioAnalytics,
  getPortfolioDashboard,
  getPerformanceHistory,
  reconcilePortfolio,
  createPriceAlert,
  listPriceAlerts,
  deletePriceAlert,
} = require('../controllers/portfolio.controller');


// Portfolio analytics
router.get('/dashboard', authMiddleware, validate, getPortfolioDashboard);
router.get('/analytics', authMiddleware, validate, getPortfolioAnalytics);
router.get('/performance-history', authMiddleware, validate, getPerformanceHistory);
router.post('/reconcile', authMiddleware, validate, reconcilePortfolio);

// Price alert endpoints
router.post('/alerts', authMiddleware, createAlertValidation, validate, createPriceAlert);
router.get('/alerts', authMiddleware, validate, listPriceAlerts);
router.delete('/alerts/:id', authMiddleware, deleteAlertValidation, validate, deletePriceAlert);

router.get('/',                        authMiddleware, validate, getPortfolio);
router.post('/buy',                    authMiddleware, validate, buyStock);
router.post('/sell',                   authMiddleware, validate, sellStock);
router.post('/deposit',                authMiddleware, validate, deposit);
router.post('/withdraw',               authMiddleware, validate, withdraw);
router.get('/transactions/export',     authMiddleware, validate, exportTransactions);
router.get('/transactions',            authMiddleware, validate, getTransactions);
router.get('/watchlist',               authMiddleware, validate, getWatchlist);
router.post('/watchlist',              authMiddleware, validate, addToWatchlist);
router.delete('/watchlist/:symbol',    authMiddleware, validate, removeFromWatchlist);

module.exports = router;