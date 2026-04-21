const mongoose = require('mongoose');
const PortfolioModel = require('../models/portfolio.model');
const HoldingModel = require('../models/holding.model');
const TransactionModel = require('../models/transaction.model');

function toMoney(value) {
  return parseFloat(Number(value || 0).toFixed(2));
}

function normalizeSymbol(symbol) {
  return String(symbol || '').toUpperCase();
}

function extractReferenceId(payload = {}) {
  return payload.reference_id || payload.referenceId || payload.client_request_id || payload.idempotency_key || null;
}

function isTransactionSupportError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('replica set') || message.includes('transaction numbers are only allowed');
}

async function runWithOptionalTransaction(work) {
  const canUseTransaction = mongoose.connection.readyState === 1 && typeof mongoose.startSession === 'function';
  if (!canUseTransaction) {
    return work(null);
  }

  const session = await mongoose.startSession();
  try {
    if (typeof session.withTransaction === 'function') {
      let result;
      try {
        await session.withTransaction(async () => {
          result = await work(session);
        });
        return result;
      } catch (error) {
        if (isTransactionSupportError(error)) {
          return work(null);
        }
        throw error;
      }
    }

    return work(session);
  } finally {
    if (typeof session.endSession === 'function') {
      await session.endSession();
    }
  }
}

async function findOneWithSession(model, filter, session) {
  const query = model.findOne(filter);
  if (session && query && typeof query.session === 'function') {
    return query.session(session);
  }
  return query;
}

async function saveWithSession(document, session) {
  if (session) {
    return document.save({ session });
  }
  return document.save();
}

async function createWithSession(model, payload, session) {
  if (session) {
    const docs = await model.create([payload], { session });
    return Array.isArray(docs) ? docs[0] : docs;
  }
  return model.create(payload);
}

async function deleteWithSession(document, session) {
  if (session) {
    return document.deleteOne({ session });
  }
  return document.deleteOne();
}

async function findExistingCompletedTransaction(userId, referenceId, session = null) {
  if (!referenceId) {
    return null;
  }

  return findOneWithSession(TransactionModel, {
    userId,
    reference_id: referenceId,
    status: 'completed',
  }, session);
}

// Get full portfolio with holdings
async function getPortfolio(userId) {
  const portfolio = await PortfolioModel.findOne({ user_id: userId });
  if (!portfolio) throw new Error('Portfolio not found');

  const holdings = await HoldingModel.find({ portfolio_id: portfolio._id });

  return { portfolio, holdings };
}

// Buy stock
async function buyStock(userId, payload = {}) {
  const { symbol, name, shares, price, sector, logoUrl } = payload;
  const referenceId = extractReferenceId(payload);

  return runWithOptionalTransaction(async (session) => {
    const duplicateTx = await findExistingCompletedTransaction(userId, referenceId, session);
    if (duplicateTx) {
      const existingPortfolio = await findOneWithSession(PortfolioModel, { user_id: userId }, session);
      return {
        success: true,
        duplicate: true,
        reference_id: referenceId,
        transaction_id: duplicateTx._id,
        newBalance: existingPortfolio?.cash_balance ?? null,
      };
    }

    const portfolio = await findOneWithSession(PortfolioModel, { user_id: userId }, session);
    if (!portfolio) throw new Error('Portfolio not found');
    if (!symbol) throw new Error('Symbol is required');

    const normalizedSymbol = normalizeSymbol(symbol);
    const cost = toMoney(shares * price);
    if (portfolio.cash_balance < cost) throw new Error('Insufficient funds');

    portfolio.cash_balance = toMoney(portfolio.cash_balance - cost);
    portfolio.last_updated = new Date();
    await saveWithSession(portfolio, session);

    const existing = await findOneWithSession(HoldingModel, { portfolio_id: portfolio._id, symbol: normalizedSymbol }, session);
    if (existing) {
      const totalShares = existing.shares + shares;
      existing.average_price = toMoney(((existing.average_price * existing.shares) + cost) / totalShares);
      existing.shares = totalShares;
      await saveWithSession(existing, session);
    } else {
      await createWithSession(HoldingModel, {
        portfolio_id: portfolio._id,
        symbol: normalizedSymbol,
        name: name || normalizedSymbol,
        shares,
        average_price: price,
        sector,
        logo_url: logoUrl,
      }, session);
    }

    const transaction = await createWithSession(TransactionModel, {
      userId,
      symbol: normalizedSymbol,
      type: 'buy',
      shares,
      price,
      total: cost,
      status: 'completed',
      reference_id: referenceId,
      metadata: { name, sector, logo_url: logoUrl },
    }, session);

    return {
      success: true,
      newBalance: portfolio.cash_balance,
      reference_id: referenceId,
      transaction_id: transaction._id,
    };
  });
}

