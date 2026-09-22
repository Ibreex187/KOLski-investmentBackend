const { randomUUID } = require('crypto');
const UserModel = require('../models/user.model');
const PortfolioModel = require('../models/portfolio.model');
const HoldingModel = require('../models/holding.model');
const TransactionModel = require('../models/transaction.model');
const NotificationModel = require('../models/notification.model');
const WatchlistModel = require('../models/watchlist.model');
const PriceAlertModel = require('../models/price.alert.model');
const PortfolioSnapshotModel = require('../models/portfolio.snapshot.model');

// The public "Try Demo" account: one shared login, no password, reset nightly.
//
// Consistency: rather than hand-typing holdings/cash numbers (easy to get subtly
// wrong), a fixed script of trades is *replayed* through the same buy/sell math the
// real app uses (services/portfolio.service.js), so the seeded portfolio, holdings and
// balances always agree with each other exactly like a real user's would.
//
// Safety note: unlike the trading code, seeding is not hardened against overlapping
// runs with a lock/lease. It is a scripted, idempotent delete-then-recreate of one
// fixed account holding no real money, triggered by a single daily cron plus a rarely
// -overlapping fallback; the worst case of a rare double-run is a wasted extra pass
// that converges to the same end state, not a correctness bug. That trade-off would
// not be acceptable for real user funds (see the trading code for why).

const DEMO_EMAIL = String(process.env.DEMO_ACCOUNT_EMAIL || 'demo@kolski.app').trim().toLowerCase();
const DEMO_USERNAME = String(process.env.DEMO_ACCOUNT_USERNAME || 'demo_investor').trim().toLowerCase();
const DEMO_NAME = 'Demo Investor';

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS);
const toMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

// A tiny seeded PRNG (not Math.random) so the demo's simulated market "noise" has the
// same shape on every reset - the story stays recognizable each day, just shifted.
function seededRandom(seed) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

// The scripted trade history, oldest first. Chosen to exercise every feature the demo
// should show off: multiple sectors, a partial sell (realized P&L), two deposits, one
// withdrawal, and a buy that raises an existing position's average price.
const SCRIPT = [
  { d: 45, type: 'deposit', total: 20000 },
  { d: 44, type: 'buy', symbol: 'AAPL', name: 'Apple Inc.', sector: 'Technology', shares: 12, price: 168.32 },
  { d: 40, type: 'buy', symbol: 'MSFT', name: 'Microsoft Corporation', sector: 'Technology', shares: 8, price: 402.15 },
  { d: 33, type: 'buy', symbol: 'TSLA', name: 'Tesla, Inc.', sector: 'Consumer Discretionary', shares: 6, price: 205.10 },
  { d: 28, type: 'sell', symbol: 'TSLA', shares: 1, price: 221.40 },
  { d: 25, type: 'buy', symbol: 'JPM', name: 'JPMorgan Chase & Co.', sector: 'Financials', shares: 10, price: 187.40 },
  { d: 18, type: 'deposit', total: 5000 },
  { d: 14, type: 'buy', symbol: 'JNJ', name: 'Johnson & Johnson', sector: 'Healthcare', shares: 15, price: 152.10 },
  { d: 7, type: 'withdrawal', total: 500 },
  { d: 3, type: 'buy', symbol: 'AAPL', name: 'Apple Inc.', sector: 'Technology', shares: 3, price: 175.90 },
];

// Replays SCRIPT up to (and including) `asOfDaysAgo`, using the same weighted-average
// logic as portfolio.service.buyStock/sellStock, and returns the resulting state.
function simulate(asOfDaysAgo = 0) {
  const holdings = new Map(); // symbol -> { shares, average_price, name, sector }
  let cash = 0;
  let totalDeposited = 0;
  let totalWithdrawn = 0;
  let realizedPnl = 0;

  for (const step of SCRIPT) {
    if (step.d < asOfDaysAgo) continue; // not reached yet as of this point in time

    if (step.type === 'deposit') {
      cash = toMoney(cash + step.total);
      totalDeposited = toMoney(totalDeposited + step.total);
    } else if (step.type === 'withdrawal') {
      cash = toMoney(cash - step.total);
      totalWithdrawn = toMoney(totalWithdrawn + step.total);
    } else if (step.type === 'buy') {
      const cost = toMoney(step.shares * step.price);
      cash = toMoney(cash - cost);
      const existing = holdings.get(step.symbol);
      if (existing) {
        const totalShares = existing.shares + step.shares;
        existing.average_price = toMoney(((existing.average_price * existing.shares) + cost) / totalShares);
        existing.shares = totalShares;
      } else {
        holdings.set(step.symbol, {
          shares: step.shares,
          average_price: step.price,
          name: step.name,
          sector: step.sector,
        });
      }
    } else if (step.type === 'sell') {
      const proceeds = toMoney(step.shares * step.price);
      const existing = holdings.get(step.symbol);
      const costBasis = toMoney(existing.average_price * step.shares);
      cash = toMoney(cash + proceeds);
      realizedPnl = toMoney(realizedPnl + (proceeds - costBasis));
      existing.shares = toMoney(existing.shares - step.shares);
      if (existing.shares <= 0) holdings.delete(step.symbol);
    }
  }

  const invested = toMoney([...holdings.values()].reduce((sum, h) => sum + h.shares * h.average_price, 0));
  return { holdings, cash, totalDeposited, totalWithdrawn, realizedPnl, invested };
}

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

