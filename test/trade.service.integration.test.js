// Trade execution against a real (in-memory, standalone) MongoDB.
//
// A standalone server has no multi-document transactions, so these tests exercise the
// path that depends purely on atomic conditional updates plus the rollback stack.
// The replica-set / transaction path is covered in trade.transactions.integration.test.js.

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
const { MarketDataUnavailableError } = require('../services/market.service');

jest.setTimeout(120000);

const quoteAt = (price, source = 'live') => ({ getQuote: jest.fn().mockResolvedValue({ symbol: 'X', price, source }) });

async function cashOf(userId) {
  return (await PortfolioModel.findOne({ user_id: userId })).cash_balance;
}

async function holdingOf(portfolioId, symbol = 'AAPL') {
  return HoldingModel.findOne({ portfolio_id: portfolioId, symbol });
}

let refCounter = 0;
const ref = () => `ref-${Date.now()}-${refCounter++}`;

beforeAll(async () => {
  await startMemoryMongo();
});

afterAll(async () => {
  await stopMemoryMongo();
});

beforeEach(async () => {
  await resetCollections();
});

describe('#1 execution price is decided by the server', () => {
  it('ignores a client-supplied price on buy', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 1000 });

    // A malicious client claims the stock costs one cent.
    const result = await portfolioService.buyStock(
      userId,
      { symbol: 'AAPL', shares: 2, price: 0.01, reference_id: ref() },
      quoteAt(100)
    );

    expect(result).toMatchObject({ success: true, price: 100, total: 200, price_source: 'live' });
    expect(await cashOf(userId)).toBe(800);

    const tx = await TransactionModel.findOne({ userId, type: 'buy' });
    expect(tx.price).toBe(100);
    expect(tx.total).toBe(200);
    expect((await holdingOf(portfolio._id)).average_price).toBe(100);
  });

  it('ignores a client-supplied price on sell', async () => {
    const { userId } = await createPortfolio({ cash: 1000 });
    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 10 }, quoteAt(100));

    // A malicious client claims a huge sell price.
    const result = await portfolioService.sellStock(
      userId,
      { symbol: 'AAPL', shares: 4, price: 1000000 },
      quoteAt(120)
    );

    expect(result).toMatchObject({ price: 120, total: 480, realized_pnl: 80 });
    expect(await cashOf(userId)).toBe(480); // bought 10 @ 100 (all $1000), sold 4 @ 120 server-side
  });

  it('records where the price came from', async () => {
    const { userId } = await createPortfolio({ cash: 1000 });

    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1 }, quoteAt(100, 'demo'));

    const tx = await TransactionModel.findOne({ userId });
    expect(tx.metadata.price_source).toBe('demo');
  });

  it('refuses to trade when market data is unavailable and changes nothing', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 1000 });
    const unavailable = { getQuote: jest.fn().mockRejectedValue(new MarketDataUnavailableError()) };

    await expect(
      portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1 }, unavailable)
    ).rejects.toMatchObject({ code: 'MARKET_DATA_UNAVAILABLE', status: 503 });

    expect(await cashOf(userId)).toBe(1000);
    expect(await holdingOf(portfolio._id)).toBeNull();
    expect(await TransactionModel.countDocuments({ userId })).toBe(0);
  });

  it.each([[0], [-1], [NaN], [undefined], ['100']])('refuses to trade on an invalid quote price (%p)', async (badPrice) => {
    const { userId } = await createPortfolio({ cash: 1000 });
    const badQuote = { getQuote: jest.fn().mockResolvedValue({ price: badPrice }) };

    await expect(
      portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1 }, badQuote)
    ).rejects.toMatchObject({ code: 'MARKET_DATA_UNAVAILABLE' });
    expect(await cashOf(userId)).toBe(1000);
  });
});

