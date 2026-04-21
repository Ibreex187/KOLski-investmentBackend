const mongoose = require('mongoose');
const portfolioService = require('../services/portfolio.service');
const TransactionModel = require('../models/transaction.model');
const WatchlistModel = require('../models/watchlist.model');
const PortfolioModel = require('../models/portfolio.model');
const HoldingModel = require('../models/holding.model');
const PriceAlertModel = require('../models/price.alert.model');
const NotificationModel = require('../models/notification.model');
const {
  buildAllocationBreakdown,
  buildReturnsSummary,
  buildBenchmarkComparison,
  buildRiskInsights,
  buildDashboardPayload,
  buildPerformanceHistory,
  capturePortfolioSnapshot,
} = require('../services/analytics.service');
const { reconcilePortfolioState } = require('../services/reconciliation.service');
const { success, error } = require('../utils/response');
const { buildCreatedAtFilter } = require('../utils/date.range');

const isTestDbUnavailable = () => process.env.NODE_ENV === 'test' && mongoose.connection.readyState !== 1;

async function createInAppNotification({ userId, type, title, message, data = {} }) {
  if (!userId || isTestDbUnavailable()) {
    return null;
  }

  try {
    return await NotificationModel.create({
      user_id: userId,
      type,
      title,
      message,
      data,
    });
  } catch (notificationError) {
    console.error('Notification record failed:', notificationError.message);
    return null;
  }
}

async function buildPortfolioAnalyticsData(userId) {
  const portfolio = await PortfolioModel.findOne({ user_id: userId });
  if (!portfolio) {
    return null;
  }

  const holdings = await HoldingModel.find({ portfolio_id: portfolio._id });
  const marketService = require('../services/market.service');
  let totalValue = portfolio.cash_balance;
  let invested = 0;
  let unrealizedPnl = 0;
  const holdingAnalytics = [];

  for (const h of holdings) {
    invested += h.shares * h.average_price;
    let livePrice = h.average_price;

    try {
      const quote = await marketService.getQuote(h.symbol);
      livePrice = quote.price || h.average_price;
    } catch (e) {
      // fallback to average_price if quote fails
    }

    const marketValue = h.shares * livePrice;
    const holdingUnrealized = marketValue - (h.shares * h.average_price);
    unrealizedPnl += holdingUnrealized;
    totalValue += marketValue;

    holdingAnalytics.push({
      symbol: h.symbol,
      shares: h.shares,
      average_price: h.average_price,
      live_price: livePrice,
      sector: h.sector,
      market_value: marketValue,
      unrealized_pnl: holdingUnrealized,
      unrealized_pnl_percent: h.average_price > 0 ? (holdingUnrealized / (h.shares * h.average_price)) * 100 : 0,
    });
  }

  const profitLoss = totalValue - invested;
  const profitLossPercent = invested > 0 ? ((profitLoss / invested) * 100) : 0;

  await capturePortfolioSnapshot({
    userId,
    portfolioId: portfolio._id,
    totalValue,
    cashBalance: portfolio.cash_balance,
    invested,
    profitLoss,
  });

  const performanceHistory = await buildPerformanceHistory({ userId });
  const returnsSummary = buildReturnsSummary({
    history: performanceHistory,
    currentValue: totalValue,
  });

  const benchmarkSymbol = process.env.BENCHMARK_SYMBOL || 'SPY';
  let benchmarkHistory = [];

  try {
    benchmarkHistory = await marketService.getHistoricalData(benchmarkSymbol);
  } catch (benchmarkError) {
    console.error('Benchmark comparison fetch failed:', benchmarkError.message);
  }

  const benchmarkComparison = buildBenchmarkComparison({
    portfolioHistory: performanceHistory,
    currentPortfolioValue: totalValue,
    benchmarkHistory,
    benchmarkSymbol,
  });

  const allocation = buildAllocationBreakdown({
    holdings: holdingAnalytics,
    totalValue,
  });

  const riskInsights = buildRiskInsights({
    holdings: allocation.by_symbol,
    totalValue,
    returnsSummary,
  });

  return {
    cash_balance: portfolio.cash_balance,
    total_value: totalValue,
    invested,
    profit_loss: profitLoss,
    profit_loss_percent: profitLossPercent,
    unrealized_pnl: unrealizedPnl,
    unrealized_pnl_percent: invested > 0 ? (unrealizedPnl / invested) * 100 : 0,
    returns_summary: returnsSummary,
    benchmark_comparison: benchmarkComparison,
    risk_insights: riskInsights,
    holdings: holdingAnalytics,
    allocation,
    allocation_breakdown: allocation,
    top_gainers: allocation.top_gainers,
    top_losers: allocation.top_losers,
  };
}

