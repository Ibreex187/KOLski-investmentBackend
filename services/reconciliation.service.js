const mongoose = require('mongoose');
const PortfolioModel = require('../models/portfolio.model');
const HoldingModel = require('../models/holding.model');
const TransactionModel = require('../models/transaction.model');

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function sortTransactions(transactions = []) {
  return [...transactions].sort((a, b) => {
    const left = new Date(a.createdAt || a.date || 0).getTime();
    const right = new Date(b.createdAt || b.date || 0).getTime();
    return left - right;
  });
}

function computeReconciliationSnapshot({ transactions = [] } = {}) {
  const holdingsMap = new Map();
  let cashBalance = 0;
  let totalDeposited = 0;
  let totalWithdrawn = 0;
  let realizedPnl = 0;

  for (const tx of sortTransactions(transactions)) {
    const type = tx.type;
    const symbol = String(tx.symbol || '').toUpperCase();
    const shares = Number(tx.shares || 0);
    const price = Number(tx.price || 0);
    const total = roundMoney(tx.total ?? (shares * price));

    if (type === 'deposit') {
      cashBalance = roundMoney(cashBalance + total);
      totalDeposited = roundMoney(totalDeposited + total);
      continue;
    }

    if (type === 'withdrawal') {
      cashBalance = roundMoney(cashBalance - total);
      totalWithdrawn = roundMoney(totalWithdrawn + total);
      continue;
    }

    if (!symbol) {
      continue;
    }

    const currentHolding = holdingsMap.get(symbol) || {
      symbol,
      name: tx.name || symbol,
      shares: 0,
      average_price: 0,
    };

    if (type === 'buy') {
      const nextShares = currentHolding.shares + shares;
      const nextCostBasis = (currentHolding.average_price * currentHolding.shares) + total;
      currentHolding.shares = nextShares;
      currentHolding.average_price = nextShares > 0 ? roundMoney(nextCostBasis / nextShares) : 0;
      holdingsMap.set(symbol, currentHolding);
      cashBalance = roundMoney(cashBalance - total);
      continue;
    }

    if (type === 'sell') {
      const soldShares = Math.min(currentHolding.shares, shares);
      const costBasis = roundMoney(currentHolding.average_price * soldShares);
      currentHolding.shares = roundMoney(currentHolding.shares - soldShares);
      realizedPnl = roundMoney(realizedPnl + (total - costBasis));
      cashBalance = roundMoney(cashBalance + total);

      if (currentHolding.shares <= 0) {
        holdingsMap.delete(symbol);
      } else {
        holdingsMap.set(symbol, currentHolding);
      }
    }
  }

  const holdings = [...holdingsMap.values()].map((holding) => ({
    ...holding,
    shares: roundMoney(holding.shares),
    average_price: roundMoney(holding.average_price),
  }));

  const invested = roundMoney(
    holdings.reduce((sum, holding) => sum + (holding.shares * holding.average_price), 0)
  );

  return {
    cash_balance: roundMoney(cashBalance),
    total_deposited: roundMoney(totalDeposited),
    total_withdrawn: roundMoney(totalWithdrawn),
    realized_pnl: roundMoney(realizedPnl),
    invested,
    holdings,
  };
}