// Sell stock
async function sellStock(userId, payload = {}) {
  const { symbol, shares, price } = payload;
  const referenceId = extractReferenceId(payload);

  return runWithOptionalTransaction(async (session) => {
    const duplicateTx = await findExistingCompletedTransaction(userId, referenceId, session);
    if (duplicateTx) {
      const existingPortfolio = await findOneWithSession(PortfolioModel, { user_id: userId }, session);
      return {
        success: true,
        duplicate: true,
        reference_id: referenceId,
        transaction_id: duplicateTx._id,
        newBalance: existingPortfolio?.cash_balance ?? null,
      };
    }

    const portfolio = await findOneWithSession(PortfolioModel, { user_id: userId }, session);
    if (!portfolio) throw new Error('Portfolio not found');

    const normalizedSymbol = normalizeSymbol(symbol);
    const holding = await findOneWithSession(HoldingModel, { portfolio_id: portfolio._id, symbol: normalizedSymbol }, session);
    if (!holding || holding.shares < shares) throw new Error('Not enough shares');

    const proceeds = toMoney(shares * price);
    const costBasis = toMoney(holding.average_price * shares);
    const realizedPnl = toMoney(proceeds - costBasis);

    portfolio.cash_balance = toMoney(portfolio.cash_balance + proceeds);
    portfolio.last_updated = new Date();
    if (portfolio.performance) {
      portfolio.performance.realized_pnl = toMoney((portfolio.performance.realized_pnl || 0) + realizedPnl);
    }
    await saveWithSession(portfolio, session);

    if (holding.shares === shares) {
      await deleteWithSession(holding, session);
    } else {
      holding.shares = toMoney(holding.shares - shares);
      await saveWithSession(holding, session);
    }

    const transaction = await createWithSession(TransactionModel, {
      userId,
      symbol: normalizedSymbol,
      type: 'sell',
      shares,
      price,
      total: proceeds,
      status: 'completed',
      reference_id: referenceId,
      metadata: { realized_pnl: realizedPnl },
    }, session);

    return {
      success: true,
      newBalance: portfolio.cash_balance,
      reference_id: referenceId,
      transaction_id: transaction._id,
    };
  });
}

// Deposit funds
async function deposit(userId, amount, options = {}) {
  const referenceId = extractReferenceId(options);

  return runWithOptionalTransaction(async (session) => {
    const duplicateTx = await findExistingCompletedTransaction(userId, referenceId, session);
    if (duplicateTx) {
      const existingPortfolio = await findOneWithSession(PortfolioModel, { user_id: userId }, session);
      return {
        success: true,
        duplicate: true,
        reference_id: referenceId,
        transaction_id: duplicateTx._id,
        newBalance: existingPortfolio?.cash_balance ?? null,
      };
    }

    const portfolio = await findOneWithSession(PortfolioModel, { user_id: userId }, session);
    if (!portfolio) throw new Error('Portfolio not found');
    if (amount <= 0) throw new Error('Deposit amount must be positive');

    portfolio.cash_balance = toMoney(portfolio.cash_balance + amount);
    portfolio.total_deposited = toMoney(portfolio.total_deposited + amount);
    portfolio.last_updated = new Date();
    await saveWithSession(portfolio, session);

    const transaction = await createWithSession(TransactionModel, {
      userId,
      symbol: 'CASH',
      type: 'deposit',
      total: amount,
      status: 'completed',
      reference_id: referenceId,
      metadata: { source: options.source || 'portfolio.deposit' },
    }, session);

    return {
      success: true,
      newBalance: portfolio.cash_balance,
      reference_id: referenceId,
      transaction_id: transaction._id,
    };
  });
}