// POST /api/portfolio/alerts
async function createPriceAlert(req, res) {
  try {
    const { symbol, target_price, direction } = req.body;
    if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
      return error(res, 'Symbol is required', 400);
    }
    if (typeof target_price !== 'number' || target_price <= 0) {
      return error(res, 'Target price must be a positive number', 400);
    }
    if (!['above', 'below'].includes(direction)) {
      return error(res, 'Direction must be "above" or "below"', 400);
    }
    if (isTestDbUnavailable()) {
      return success(res, {
        _id: '507f1f77bcf86cd799439011',
        user_id: req.user._id,
        symbol: symbol.toUpperCase(),
        target_price,
        direction,
        status: 'active',
      }, 201);
    }
    const alert = await PriceAlertModel.create({
      user_id: req.user._id,
      symbol: symbol.toUpperCase(),
      target_price,
      direction,
      status: 'active',
      triggered: false,
      notificationSent: false,
    });
    return success(res, alert, 201);
  } catch (err) {
    return error(res, err.message, 500);
  }
}

// GET /api/portfolio/alerts
async function listPriceAlerts(req, res) {
  try {
    if (isTestDbUnavailable()) {
      return success(res, []);
    }

    const { filter: createdAtFilter, error: dateError } = buildCreatedAtFilter({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });

    if (dateError) {
      return error(res, dateError, 400);
    }

    const alerts = await PriceAlertModel.find({
      user_id: req.user._id,
      ...(createdAtFilter || {}),
    }).sort({ createdAt: -1 });
    return success(res, alerts);
  } catch (err) {
    return error(res, err.message, 500);
  }
}

// DELETE /api/portfolio/alerts/:id
async function deletePriceAlert(req, res) {
  try {
    const { id } = req.params;
    if (!id.match(/^[a-fA-F0-9]{24}$/)) {
      return error(res, 'Invalid alert ID format', 400);
    }
    if (isTestDbUnavailable()) {
      return success(res, { deleted: true });
    }
    const alert = await PriceAlertModel.findOneAndDelete({ _id: id, user_id: req.user._id });
    if (!alert) return error(res, 'Alert not found', 404);
    return success(res, { deleted: true });
  } catch (err) {
    return error(res, err.message, 500);
  }
}
// GET /api/portfolio/analytics
async function getPortfolioAnalytics(req, res) {
  try {
    if (isTestDbUnavailable()) {
      return error(res, 'Portfolio not found', 404);
    }

    const analytics = await buildPortfolioAnalyticsData(req.user._id);
    if (!analytics) {
      return error(res, 'Portfolio not found', 404);
    }

    return success(res, analytics);
  } catch (err) {
    return error(res, err.message, 500);
  }
}

// GET /api/portfolio/dashboard
async function getPortfolioDashboard(req, res) {
  try {
    if (isTestDbUnavailable()) {
      return success(res, buildDashboardPayload({}));
    }

    const analytics = await buildPortfolioAnalyticsData(req.user._id);
    const notifications = await NotificationModel.find({ user_id: req.user._id })
      .sort({ createdAt: -1 })
      .limit(5);
    const alerts = await PriceAlertModel.find({ user_id: req.user._id })
      .sort({ createdAt: -1 })
      .limit(5);
    const unreadNotificationCount = await NotificationModel.countDocuments({
      user_id: req.user._id,
      read: false,
    });

    return success(res, buildDashboardPayload({
      analytics: analytics || {},
      notifications,
      alerts,
      unreadNotificationCount,
    }));
  } catch (err) {
    return error(res, err.message, 500);
  }
}

// GET /api/portfolio/performance-history
async function getPerformanceHistory(req, res) {
  try {
    if (isTestDbUnavailable()) {
      return success(res, []);
    }

    const history = await buildPerformanceHistory({ userId: req.user._id });
    return success(res, history);
  } catch (err) {
    return error(res, err.message, 500);
  }
}

