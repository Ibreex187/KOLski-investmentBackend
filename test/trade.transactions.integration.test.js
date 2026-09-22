// Trade execution on a single-node replica set, i.e. with real multi-document
// transactions (what MongoDB Atlas provides in production). A failed order must be
// rolled back by the database itself rather than by the service's undo stack.

const mongoose = require('mongoose');
const {
  startMemoryMongo,
  stopMemoryMongo,
  resetCollections,
  createPortfolio,
} = require('./helpers/memory.mongo');

const PortfolioModel = require('../models/portfolio.model');
const HoldingModel = require('../models/holding.model');
const TransactionModel = require('../models/transaction.model');
const portfolioService = require('../services/portfolio.service');

jest.setTimeout(180000);

const quoteAt = (price) => ({ getQuote: jest.fn().mockResolvedValue({ price, source: 'live' }) });
const cashOf = async (userId) => (await PortfolioModel.findOne({ user_id: userId })).cash_balance;

let refCounter = 0;
const ref = () => `txn-ref-${Date.now()}-${refCounter++}`;

beforeAll(async () => {
  await startMemoryMongo({ replSet: true });
});

afterAll(async () => {
  await stopMemoryMongo();
});

beforeEach(async () => {
  await resetCollections();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('trades inside a real MongoDB transaction', () => {
  it('runs a buy in a transaction and commits every write', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 1000 });
    const startSession = jest.spyOn(mongoose, 'startSession');

    const result = await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 2, reference_id: ref() }, quoteAt(100));

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, price: 100, total: 200 });
    expect(await cashOf(userId)).toBe(800);
    expect((await HoldingModel.findOne({ portfolio_id: portfolio._id })).shares).toBe(2);
    expect(await TransactionModel.countDocuments({ userId })).toBe(1);
  });

  it('rolls the whole buy back in the database if the last write fails', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 1000 });
    jest.spyOn(TransactionModel, 'create').mockRejectedValue(new Error('disk full'));

    await expect(
      portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 2 }, quoteAt(100))
    ).rejects.toThrow('disk full');

    expect(await cashOf(userId)).toBe(1000);
    expect(await HoldingModel.countDocuments({ portfolio_id: portfolio._id })).toBe(0);
  });

  it('rolls the whole sell back in the database if the last write fails', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 1000 });
    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 5 }, quoteAt(100));
    const createSpy = jest.spyOn(TransactionModel, 'create').mockRejectedValue(new Error('disk full'));

    await expect(
      portfolioService.sellStock(userId, { symbol: 'AAPL', shares: 5 }, quoteAt(150))
    ).rejects.toThrow('disk full');

    createSpy.mockRestore();
    expect(await cashOf(userId)).toBe(500);
    expect((await HoldingModel.findOne({ portfolio_id: portfolio._id })).shares).toBe(5);
  });

  it('still lets only one of many competing buys spend the same cash', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 1000 });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 6, reference_id: ref() }, quoteAt(100))
      )
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await cashOf(userId)).toBe(400);
    expect((await HoldingModel.findOne({ portfolio_id: portfolio._id })).shares).toBe(6);
    expect(await TransactionModel.countDocuments({ userId, type: 'buy' })).toBe(1);
  });

  it('applies exactly one of many simultaneous requests carrying the same reference', async () => {
    const { userId } = await createPortfolio({ cash: 1000 });
    const reference = ref();

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1, reference_id: reference }, quoteAt(100))
      )
    );

    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await cashOf(userId)).toBe(900);
    expect(await TransactionModel.countDocuments({ userId, reference_id: reference })).toBe(1);
  });
});
