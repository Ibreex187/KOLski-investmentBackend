const mongoose = require('mongoose');
const PortfolioModel = require('../models/portfolio.model');
const HoldingModel = require('../models/holding.model');
const TransactionModel = require('../models/transaction.model');
const marketService = require('./market.service');
const { adjustCash } = require('./cash.ledger');
const { runUndo } = require('./pending.claim');

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

// ─── Trade execution ─────────────────────────────────────────────────────────
//
// Design notes
//  * The execution price always comes from the market service. Any `price` a client
//    sends is ignored, so a caller can never choose what they pay or receive.
//  * Every balance/holding change is a single conditional, atomic update
//    (`cash_balance >= cost`, `shares >= n`) rather than read-modify-write, so two
//    concurrent orders cannot both pass a stale check and overspend / oversell.
//  * With a replica set the steps also run in one transaction. On a standalone
//    server (no transactions) each completed step registers an undo, which is run
//    if a later step fails, so a failed order does not leave money half-moved.

const SHARE_DECIMALS = 6;
const PRICE_DECIMALS = 4;
const ZERO_SHARES = 1e-9;
const MIN_ORDER_VALUE = 0.01;
const SYMBOL_PATTERN = /^[A-Z0-9.\-]{1,12}$/;

function roundTo(value, decimals) {
  return Number(Number(value).toFixed(decimals));
}

function httpError(message, status = 400, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

// The unique (userId, reference_id) index is a compound *sparse* index, which still
// indexes documents whose reference_id is missing/null (userId is always present), so a
// user's second reference-less transaction would collide. Every transaction therefore
// stores a reference: the caller's idempotency key, or a generated one that cannot
// collide and is never used for duplicate detection.
const AUTO_REFERENCE_PREFIX = 'auto:';

function storedReference(referenceId) {
  return referenceId || `${AUTO_REFERENCE_PREFIX}${new mongoose.Types.ObjectId().toString()}`;
}

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

function writeOptions(session, extra = {}) {
  return session ? { ...extra, session } : extra;
}

function validateOrder({ symbol, shares }) {
  const normalizedSymbol = normalizeSymbol(symbol).trim();
  if (!normalizedSymbol) {
    throw httpError('Symbol is required');
  }
  if (!SYMBOL_PATTERN.test(normalizedSymbol)) {
    throw httpError('Symbol is invalid');
  }
  if (typeof shares !== 'number' || !Number.isFinite(shares) || shares <= 0) {
    throw httpError('Shares must be a positive number');
  }
  if (roundTo(shares, SHARE_DECIMALS) !== shares) {
    throw httpError(`Shares support at most ${SHARE_DECIMALS} decimal places`);
  }
  return { symbol: normalizedSymbol, shares };
}

// The one place a trade price is decided. Throws MARKET_DATA_UNAVAILABLE (503)
// rather than trading on a missing or invalid quote.
async function resolveExecutionPrice(symbol, getQuote) {
  const quote = await getQuote(symbol);
  const price = quote?.price;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throw new marketService.MarketDataUnavailableError(`No valid price available for ${symbol}`);
  }
  return { price: roundTo(price, PRICE_DECIMALS), source: quote.source || 'live' };
}

async function buildDuplicateResult(userId, referenceId, existingTx, session = null) {
  const portfolio = await findOneWithSession(PortfolioModel, { user_id: userId }, session);
  return {
    success: true,
    duplicate: true,
    reference_id: referenceId,
    transaction_id: existingTx._id,
    newBalance: portfolio?.cash_balance ?? null,
  };
}

// Two requests carrying the same reference can both pass the pre-check. The unique
// (userId, reference_id) index lets exactly one create its transaction; the other
// rolls back and is reported as the duplicate it is.
async function withDuplicateGuard(userId, referenceId, work) {
  try {
    return await work();
  } catch (error) {
    if (referenceId && isDuplicateKeyError(error)) {
      const existing = await findExistingCompletedTransaction(userId, referenceId);
      if (existing) {
        return buildDuplicateResult(userId, referenceId, existing);
      }
    }
    throw error;
  }
}