// Several visitors can click "Try Demo" at the same instant before the account has
// ever been created; email/username are unique, so only one concurrent create() wins
// and the rest throw E11000 rather than silently returning null. Treat that the same
// as finding the (now-existing) user.
async function findOrCreateDemoUser() {
  let user = await UserModel.findOne({ email: DEMO_EMAIL });
  if (user) {
    if (!user.isDemo) {
      user.isDemo = true;
      await user.save({ validateBeforeSave: false });
    }
    return user;
  }

  try {
    // Never used to sign in (the demo endpoint bypasses password login entirely), so a
    // fresh, unrecoverable random password is enough.
    return await UserModel.create({
      name: DEMO_NAME,
      username: DEMO_USERNAME,
      email: DEMO_EMAIL,
      password: `${randomUUID()}${randomUUID()}`,
      isVerified: true,
      isDemo: true,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const winner = await UserModel.findOne({ email: DEMO_EMAIL });
      if (winner) return winner;
    }
    throw error;
  }
}

// Get-or-create the demo portfolio, and report whether *this* call is the one that
// created it: exactly one concurrent caller's create() can succeed on the unique
// user_id index, and that caller is unambiguously the one that just inserted it. This
// lets ensureDemoAccount() guarantee exactly one caller seeds the account (see below)
// instead of two visitors' concurrent seeding passes racing each other's writes.
async function findOrCreateDemoPortfolio(user) {
  const existing = await PortfolioModel.findOne({ user_id: user._id });
  if (existing) {
    return { portfolio: existing, created: false };
  }

  try {
    const portfolio = await PortfolioModel.create({ user_id: user._id, name: 'Demo Portfolio' });
    return { portfolio, created: true };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const winner = await PortfolioModel.findOne({ user_id: user._id });
      if (winner) return { portfolio: winner, created: false };
    }
    throw error;
  }
}

// A caller that lost the create race above returns immediately with an account that
// might still be mid-seed. Polling briefly for the first holding to appear avoids
// handing back an empty-looking portfolio to a demo visitor for no reason; if seeding
// is unexpectedly slow it just falls through and the caller proceeds anyway.
async function waitUntilSeeded(portfolioId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await HoldingModel.exists({ portfolio_id: portfolioId })) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function seedHoldings(portfolio, holdings) {
  const docs = await HoldingModel.insertMany(
    [...holdings.entries()].map(([symbol, h]) => ({
      portfolio_id: portfolio._id,
      symbol,
      name: h.name,
      shares: h.shares,
      average_price: h.average_price,
      sector: h.sector,
    }))
  );
  return docs;
}