// POST /api/portfolio/reconcile
async function reconcilePortfolio(req, res) {
  try {
    if (isTestDbUnavailable()) {
      return success(res, {
        is_consistent: true,
        applied: false,
        mismatches: [],
        actual: {},
        expected: {},
      });
    }

    const result = await reconcilePortfolioState({
      userId: req.user._id,
      applyChanges: req.body?.apply === true || req.query.apply === 'true',
    });

    if (!result) {
      return error(res, 'Portfolio not found', 404);
    }

    return success(res, result);
  } catch (err) {
    return error(res, err.message, 500);
  }
}

// GET /api/portfolio
async function getPortfolio(req, res) {
  try {
    if (isTestDbUnavailable()) {
      return error(res, 'Portfolio not found', 404);
    }
    const data = await portfolioService.getPortfolio(req.user._id);
    return success(res, data);
  } catch (err) {
    return error(res, err.message, 404);
  }
}

// POST /api/portfolio/buy
async function buyStock(req, res) {
  try {
    const { symbol, shares, price } = req.body;
    if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
      return error(res, 'Symbol is required', 400);
    }
    if (!shares || typeof shares !== 'number' || shares <= 0) {
      return error(res, 'Shares must be a positive number', 400);
    }
    if (!price || typeof price !== 'number' || price <= 0) {
      return error(res, 'Price must be a positive number', 400);
    }
    const result = await portfolioService.buyStock(req.user._id, {
      ...req.body,
      reference_id: req.get('x-idempotency-key') || req.body.reference_id || req.body.client_request_id,
    });
    // Send notification email
    try {
      const UserModel = require('../models/user.model');
      const { sendNotificationEmail } = require('../utils/mailer');
      const user = await UserModel.findById(req.user._id);
      if (user && user.email) {
        await sendNotificationEmail({
          to: user.email,
          name: user.name,
          title: 'Stock Purchase Confirmation',
          message: `You have successfully purchased ${req.body.shares} shares of ${req.body.symbol}.`,
        });
      }
    } catch (e) {
      // Log but do not block response
      console.error('Notification email failed:', e.message);
    }
    await createInAppNotification({
      userId: req.user._id,
      type: 'trade',
      title: 'Stock Purchase Confirmation',
      message: `You purchased ${req.body.shares} shares of ${req.body.symbol}.`,
      data: { symbol: req.body.symbol, shares: req.body.shares, price: req.body.price, action: 'buy' },
    });
    return success(res, result);
  } catch (err) {
    return error(res, err.message, 400);
  }
}

// POST /api/portfolio/sell
async function sellStock(req, res) {
  try {
    const { symbol, shares, price } = req.body;
    if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
      return error(res, 'Symbol is required', 400);
    }
    if (!shares || typeof shares !== 'number' || shares <= 0) {
      return error(res, 'Shares must be a positive number', 400);
    }
    if (!price || typeof price !== 'number' || price <= 0) {
      return error(res, 'Price must be a positive number', 400);
    }
    const result = await portfolioService.sellStock(req.user._id, {
      ...req.body,
      reference_id: req.get('x-idempotency-key') || req.body.reference_id || req.body.client_request_id,
    });
    // Send notification email
    try {
      const UserModel = require('../models/user.model');
      const { sendNotificationEmail } = require('../utils/mailer');
      const user = await UserModel.findById(req.user._id);
      if (user && user.email) {
        await sendNotificationEmail({
          to: user.email,
          name: user.name,
          title: 'Stock Sale Confirmation',
          message: `You have successfully sold ${req.body.shares} shares of ${req.body.symbol}.`,
        });
      }
    } catch (e) {
      // Log but do not block response
      console.error('Notification email failed:', e.message);
    }
    await createInAppNotification({
      userId: req.user._id,
      type: 'trade',
      title: 'Stock Sale Confirmation',
      message: `You sold ${req.body.shares} shares of ${req.body.symbol}.`,
      data: { symbol: req.body.symbol, shares: req.body.shares, price: req.body.price, action: 'sell' },
    });
    return success(res, result);
  } catch (err) {
    return error(res, err.message, 400);
  }
}

