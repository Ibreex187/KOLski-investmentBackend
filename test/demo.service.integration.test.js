// Demo account seeding/reset against a real (in-memory) MongoDB.

const {
  startMemoryMongo,
  stopMemoryMongo,
  resetCollections,
} = require('./helpers/memory.mongo');

const UserModel = require('../models/user.model');
const PortfolioModel = require('../models/portfolio.model');
const HoldingModel = require('../models/holding.model');
const TransactionModel = require('../models/transaction.model');
const NotificationModel = require('../models/notification.model');
const WatchlistModel = require('../models/watchlist.model');
const PriceAlertModel = require('../models/price.alert.model');
const PortfolioSnapshotModel = require('../models/portfolio.snapshot.model');
const demoService = require('../services/demo.service');

jest.setTimeout(120000);

beforeAll(async () => {
  await startMemoryMongo();
});

afterAll(async () => {
  await stopMemoryMongo();
});

beforeEach(async () => {
  await resetCollections();
  await UserModel.deleteMany({});
  await WatchlistModel.deleteMany({});
});

describe('simulate (the trade-script replay)', () => {
  it('matches what buyStock/sellStock would actually compute (weighted average, realized P&L)', () => {
    const final = demoService.simulate(0);

    // AAPL: 12 @ 168.32, then 3 @ 175.90 -> weighted average.
    const aapl = final.holdings.get('AAPL');
    expect(aapl.shares).toBe(15);
    expect(aapl.average_price).toBeCloseTo(((168.32 * 12) + (175.90 * 3)) / 15, 2);

    // TSLA: bought 6 @ 205.10, sold 1 @ 221.40 -> shares drop, average price unaffected by the sell.
    const tsla = final.holdings.get('TSLA');
    expect(tsla.shares).toBe(5);
    expect(tsla.average_price).toBe(205.10);
    expect(final.realizedPnl).toBeCloseTo(221.40 - 205.10, 2);

    expect(final.totalDeposited).toBe(25000);
    expect(final.totalWithdrawn).toBe(500);

    // cash = deposits - withdrawals - every buy cost + every sell proceeds
    const invested = [...final.holdings.values()].reduce((sum, h) => sum + h.shares * h.average_price, 0);
    expect(final.cash).toBeGreaterThan(0);
    expect(final.invested).toBeCloseTo(invested, 1);
  });

  it('as-of an earlier day only reflects steps that had happened by then', () => {
    const dayZero = demoService.simulate(45); // only the very first deposit has occurred
    expect(dayZero.holdings.size).toBe(0);
    expect(dayZero.cash).toBe(20000);
    expect(dayZero.totalDeposited).toBe(20000);
  });
});