describe('order validation', () => {
  it.each([
    ['zero shares', { symbol: 'AAPL', shares: 0 }, /positive number/],
    ['negative shares', { symbol: 'AAPL', shares: -5 }, /positive number/],
    ['NaN shares', { symbol: 'AAPL', shares: NaN }, /positive number/],
    ['Infinity shares', { symbol: 'AAPL', shares: Infinity }, /positive number/],
    ['string shares', { symbol: 'AAPL', shares: '5' }, /positive number/],
    ['too many decimals', { symbol: 'AAPL', shares: 0.1234567 }, /decimal places/],
    ['missing symbol', { shares: 1 }, /Symbol is required/],
    ['blank symbol', { symbol: '   ', shares: 1 }, /Symbol is required/],
    ['operator-looking symbol', { symbol: '{"$ne":1}', shares: 1 }, /Symbol is invalid/],
  ])('rejects %s with a 400 before touching money', async (_label, payload, message) => {
    const { userId } = await createPortfolio({ cash: 1000 });
    const quote = quoteAt(100);

    await expect(portfolioService.buyStock(userId, payload, quote)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(message),
    });
    expect(quote.getQuote).not.toHaveBeenCalled();
    expect(await cashOf(userId)).toBe(1000);
  });

  it('rejects dust orders that would round to a free purchase', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 1000 });

    // 0.000001 shares at $1 rounds to $0.00 — previously free shares.
    await expect(
      portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 0.000001 }, quoteAt(1))
    ).rejects.toMatchObject({ status: 400, message: /too small/ });

    expect(await holdingOf(portfolio._id)).toBeNull();
    expect(await cashOf(userId)).toBe(1000);
  });

  it('returns 404 when the user has no portfolio', async () => {
    await expect(
      portfolioService.buyStock('64b000000000000000000001', { symbol: 'AAPL', shares: 1 }, quoteAt(100))
    ).rejects.toMatchObject({ status: 404, message: 'Portfolio not found' });
  });

  it('stores user-supplied text literally (no operator injection through the pipeline update)', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 1000 });

    await portfolioService.buyStock(
      userId,
      { symbol: 'AAPL', shares: 1, name: '$cash_balance', sector: '$shares' },
      quoteAt(100)
    );

    const holding = await holdingOf(portfolio._id);
    expect(holding.name).toBe('$cash_balance');
    expect(holding.sector).toBe('$shares');
  });
});

describe('buy and sell bookkeeping', () => {
  it('averages the cost across buys at different prices', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 10000 });

    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 10 }, quoteAt(100));
    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 10 }, quoteAt(200));

    const holding = await holdingOf(portfolio._id);
    expect(holding.shares).toBe(20);
    expect(holding.average_price).toBe(150);
    expect(await cashOf(userId)).toBe(10000 - 1000 - 2000);
  });

  it('supports fractional shares without floating point drift', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 1000 });

    for (let i = 0; i < 10; i += 1) {
      await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 0.1 }, quoteAt(10));
    }

    expect((await holdingOf(portfolio._id)).shares).toBe(1);
    expect(await cashOf(userId)).toBe(990);
  });

  it('keeps the average price on a partial sell and tracks realized P&L', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 5000 });
    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 10 }, quoteAt(100));

    await portfolioService.sellStock(userId, { symbol: 'AAPL', shares: 4 }, quoteAt(150));

    const holding = await holdingOf(portfolio._id);
    expect(holding.shares).toBe(6);
    expect(holding.average_price).toBe(100);
    const updated = await PortfolioModel.findOne({ user_id: userId });
    expect(updated.cash_balance).toBe(5000 - 1000 + 600);
    expect(updated.performance.realized_pnl).toBe(200);
  });

  it('removes the holding when everything is sold', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 5000 });
    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 3 }, quoteAt(100));

    await portfolioService.sellStock(userId, { symbol: 'AAPL', shares: 3 }, quoteAt(100));

    expect(await holdingOf(portfolio._id)).toBeNull();
    expect(await cashOf(userId)).toBe(5000);
  });

  it('rejects selling more than is held, or a symbol that is not held', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 5000 });
    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 2 }, quoteAt(100));

    await expect(
      portfolioService.sellStock(userId, { symbol: 'AAPL', shares: 3 }, quoteAt(100))
    ).rejects.toMatchObject({ status: 400, message: 'Not enough shares' });
    await expect(
      portfolioService.sellStock(userId, { symbol: 'MSFT', shares: 1 }, quoteAt(100))
    ).rejects.toMatchObject({ status: 400, message: 'Not enough shares' });

    expect((await holdingOf(portfolio._id)).shares).toBe(2);
    expect(await cashOf(userId)).toBe(4800);
  });

  it('rejects a buy the balance cannot cover', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 50 });

    await expect(
      portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1 }, quoteAt(100))
    ).rejects.toMatchObject({ status: 400, message: 'Insufficient funds' });

    expect(await cashOf(userId)).toBe(50);
    expect(await holdingOf(portfolio._id)).toBeNull();
  });

  it('allows spending the balance exactly to zero', async () => {
    const { userId } = await createPortfolio({ cash: 100 });

    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1 }, quoteAt(100));

    expect(await cashOf(userId)).toBe(0);
  });
});