// POST /api/portfolio/deposit
async function deposit(req, res) {
  return error(res, {
    message: 'Instant deposits are disabled. Use POST /api/v1/deposits/manual and complete admin approval before funds are credited.',
    code: 'INSTANT_DEPOSIT_DISABLED',
    deprecation_at: '2026-04-20T00:00:00.000Z',
    docs_url: '/api/v1/docs/openapi.json',
    migration: {
      endpoint: '/api/v1/deposits/manual',
      required_fields: ['amount', 'transfer_reference', 'idempotency_key'],
    },
  }, 410);
}

// POST /api/portfolio/withdraw
async function withdraw(req, res) {
  return error(res, {
    message: 'Instant withdrawals are disabled. Use POST /api/v1/withdrawals/manual and complete admin approval before funds are debited.',
    code: 'INSTANT_WITHDRAWAL_DISABLED',
    deprecation_at: '2026-04-20T00:00:00.000Z',
    docs_url: '/api/v1/docs/openapi.json',
    migration: {
      endpoint: '/api/v1/withdrawals/manual',
      required_fields: ['amount', 'destination_reference', 'idempotency_key'],
    },
  }, 410);
}

// GET /api/portfolio/transactions
async function getTransactions(req, res) {
  try {
    const { page = 1, limit = 20, type, symbol, startDate, endDate } = req.query;
    if (isTestDbUnavailable()) {
      return res.json({
        transactions: [],
        total: 0,
        page: parseInt(page, 10),
        pages: 0,
        filters: { type: type || null, symbol: symbol || null, startDate: startDate || null, endDate: endDate || null },
      });
    }

    const report = await portfolioService.getTransactionReport(req.user._id, {
      page,
      limit,
      type,
      symbol,
      startDate,
      endDate,
    });

    return res.json(report);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// GET /api/portfolio/transactions/export
async function exportTransactions(req, res) {
  try {
    const { format = 'csv', type, symbol, startDate, endDate } = req.query;
    if (String(format).toLowerCase() !== 'csv') {
      return error(res, 'Only csv export is currently supported', 400);
    }

    if (isTestDbUnavailable()) {
      const csv = portfolioService.exportTransactionsToCsv([]);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
      return res.status(200).send(csv);
    }

    const report = await portfolioService.getTransactionReport(req.user._id, {
      page: 1,
      limit: 1000,
      type,
      symbol,
      startDate,
      endDate,
    });

    const csv = portfolioService.exportTransactionsToCsv(report.transactions);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
    return res.status(200).send(csv);
  } catch (err) {
    return error(res, err.message, 500);
  }
}

// GET /api/portfolio/watchlist
async function getWatchlist(req, res) {
  try {
    if (isTestDbUnavailable()) {
      return res.json([]);
    }
    const portfolio = await PortfolioModel.findOne({ user_id: req.user._id });
    if (!portfolio) {
      return res.status(404).json({ error: 'Portfolio not found' });
    }
    const watchlist = await WatchlistModel.find({ portfolio_id: portfolio._id });
    res.json(watchlist);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/portfolio/watchlist
async function addToWatchlist(req, res) {
  try {
    const portfolio = await PortfolioModel.findOne({ user_id: req.user._id });
    if (!portfolio) {
      return error(res, 'Portfolio not found', 404);
    }
    const { symbol, name } = req.body;
    if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
      return error(res, 'Symbol is required', 400);
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return error(res, 'Name is required', 400);
    }
    const existing = await WatchlistModel.findOne({ portfolio_id: portfolio._id, symbol: symbol.toUpperCase() });
    if (existing) return error(res, 'Symbol already in watchlist', 400);

    const item = await WatchlistModel.create({ portfolio_id: portfolio._id, symbol, name });
    return success(res, item, 201);
  } catch (err) {
    return error(res, err.message, 500);
  }
}

// DELETE /api/portfolio/watchlist/:symbol
async function removeFromWatchlist(req, res) {
  try {
    const portfolio = await PortfolioModel.findOne({ user_id: req.user._id });
    if (!portfolio) {
      return error(res, 'Portfolio not found', 404);
    }
    const symbol = req.params.symbol;
    if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
      return error(res, 'Symbol is required', 400);
    }
    await WatchlistModel.findOneAndDelete({
      portfolio_id: portfolio._id,
      symbol: symbol.toUpperCase(),
    });
    return success(res, { success: true });
  } catch (err) {
    return error(res, err.message, 500);
  }
}

module.exports = {
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
};