describe('resetDemoAccount', () => {
  it('creates the demo user and a fully seeded, internally consistent portfolio', async () => {
    const { userId, portfolioId } = await demoService.resetDemoAccount();

    const user = await UserModel.findById(userId);
    expect(user).toMatchObject({ email: demoService.DEMO_EMAIL, isDemo: true, isVerified: true });

    const portfolio = await PortfolioModel.findById(portfolioId);
    const holdings = await HoldingModel.find({ portfolio_id: portfolioId });
    const invested = holdings.reduce((sum, h) => sum + h.shares * h.average_price, 0);

    expect(holdings.length).toBeGreaterThanOrEqual(5);
    expect(portfolio.cash_balance).toBeGreaterThan(0);
    expect(portfolio.total_deposited).toBe(25000);
    expect(portfolio.total_withdrawn).toBe(500);
    expect(portfolio.performance.realized_pnl).toBeCloseTo(221.40 - 205.10, 2);
    // The seeded portfolio should look like a real one would after the same trades:
    // cash + invested = net deposits + realized P&L (no money invented or lost).
    const expectedTotal = 25000 - 500 + portfolio.performance.realized_pnl;
    expect(portfolio.cash_balance + invested).toBeCloseTo(expectedTotal, 0);
  });

  it('seeds transactions that agree with the final holdings (same math as a real trade)', async () => {
    const { userId, portfolioId } = await demoService.resetDemoAccount();

    const buys = await TransactionModel.find({ userId, type: 'buy', symbol: 'AAPL' }).sort({ createdAt: 1 });
    expect(buys.map((t) => t.shares)).toEqual([12, 3]);

    const holding = await HoldingModel.findOne({ portfolio_id: portfolioId, symbol: 'AAPL' });
    const recomputedShares = buys.reduce((sum, t) => sum + t.shares, 0);
    expect(holding.shares).toBe(recomputedShares);

    const sell = await TransactionModel.findOne({ userId, type: 'sell', symbol: 'TSLA' });
    expect(sell.metadata.realized_pnl).toBeCloseTo(221.40 - 205.10, 2);

    // Transactions are backdated (oldest first), not all stamped "now".
    const all = await TransactionModel.find({ userId }).sort({ createdAt: 1 });
    expect(all.length).toBeGreaterThan(5);
    expect(new Date(all[0].createdAt).getTime()).toBeLessThan(new Date(all[all.length - 1].createdAt).getTime());
    expect(Date.now() - new Date(all[0].createdAt).getTime()).toBeGreaterThan(40 * 24 * 60 * 60 * 1000);
  });

  it('seeds manual deposit/withdrawal records the manual-review pages can read', async () => {
    const { userId } = await demoService.resetDemoAccount();

    const manualDeposits = await TransactionModel.find({ userId, type: 'deposit', 'metadata.deposit_flow': 'manual_bank_transfer' });
    const manualWithdrawals = await TransactionModel.find({ userId, type: 'withdrawal', 'metadata.withdrawal_flow': 'manual_bank_transfer' });

    expect(manualDeposits).toHaveLength(1);
    expect(manualDeposits[0]).toMatchObject({ status: 'completed', total: 2500 });
    expect(manualWithdrawals).toHaveLength(1);
    expect(manualWithdrawals[0]).toMatchObject({ status: 'completed', total: 500 });
  });

  it('seeds a believable performance history', async () => {
    const { userId } = await demoService.resetDemoAccount();

    const snapshots = await PortfolioSnapshotModel.find({ user_id: userId }).sort({ captured_at: 1 });

    expect(snapshots.length).toBeGreaterThanOrEqual(40);
    expect(snapshots.every((s) => s.total_value > 0)).toBe(true);
    // Not a flat line: the seeded random walk should produce some day-to-day movement.
    const values = snapshots.map((s) => s.total_value);
    expect(new Set(values).size).toBeGreaterThan(values.length / 2);
  });

  it('seeds notifications, watchlist items, and both an active and a triggered alert', async () => {
    const { userId, portfolioId } = await demoService.resetDemoAccount();

    const notifications = await NotificationModel.find({ user_id: userId });
    expect(notifications.length).toBeGreaterThanOrEqual(3);
    expect(notifications.some((n) => !n.read)).toBe(true);
    expect(notifications.some((n) => n.read)).toBe(true);

    const watchlist = await WatchlistModel.find({ portfolio_id: portfolioId });
    expect(watchlist.length).toBeGreaterThanOrEqual(2);

    const alerts = await PriceAlertModel.find({ user_id: userId });
    expect(alerts.some((a) => a.status === 'active')).toBe(true);
    expect(alerts.some((a) => a.status === 'triggered' && a.notificationSent)).toBe(true);
  });

  it('is idempotent: resetting twice leaves exactly one copy of everything, no duplicate-key errors', async () => {
    await demoService.resetDemoAccount();
    await expect(demoService.resetDemoAccount()).resolves.toBeDefined();

    const users = await UserModel.find({ email: demoService.DEMO_EMAIL });
    expect(users).toHaveLength(1);
    const portfolios = await PortfolioModel.find({ user_id: users[0]._id });
    expect(portfolios).toHaveLength(1);

    const holdings = await HoldingModel.find({ portfolio_id: portfolios[0]._id });
    const symbols = holdings.map((h) => h.symbol);
    expect(new Set(symbols).size).toBe(symbols.length); // no duplicate symbol rows
  });

  it('replaces (does not accumulate on top of) a previous reset', async () => {
    await demoService.resetDemoAccount();
    const { userId: userId2, portfolioId } = await demoService.resetDemoAccount();

    expect(await TransactionModel.countDocuments({ userId: userId2 })).toBeLessThan(20);
    expect(await HoldingModel.countDocuments({ portfolio_id: portfolioId })).toBeLessThan(10);
  });

  it('keeps the same account id across resets, so an active demo session is not invalidated', async () => {
    const first = await demoService.resetDemoAccount();
    const second = await demoService.resetDemoAccount();

    expect(String(second.userId)).toBe(String(first.userId));
  });
});

describe('ensureDemoAccount', () => {
  it('creates the account on first use', async () => {
    const user = await demoService.ensureDemoAccount();

    expect(user).toMatchObject({ email: demoService.DEMO_EMAIL, isDemo: true });
    expect(await HoldingModel.countDocuments()).toBeGreaterThan(0);
  });

  it('does not reset (or lose) data that already exists', async () => {
    await demoService.resetDemoAccount();
    await TransactionModel.create({
      userId: (await UserModel.findOne({ email: demoService.DEMO_EMAIL }))._id,
      symbol: 'CASH',
      type: 'deposit',
      total: 1,
      status: 'completed',
      reference_id: 'visitor-marker',
    });

    await demoService.ensureDemoAccount();

    expect(await TransactionModel.countDocuments({ reference_id: 'visitor-marker' })).toBe(1);
  });

  it('is safe to call concurrently the very first time (no duplicate accounts or crashes)', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => demoService.ensureDemoAccount()));

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await UserModel.countDocuments({ email: demoService.DEMO_EMAIL })).toBe(1);
  });
});
