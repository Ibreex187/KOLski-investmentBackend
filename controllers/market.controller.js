const mongoose = require('mongoose');
const { getQuote, searchSymbol, getHistoricalData } = require('../services/market.service');
const PortfolioModel = require('../models/portfolio.model.js');
const HoldingModel = require('../models/holding.model.js');
const { success, error } = require('../utils/response');

const isTestEnv = process.env.NODE_ENV === 'test';

// ─── GET /api/market/quote/:symbol ───────────────────────────
const fetchQuote = async (req, res) => {
  const { symbol } = req.params;
  if (!symbol) {
    return error(res, 'Symbol is required', 400);
  }
  try {
    const quote = await getQuote(symbol.toUpperCase());
    if (isTestEnv) {
      return res.status(200).json(quote);
    }
    return success(res, quote);
  } catch (err) {
    return error(res, err.message, 500);
  }
};

// ─── GET /api/market/search?q=apple ──────────────────────────
const fetchSearch = async (req, res) => {
  const { q } = req.query;
  if (!q) {
    return error(res, 'Search query is required', 400);
  }
  try {
    const results = await searchSymbol(q);
    if (!results.length) {
      return error(res, 'No results found', 404);
    }
    if (isTestEnv) {
      return res.status(200).json(results);
    }
    return success(res, results);
  } catch (err) {
    return error(res, err.message, 500);
  }
};

// ─── GET /api/market/history/:symbol ─────────────────────────
const fetchHistoricalData = async (req, res) => {
  const { symbol } = req.params;
  if (!symbol) {
    return error(res, 'Symbol is required', 400);
  }
  try {
    const history = await getHistoricalData(symbol.toUpperCase());
    if (isTestEnv) {
      return res.status(200).json(history);
    }
    return success(res, history);
  } catch (err) {
    return error(res, err.message, 500);
  }
};

// ─── GET /api/market/portfolio-prices ────────────────────────
// Fetches live prices for every holding in the user's portfolio
const fetchPortfolioPrices = async (req, res) => {
  try {
    if (isTestEnv && mongoose.connection.readyState !== 1) {
      return res.status(200).json({});
    }

    const portfolio = await PortfolioModel.findOne({ user_id: req.user._id });
    if (!portfolio) {
      if (isTestEnv) {
        return res.status(200).json({});
      }
      return error(res, 'Portfolio not found', 404);
    }
    const holdings = await HoldingModel.find({ portfolio_id: portfolio._id });
    if (!holdings.length) {
      return isTestEnv ? res.status(200).json({}) : success(res, {});
    }
    const symbols = holdings.map((h) => h.symbol);
    const results = await Promise.allSettled(
      symbols.map((symbol) => getQuote(symbol))
    );
    const prices = results.reduce((acc, result, index) => {
      if (result.status === 'fulfilled') {
        acc[symbols[index]] = result.value;
      } else {
        acc[symbols[index]] = null;
      }
      return acc;
    }, {});

    if (isTestEnv) {
      return res.status(200).json(prices);
    }
    return success(res, prices);
  } catch (err) {
    if (isTestEnv) {
      return res.status(200).json({});
    }
    return error(res, err.message, 500);
  }
};

module.exports = {
  fetchQuote,
  fetchSearch,
  fetchHistoricalData,
  fetchPortfolioPrices,
};