// Atomically add a lot to a holding, recomputing the weighted average price in the
// database so concurrent buys of the same symbol cannot lose each other's update.
async function addLot({ portfolioId, symbol, shares, cost, name, sector, logoUrl }, session = null) {
  const currentShares = { $ifNull: ['$shares', 0] };
  const currentAverage = { $ifNull: ['$average_price', 0] };
  const newShares = { $add: [currentShares, shares] };

  const fields = {
    shares: { $round: [newShares, SHARE_DECIMALS] },
    average_price: {
      $round: [
        { $divide: [{ $add: [{ $multiply: [currentAverage, currentShares] }, cost] }, newShares] },
        PRICE_DECIMALS,
      ],
    },
    // $literal keeps user-supplied text from being read as a field path / operator.
    name: { $ifNull: ['$name', { $literal: name || symbol }] },
    createdAt: { $ifNull: ['$createdAt', '$$NOW'] },
    updatedAt: '$$NOW',
  };
  if (sector) fields.sector = { $ifNull: ['$sector', { $literal: String(sector) }] };
  if (logoUrl) fields.logo_url = { $ifNull: ['$logo_url', { $literal: String(logoUrl) }] };

  const run = () => HoldingModel.findOneAndUpdate(
    { portfolio_id: portfolioId, symbol },
    [{ $set: fields }],
    writeOptions(session, {
      upsert: true,
      returnDocument: 'after',
      updatePipeline: true,
      setDefaultsOnInsert: false,
      timestamps: false,
    })
  );

  try {
    return await run();
  } catch (error) {
    // Two first-time buys of one symbol race on the unique (portfolio, symbol) index.
    // The loser simply re-runs and now updates the winner's document.
    if (isDuplicateKeyError(error)) {
      return run();
    }
    throw error;
  }
}

// Exact inverse of addLot (used only for rollback).
async function removeLot({ portfolioId, symbol, shares, cost }) {
  const remaining = { $subtract: ['$shares', shares] };
  await HoldingModel.findOneAndUpdate(
    { portfolio_id: portfolioId, symbol },
    [{
      $set: {
        shares: { $round: [remaining, SHARE_DECIMALS] },
        average_price: {
          $cond: [
            { $gt: [remaining, ZERO_SHARES] },
            { $round: [{ $divide: [{ $subtract: [{ $multiply: ['$average_price', '$shares'] }, cost] }, remaining] }, PRICE_DECIMALS] },
            '$average_price',
          ],
        },
      },
    }],
    { updatePipeline: true, timestamps: false }
  );
  await HoldingModel.deleteOne({ portfolio_id: portfolioId, symbol, shares: { $lte: ZERO_SHARES } });
}

async function findPortfolioOrThrow(userId, session) {
  const portfolio = await findOneWithSession(PortfolioModel, { user_id: userId }, session);
  if (!portfolio) {
    throw httpError('Portfolio not found', 404);
  }
  return portfolio;
}

// Buy stock at the current market price.
async function buyStock(userId, payload = {}, dependencies = {}) {
  const getQuote = dependencies.getQuote || marketService.getQuote;
  const referenceId = extractReferenceId(payload);
  const { symbol, shares } = validateOrder(payload);
  const { name, sector, logoUrl } = payload;

  const duplicateTx = await findExistingCompletedTransaction(userId, referenceId);
  if (duplicateTx) {
    return buildDuplicateResult(userId, referenceId, duplicateTx);
  }

  const { price, source } = await resolveExecutionPrice(symbol, getQuote);
  const cost = toMoney(shares * price);
  if (cost < MIN_ORDER_VALUE) {
    throw httpError('Order value is too small');
  }

  return withDuplicateGuard(userId, referenceId, () => runWithOptionalTransaction(async (session) => {
    const undo = session ? null : [];

    try {
      const portfolio = await findPortfolioOrThrow(userId, session);

      const debited = await adjustCash(userId, -cost, { requireFunds: true }, session);
      if (!debited) {
        throw httpError('Insufficient funds');
      }
      undo?.push(() => adjustCash(userId, cost));

      await addLot({ portfolioId: portfolio._id, symbol, shares, cost, name, sector, logoUrl }, session);
      undo?.push(() => removeLot({ portfolioId: portfolio._id, symbol, shares, cost }));

      const transaction = await createWithSession(TransactionModel, {
        userId,
        symbol,
        type: 'buy',
        shares,
        price,
        total: cost,
        status: 'completed',
        reference_id: storedReference(referenceId),
        metadata: { name, sector, logo_url: logoUrl, price_source: source },
      }, session);

      return {
        success: true,
        newBalance: debited.cash_balance,
        symbol,
        shares,
        price,
        total: cost,
        price_source: source,
        reference_id: referenceId,
        transaction_id: transaction._id,
      };
    } catch (error) {
      if (undo) await runUndo(undo);
      throw error;
    }
  }));
}