describe('#4 concurrent orders cannot double-spend or oversell', () => {
  it('lets only affordable buys through when many race for the same cash', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 1000 });

    // 12 simultaneous $600 orders against $1000: at most one can be afforded.
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 6, reference_id: ref() }, quoteAt(100))
      )
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(11);
    rejected.forEach((r) => expect(r.reason.message).toBe('Insufficient funds'));

    expect(await cashOf(userId)).toBe(400);
    expect((await holdingOf(portfolio._id)).shares).toBe(6);
    expect(await TransactionModel.countDocuments({ userId, type: 'buy' })).toBe(1);
  });

  it('never lets cash go negative under a burst of mixed-size orders', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 1000 });

    const sizes = [3, 4, 5, 2, 6, 1, 7, 3, 2, 4, 5, 6]; // each share costs $100
    const results = await Promise.allSettled(
      sizes.map((shares) =>
        portfolioService.buyStock(userId, { symbol: 'AAPL', shares, reference_id: ref() }, quoteAt(100))
      )
    );

    const bought = results
      .map((r, i) => (r.status === 'fulfilled' ? sizes[i] : 0))
      .reduce((a, b) => a + b, 0);

    const cash = await cashOf(userId);
    expect(cash).toBeGreaterThanOrEqual(0);
    expect(cash).toBe(1000 - bought * 100);
    expect((await holdingOf(portfolio._id))?.shares ?? 0).toBe(bought);
  });

  it('applies every buy of the same symbol exactly once when all are affordable', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 100000 });

    // Includes the first-buy race on the unique (portfolio, symbol) index.
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 2, reference_id: ref() }, quoteAt(100))
      )
    );

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const holding = await holdingOf(portfolio._id);
    expect(holding.shares).toBe(50);
    expect(holding.average_price).toBe(100);
    expect(await cashOf(userId)).toBe(100000 - 5000);
    expect(await HoldingModel.countDocuments({ portfolio_id: portfolio._id })).toBe(1);
  });

  it('lets only the shares actually held be sold under concurrent sells', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 5000 });
    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 5 }, quoteAt(100));

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        portfolioService.sellStock(userId, { symbol: 'AAPL', shares: 1, reference_id: ref() }, quoteAt(100))
      )
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    results
      .filter((r) => r.status === 'rejected')
      .forEach((r) => expect(r.reason.message).toBe('Not enough shares'));

    expect(await holdingOf(portfolio._id)).toBeNull();
    expect(await cashOf(userId)).toBe(5000); // bought 5 @100, sold 5 @100
    expect(await TransactionModel.countDocuments({ userId, type: 'sell' })).toBe(5);
  });

  it('keeps cash and holdings consistent when buys and sells interleave', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 10000 });
    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 20 }, quoteAt(100));

    const orders = [
      ...Array.from({ length: 10 }, () => () =>
        portfolioService.sellStock(userId, { symbol: 'AAPL', shares: 2, reference_id: ref() }, quoteAt(100))),
      ...Array.from({ length: 10 }, () => () =>
        portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1, reference_id: ref() }, quoteAt(100))),
    ];
    const results = await Promise.allSettled(orders.map((run) => run()));

    const txs = await TransactionModel.find({ userId, status: 'completed' });
    const netShares = txs.reduce((sum, t) => sum + (t.type === 'buy' ? t.shares : -t.shares), 0);
    const netCash = txs.reduce((sum, t) => sum + (t.type === 'buy' ? -t.total : t.total), 0);

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect((await holdingOf(portfolio._id))?.shares ?? 0).toBe(netShares);
    expect(await cashOf(userId)).toBe(10000 + netCash);
  });
});