function buildReconciliationSummary({ portfolio = {}, holdings = [], transactions = [] } = {}) {
  const expected = computeReconciliationSnapshot({ transactions });
  const actual = {
    cash_balance: roundMoney(portfolio.cash_balance),
    total_deposited: roundMoney(portfolio.total_deposited),
    total_withdrawn: roundMoney(portfolio.total_withdrawn),
    realized_pnl: roundMoney(portfolio.performance?.realized_pnl ?? portfolio.realized_pnl),
    holdings: holdings.map((holding) => ({
      symbol: String(holding.symbol || '').toUpperCase(),
      shares: roundMoney(holding.shares),
      average_price: roundMoney(holding.average_price),
    })),
  };

  const mismatches = [];
  ['cash_balance', 'total_deposited', 'total_withdrawn', 'realized_pnl'].forEach((field) => {
    if (actual[field] !== expected[field]) {
      mismatches.push({ field, actual: actual[field], expected: expected[field] });
    }
  });

  const actualHoldingsMap = new Map(actual.holdings.map((holding) => [holding.symbol, holding]));
  const expectedHoldingsMap = new Map(expected.holdings.map((holding) => [holding.symbol, holding]));
  const symbols = new Set([...actualHoldingsMap.keys(), ...expectedHoldingsMap.keys()]);

  for (const symbol of symbols) {
    const current = actualHoldingsMap.get(symbol);
    const ledger = expectedHoldingsMap.get(symbol);

    if (!current || !ledger) {
      mismatches.push({
        field: `holdings.${symbol}`,
        actual: current || null,
        expected: ledger || null,
      });
      continue;
    }

    if (current.shares !== ledger.shares) {
      mismatches.push({
        field: `holdings.${symbol}.shares`,
        actual: current.shares,
        expected: ledger.shares,
      });
    }

    if (current.average_price !== ledger.average_price) {
      mismatches.push({
        field: `holdings.${symbol}.average_price`,
        actual: current.average_price,
        expected: ledger.average_price,
      });
    }
  }

  return {
    is_consistent: mismatches.length === 0,
    checked_at: new Date().toISOString(),
    actual,
    expected,
    mismatches,
  };
}

async function reconcilePortfolioState({ userId, applyChanges = false } = {}) {
  if (!userId) {
    throw new Error('userId is required');
  }

  const disconnected = mongoose.connection.readyState !== 1
    && !PortfolioModel.findOne?._isMockFunction
    && !HoldingModel.find?._isMockFunction
    && !TransactionModel.find?._isMockFunction;

  if (disconnected) {
    return null;
  }

  const portfolio = await PortfolioModel.findOne({ user_id: userId });
  if (!portfolio) {
    return null;
  }

  const holdings = await HoldingModel.find({ portfolio_id: portfolio._id });
  const transactionQuery = TransactionModel.find({ userId });
  const transactions = typeof transactionQuery.sort === 'function'
    ? await transactionQuery.sort({ createdAt: 1 })
    : await transactionQuery;

  const summary = buildReconciliationSummary({ portfolio, holdings, transactions });

  if (applyChanges && summary.mismatches.length > 0 && mongoose.connection.readyState === 1) {
    portfolio.cash_balance = summary.expected.cash_balance;
    portfolio.total_deposited = summary.expected.total_deposited;
    portfolio.total_withdrawn = summary.expected.total_withdrawn;
    portfolio.last_updated = new Date();

    if (portfolio.performance) {
      portfolio.performance.realized_pnl = summary.expected.realized_pnl;
    }

    await portfolio.save();

    const expectedSymbols = new Set();
    for (const expectedHolding of summary.expected.holdings) {
      expectedSymbols.add(expectedHolding.symbol);
      const existingHolding = holdings.find((holding) => String(holding.symbol).toUpperCase() === expectedHolding.symbol);

      if (existingHolding) {
        existingHolding.shares = expectedHolding.shares;
        existingHolding.average_price = expectedHolding.average_price;
        await existingHolding.save();
      } else {
        await HoldingModel.create({
          portfolio_id: portfolio._id,
          symbol: expectedHolding.symbol,
          name: expectedHolding.name || expectedHolding.symbol,
          shares: expectedHolding.shares,
          average_price: expectedHolding.average_price,
        });
      }
    }

    for (const holding of holdings) {
      const symbol = String(holding.symbol || '').toUpperCase();
      if (!expectedSymbols.has(symbol)) {
        await holding.deleteOne();
      }
    }

    return {
      ...summary,
      applied: true,
      is_consistent: true,
    };
  }

  return {
    ...summary,
    applied: false,
  };
}

module.exports = {
  roundMoney,
  computeReconciliationSnapshot,
  buildReconciliationSummary,
  reconcilePortfolioState,
};