// Withdraw funds
async function withdraw(userId, amount, options = {}) {
  const referenceId = extractReferenceId(options);

  return runWithOptionalTransaction(async (session) => {
    const duplicateTx = await findExistingCompletedTransaction(userId, referenceId, session);
    if (duplicateTx) {
      const existingPortfolio = await findOneWithSession(PortfolioModel, { user_id: userId }, session);
      return {
        success: true,
        duplicate: true,
        reference_id: referenceId,
        transaction_id: duplicateTx._id,
        newBalance: existingPortfolio?.cash_balance ?? null,
      };
    }

    const portfolio = await findOneWithSession(PortfolioModel, { user_id: userId }, session);
    if (!portfolio) throw new Error('Portfolio not found');
    if (amount <= 0) throw new Error('Withdrawal amount must be positive');
    if (portfolio.cash_balance < amount) throw new Error('Insufficient cash balance');

    portfolio.cash_balance = toMoney(portfolio.cash_balance - amount);
    portfolio.total_withdrawn = toMoney(portfolio.total_withdrawn + amount);
    portfolio.last_updated = new Date();
    await saveWithSession(portfolio, session);

    const transaction = await createWithSession(TransactionModel, {
      userId,
      symbol: 'CASH',
      type: 'withdrawal',
      total: amount,
      status: 'completed',
      reference_id: referenceId,
      metadata: { source: options.source || 'portfolio.withdraw' },
    }, session);

    return {
      success: true,
      newBalance: portfolio.cash_balance,
      reference_id: referenceId,
      transaction_id: transaction._id,
    };
  });
}

async function getTransactionReport(userId, options = {}) {
  const {
    page = 1,
    limit = 20,
    type,
    symbol,
    startDate,
    endDate,
  } = options;

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const filter = { userId };

  if (type) {
    filter.type = type;
  }

  if (symbol) {
    filter.symbol = normalizeSymbol(symbol);
  }

  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) {
      filter.createdAt.$gte = new Date(startDate);
    }
    if (endDate) {
      const inclusiveEnd = new Date(endDate);
      inclusiveEnd.setUTCHours(23, 59, 59, 999);
      filter.createdAt.$lte = inclusiveEnd;
    }
  }

  const query = TransactionModel.find(filter).sort({ createdAt: -1 });
  const transactions = await query
    .skip((safePage - 1) * safeLimit)
    .limit(safeLimit);

  const total = await TransactionModel.countDocuments(filter);

  return {
    transactions,
    total,
    page: safePage,
    pages: Math.ceil(total / safeLimit),
    filters: {
      type: type || null,
      symbol: symbol ? normalizeSymbol(symbol) : null,
      startDate: startDate || null,
      endDate: endDate || null,
    },
  };
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value);
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

function exportTransactionsToCsv(transactions = []) {
  const headers = ['date', 'type', 'symbol', 'shares', 'price', 'total', 'status', 'reference_id'];
  const rows = transactions.map((transaction) => ([
    transaction.createdAt ? new Date(transaction.createdAt).toISOString() : '',
    transaction.type || '',
    transaction.symbol || '',
    transaction.shares ?? '',
    transaction.price ?? '',
    transaction.total ?? '',
    transaction.status || '',
    transaction.reference_id || '',
  ].map(escapeCsvValue).join(',')));

  return [headers.join(','), ...rows].join('\n');
}

module.exports = {
  getPortfolio,
  buyStock,
  sellStock,
  deposit,
  withdraw,
  getTransactionReport,
  exportTransactionsToCsv,
};