describe('idempotency', () => {
  it('returns the original result for a repeated reference without re-applying it', async () => {
    const { userId } = await createPortfolio({ cash: 1000 });
    const reference = ref();

    const first = await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1, reference_id: reference }, quoteAt(100));
    const second = await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1, reference_id: reference }, quoteAt(100));

    expect(first.duplicate).toBeUndefined();
    expect(second).toMatchObject({ success: true, duplicate: true, reference_id: reference });
    expect(String(second.transaction_id)).toBe(String(first.transaction_id));
    expect(await cashOf(userId)).toBe(900);
  });

  it('does not even fetch a price for a repeated reference (retry works during a market outage)', async () => {
    const { userId } = await createPortfolio({ cash: 1000 });
    const reference = ref();
    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1, reference_id: reference }, quoteAt(100));

    const unavailable = { getQuote: jest.fn().mockRejectedValue(new MarketDataUnavailableError()) };
    const retry = await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1, reference_id: reference }, unavailable);

    expect(retry.duplicate).toBe(true);
    expect(unavailable.getQuote).not.toHaveBeenCalled();
  });

  it('applies exactly one of many simultaneous requests carrying the same reference', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 1000 });
    const reference = ref();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1, reference_id: reference }, quoteAt(100))
      )
    );

    expect(results.every((r) => r.success)).toBe(true);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await cashOf(userId)).toBe(900);
    expect((await holdingOf(portfolio._id)).shares).toBe(1);
    expect(await TransactionModel.countDocuments({ userId, reference_id: reference })).toBe(1);
  });

  it('allows several orders without a reference (regression: null values collided on the unique index)', async () => {
    const { userId } = await createPortfolio({ cash: 1000 });

    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1 }, quoteAt(100));
    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1 }, quoteAt(100));
    await portfolioService.sellStock(userId, { symbol: 'AAPL', shares: 1 }, quoteAt(100));

    expect(await TransactionModel.countDocuments({ userId })).toBe(3);
    expect(await cashOf(userId)).toBe(900);
  });
});

describe('CSV export', () => {
  it('shows caller references but hides generated placeholder references', async () => {
    const { userId } = await createPortfolio({ cash: 1000 });
    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1 }, quoteAt(100));
    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 1, reference_id: 'my-ref-42' }, quoteAt(100));

    const csv = portfolioService.exportTransactionsToCsv(await TransactionModel.find({ userId }));

    expect(csv).toContain('my-ref-42');
    expect(csv).not.toContain('auto:');
  });
});

describe('rollback when a later step fails (no transaction support)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('restores cash and removes the new holding if recording the buy fails', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 1000 });
    jest.spyOn(TransactionModel, 'create').mockRejectedValue(new Error('disk full'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 2 }, quoteAt(100))
    ).rejects.toThrow('disk full');

    expect(await cashOf(userId)).toBe(1000);
    expect(await holdingOf(portfolio._id)).toBeNull();
  });

  it('restores an existing holding exactly (shares and average price) if recording a buy fails', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 5000 });
    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 10 }, quoteAt(100));

    jest.spyOn(TransactionModel, 'create').mockRejectedValue(new Error('disk full'));
    await expect(
      portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 5 }, quoteAt(400))
    ).rejects.toThrow('disk full');

    const holding = await holdingOf(portfolio._id);
    expect(holding.shares).toBe(10);
    expect(holding.average_price).toBe(100);
    expect(await cashOf(userId)).toBe(4000);
  });

  it('restores shares, cash and realized P&L if recording a sell fails', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 5000 });
    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 10 }, quoteAt(100));

    jest.spyOn(TransactionModel, 'create').mockRejectedValue(new Error('disk full'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      portfolioService.sellStock(userId, { symbol: 'AAPL', shares: 10 }, quoteAt(150))
    ).rejects.toThrow('disk full');

    expect((await holdingOf(portfolio._id)).shares).toBe(10);
    const updated = await PortfolioModel.findOne({ user_id: userId });
    expect(updated.cash_balance).toBe(4000);
    expect(updated.performance.realized_pnl).toBe(0);
  });
});