async function seedTransactions(user, portfolio) {
  for (const step of [...SCRIPT].reverse()) {
    const before = simulate(step.d + 0.5); // state just before this step took effect
    const symbol = step.symbol || 'CASH';
    const payload = {
      userId: user._id,
      symbol,
      type: step.type,
      status: 'completed',
      reference_id: `demo-seed-${step.type}-${symbol}-${step.d}`,
      // Set at create() time: Mongoose's timestamps plugin silently strips a
      // user-supplied createdAt from a later updateOne, so backdating has to happen here.
      createdAt: daysAgo(step.d),
      updatedAt: daysAgo(step.d),
    };

    if (step.type === 'deposit' || step.type === 'withdrawal') {
      payload.total = step.total;
      payload.metadata = { source: 'demo.seed' };
    } else if (step.type === 'buy') {
      payload.shares = step.shares;
      payload.price = step.price;
      payload.total = toMoney(step.shares * step.price);
      payload.metadata = { name: step.name, sector: step.sector, price_source: 'demo-seed' };
    } else if (step.type === 'sell') {
      const beforeHolding = before.holdings.get(symbol);
      const proceeds = toMoney(step.shares * step.price);
      const costBasis = toMoney(beforeHolding.average_price * step.shares);
      payload.shares = step.shares;
      payload.price = step.price;
      payload.total = proceeds;
      payload.metadata = { realized_pnl: toMoney(proceeds - costBasis), price_source: 'demo-seed' };
    }

    await TransactionModel.create([payload]);
  }

  // A couple of already-reviewed manual deposit/withdrawal records, so those pages
  // (which read the same Transaction collection with a manual_bank_transfer flow tag)
  // have something to show too.
  await TransactionModel.create({
    userId: user._id,
    symbol: 'CASH',
    type: 'deposit',
    total: 2500,
    status: 'completed',
    reference_id: 'demo-seed-manual-deposit-1',
    createdAt: daysAgo(20),
    updatedAt: daysAgo(19),
    metadata: {
      deposit_flow: 'manual_bank_transfer',
      source: 'deposits.manual',
      currency: 'USD',
      transfer_reference: 'DEMO-BANK-REF-2201',
      idempotency_key: 'demo-seed-manual-deposit-1',
      submitted_at: daysAgo(20),
      approved_by: 'demo-admin',
      approved_at: daysAgo(19),
      bank_settlement_ref: 'DEMO-SETTLE-1',
    },
  });

  await TransactionModel.create({
    userId: user._id,
    symbol: 'CASH',
    type: 'withdrawal',
    total: 500,
    status: 'completed',
    reference_id: 'demo-seed-manual-withdrawal-1',
    createdAt: daysAgo(7),
    updatedAt: daysAgo(7),
    metadata: {
      withdrawal_flow: 'manual_bank_transfer',
      source: 'withdrawals.manual',
      currency: 'USD',
      destination_reference: 'DEMO-DEST-1187',
      idempotency_key: 'demo-seed-manual-withdrawal-1',
      submitted_at: daysAgo(7),
      approved_by: 'demo-admin',
      approved_at: daysAgo(7),
      bank_settlement_ref: 'DEMO-SETTLE-2',
    },
  });
}

// One daily snapshot per day of the script's window. Book value (cash + cost basis)
// moves in clean steps at each trade; a small seeded random walk is layered on top of
// the invested portion only, so the chart shows believable day-to-day market wiggle
// instead of a staircase.
async function seedSnapshots(user, portfolio) {
  const rand = seededRandom(20260101);
  let walk = 0;
  const docs = [];

  for (let d = 45; d >= 0; d -= 1) {
    const state = simulate(d);
    walk = Math.max(-0.08, Math.min(0.08, walk + (rand() - 0.5) * 0.015));
    const marketValue = toMoney(state.invested * (1 + walk));
    const totalValue = toMoney(state.cash + marketValue);
    const profitLoss = toMoney(totalValue - state.invested);

    docs.push({
      user_id: user._id,
      portfolio_id: portfolio._id,
      total_value: totalValue,
      cash_balance: state.cash,
      invested: state.invested,
      profit_loss: profitLoss,
      captured_at: daysAgo(d),
    });
  }

  await PortfolioSnapshotModel.insertMany(docs);
}

async function seedNotifications(user) {
  const items = [
    { d: 0.5, read: false, type: 'alert', title: 'Price Alert Triggered: MSFT', message: 'MSFT is now above your target of 380.', data: { symbol: 'MSFT' } },
    { d: 3, read: false, type: 'trade', title: 'Stock Purchase Confirmation', message: 'You purchased 3 shares of AAPL at 175.90.', data: { symbol: 'AAPL', action: 'buy' } },
    { d: 7, read: true, type: 'withdrawal', title: 'Withdrawal Approved', message: 'Your withdrawal of $500.00 was approved.', data: {} },
    { d: 14, read: true, type: 'trade', title: 'Stock Purchase Confirmation', message: 'You purchased 15 shares of JNJ at 152.10.', data: { symbol: 'JNJ', action: 'buy' } },
    { d: 20, read: true, type: 'deposit', title: 'Deposit Approved', message: 'Your deposit of $2,500.00 was approved.', data: {} },
  ];

  for (const item of items) {
    await NotificationModel.create({
      user_id: user._id,
      type: item.type,
      title: item.title,
      message: item.message,
      read: item.read,
      readAt: item.read ? daysAgo(item.d) : null,
      data: item.data,
      createdAt: daysAgo(item.d),
      updatedAt: daysAgo(item.d),
    });
  }
}

