jest.mock('../models/portfolio.model', () => ({
  findOne: jest.fn(),
}));

jest.mock('../models/holding.model', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));

jest.mock('../models/transaction.model', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));

const mongoose = require('mongoose');
const PortfolioModel = require('../models/portfolio.model');
const HoldingModel = require('../models/holding.model');
const TransactionModel = require('../models/transaction.model');
const portfolioService = require('../services/portfolio.service');

describe('Portfolio service transaction integrity', () => {
  const originalReadyState = mongoose.connection.readyState;

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    Object.defineProperty(mongoose.connection, 'readyState', {
      value: originalReadyState,
      configurable: true,
    });
  });

  it('should execute buyStock inside a mongoose transaction when a DB session is available', async () => {
    Object.defineProperty(mongoose.connection, 'readyState', {
      value: 1,
      configurable: true,
    });

    const session = {
      withTransaction: jest.fn(async (callback) => callback()),
      endSession: jest.fn(),
    };

    jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);

    const portfolio = {
      _id: 'portfolio-1',
      cash_balance: 1000,
      last_updated: null,
      performance: { realized_pnl: 0 },
      save: jest.fn().mockResolvedValue(true),
    };

    PortfolioModel.findOne.mockResolvedValue(portfolio);
    HoldingModel.findOne.mockResolvedValue(null);
    HoldingModel.create.mockResolvedValue([{ _id: 'holding-1' }]);
    TransactionModel.findOne.mockResolvedValue(null);
    TransactionModel.create.mockResolvedValue([{ _id: 'tx-1' }]);

    const result = await portfolioService.buyStock('user-1', {
      symbol: 'AAPL',
      name: 'Apple Inc.',
      shares: 2,
      price: 100,
      reference_id: 'buy-ref-1',
    });

    expect(mongoose.startSession).toHaveBeenCalledTimes(1);
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(portfolio.save).toHaveBeenCalled();
    expect(HoldingModel.create).toHaveBeenCalled();
    expect(TransactionModel.create).toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalledTimes(1);
    expect(result).toHaveProperty('success', true);
  });
});