// Sell stock at the current market price.
async function sellStock(userId, payload = {}, dependencies = {}) {
  const getQuote = dependencies.getQuote || marketService.getQuote;
  const referenceId = extractReferenceId(payload);
  const { symbol, shares } = validateOrder(payload);

  const duplicateTx = await findExistingCompletedTransaction(userId, referenceId);
  if (duplicateTx) {
    return buildDuplicateResult(userId, referenceId, duplicateTx);
  }

  const { price, source } = await resolveExecutionPrice(symbol, getQuote);
  const proceeds = toMoney(shares * price);
  if (proceeds < MIN_ORDER_VALUE) {
    throw httpError('Order value is too small');
  }

  return withDuplicateGuard(userId, referenceId, () => runWithOptionalTransaction(async (session) => {
    const undo = session ? null : [];

    try {
      const portfolio = await findPortfolioOrThrow(userId, session);

      // Claim the shares first; only matches while enough are held. Returns the
      // pre-update document so the cost basis is the one that was actually sold.
      const holdingBefore = await HoldingModel.findOneAndUpdate(
        { portfolio_id: portfolio._id, symbol, shares: { $gte: shares } },
        [{ $set: { shares: { $round: [{ $subtract: ['$shares', shares] }, SHARE_DECIMALS] }, updatedAt: '$$NOW' } }],
        writeOptions(session, { returnDocument: 'before', updatePipeline: true, timestamps: false })
      );
      if (!holdingBefore) {
        throw httpError('Not enough shares');
      }
      undo?.push(() => HoldingModel.findOneAndUpdate(
        { portfolio_id: portfolio._id, symbol },
        [{ $set: { shares: { $round: [{ $add: ['$shares', shares] }, SHARE_DECIMALS] } } }],
        { updatePipeline: true, timestamps: false }
      ));

      const costBasis = toMoney(holdingBefore.average_price * shares);
      const realizedPnl = toMoney(proceeds - costBasis);

      const credited = await adjustCash(userId, proceeds, { realizedPnlDelta: realizedPnl }, session);
      if (!credited) {
        throw httpError('Portfolio not found', 404);
      }
      undo?.push(() => adjustCash(userId, -proceeds, { realizedPnlDelta: -realizedPnl }));

      const transaction = await createWithSession(TransactionModel, {
        userId,
        symbol,
        type: 'sell',
        shares,
        price,
        total: proceeds,
        status: 'completed',
        reference_id: storedReference(referenceId),
        metadata: { realized_pnl: realizedPnl, price_source: source },
      }, session);

      // Housekeeping: drop the emptied position. Conditional, so a concurrent buy
      // that re-added shares keeps its holding.
      try {
        await HoldingModel.deleteOne(
          { portfolio_id: portfolio._id, symbol, shares: { $lte: ZERO_SHARES } },
          writeOptions(session)
        );
      } catch (cleanupError) {
        if (session) throw cleanupError;
        console.error('Empty holding cleanup failed:', cleanupError.message);
      }

      return {
        success: true,
        newBalance: credited.cash_balance,
        symbol,
        shares,
        price,
        total: proceeds,
        realized_pnl: realizedPnl,
        price_source: source,
        reference_id: referenceId,
        transaction_id: transaction._id,
      };
    } catch (error) {
      if (undo) await runUndo(undo);
      throw error;
    }
  }));
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
    // Generated placeholder references (see storedReference) are internal, not user-facing.
    String(transaction.reference_id || '').startsWith(AUTO_REFERENCE_PREFIX) ? '' : (transaction.reference_id || ''),
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