async function seedWatchlist(portfolio) {
  await WatchlistModel.insertMany([
    { portfolio_id: portfolio._id, symbol: 'NVDA', name: 'NVIDIA Corporation' },
    { portfolio_id: portfolio._id, symbol: 'AMZN', name: 'Amazon.com, Inc.' },
    { portfolio_id: portfolio._id, symbol: 'GOOGL', name: 'Alphabet Inc.' },
  ]);
}

async function seedAlerts(user) {
  // Far from any plausible near-term price, so it stays "active" and demonstrates the
  // feature without flapping between states as real prices move.
  await PriceAlertModel.create({
    user_id: user._id,
    symbol: 'AAPL',
    target_price: 500,
    direction: 'above',
    status: 'active',
    lastCheckedAt: daysAgo(0.1),
    createdAt: daysAgo(6),
    updatedAt: daysAgo(0.1),
  });

  // Seeded already-triggered, rather than relying on today's live price crossing a
  // threshold, so the "triggered" state is reliably visible regardless of the market.
  await PriceAlertModel.create({
    user_id: user._id,
    symbol: 'MSFT',
    target_price: 380,
    direction: 'above',
    status: 'triggered',
    triggered: true,
    triggeredAt: daysAgo(0.5),
    triggeredPrice: 384.20,
    notificationSent: true,
    lastCheckedAt: daysAgo(0.5),
    createdAt: daysAgo(10),
    updatedAt: daysAgo(0.5),
  });
}

async function wipeDemoData(user, portfolio) {
  await Promise.all([
    HoldingModel.deleteMany({ portfolio_id: portfolio._id }),
    TransactionModel.deleteMany({ userId: user._id }),
    NotificationModel.deleteMany({ user_id: user._id }),
    WatchlistModel.deleteMany({ portfolio_id: portfolio._id }),
    PriceAlertModel.deleteMany({ user_id: user._id }),
    PortfolioSnapshotModel.deleteMany({ user_id: user._id }),
  ]);
}

// Writes every part of the demo account's data (portfolio balances, holdings,
// transactions, snapshots, notifications, watchlist, alerts) from the fixed script.
// Assumes the target portfolio is currently empty of demo data (the caller either just
// created it, or just wiped it).
async function applyDemoSeed(user, portfolio) {
  const final = simulate(0);
  portfolio.cash_balance = final.cash;
  portfolio.total_deposited = final.totalDeposited;
  portfolio.total_withdrawn = final.totalWithdrawn;
  portfolio.performance = portfolio.performance || {};
  portfolio.performance.realized_pnl = final.realizedPnl;
  portfolio.last_updated = new Date();
  await portfolio.save({ validateBeforeSave: false });

  await seedHoldings(portfolio, final.holdings);
  await seedTransactions(user, portfolio);
  await seedSnapshots(user, portfolio);
  await seedNotifications(user);
  await seedWatchlist(portfolio);
  await seedAlerts(user);
}

// Wipes and rebuilds the demo account's data from the fixed script above. Idempotent:
// safe to call repeatedly (the nightly cron does exactly that). This is a single
// scheduled call in normal operation; see ensureDemoAccount() for how the public login
// endpoint avoids ever running two of these concurrently against the same account.
async function resetDemoAccount() {
  const user = await findOrCreateDemoUser();
  const { portfolio } = await findOrCreateDemoPortfolio(user);

  await wipeDemoData(user, portfolio);
  await applyDemoSeed(user, portfolio);

  return { userId: user._id, portfolioId: portfolio._id };
}

// Fast path for the login endpoint: returns the demo user, seeding it from scratch only
// the first time it's ever needed (e.g. before the nightly cron has run once). Does not
// wipe existing data, so a visitor's in-progress demo session is not reset out from
// under them just because someone else also logs in.
//
// Concurrency: several visitors can click "Try Demo" at the same instant before the
// account has ever been seeded. findOrCreateDemoPortfolio's `created` flag ensures only
// the single caller that actually inserted the portfolio row runs applyDemoSeed; every
// other concurrent caller just waits briefly for that seed to finish instead of also
// seeding (which would otherwise race the same unique-indexed writes against each other).
async function ensureDemoAccount() {
  const user = await findOrCreateDemoUser();
  const { portfolio, created } = await findOrCreateDemoPortfolio(user);

  if (created) {
    await applyDemoSeed(user, portfolio);
    return UserModel.findOne({ email: DEMO_EMAIL });
  }

  await waitUntilSeeded(portfolio._id);
  return user;
}

module.exports = {
  DEMO_EMAIL,
  DEMO_USERNAME,
  resetDemoAccount,
  ensureDemoAccount,
  // exported for tests
  simulate,
};
