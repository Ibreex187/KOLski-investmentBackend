const router = require('express').Router();
const authMiddleware = require('../middleware/auth.middleware');
const {
  fetchQuote,
  fetchSearch,
  fetchHistoricalData,
  fetchPortfolioPrices,
} = require('../controllers/market.controller');

// GET /api/market/quote/:symbol
router.get('/quote/:symbol', authMiddleware, fetchQuote);

// GET /api/market/search
router.get('/search', authMiddleware, fetchSearch);

// GET /api/market/history/:symbol
router.get('/history/:symbol', authMiddleware, fetchHistoricalData);

// GET /api/market/portfolio-prices
router.get('/portfolio-prices', authMiddleware, fetchPortfolioPrices);

module.exports = router;
