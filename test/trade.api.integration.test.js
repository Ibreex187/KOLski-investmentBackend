// End-to-end through the HTTP layer (auth middleware -> controller -> service -> MongoDB).

const request = require('supertest');
const {
  startMemoryMongo,
  stopMemoryMongo,
  resetCollections,
  createPortfolio,
} = require('./helpers/memory.mongo');

const PortfolioModel = require('../models/portfolio.model');
const HoldingModel = require('../models/holding.model');
const NotificationModel = require('../models/notification.model');
const marketService = require('../services/market.service');
const { generateAccessToken } = require('../utils/jwt');

jest.setTimeout(120000);

// In the test environment the market service serves a deterministic $185.42 quote.
const MARKET_PRICE = 185.42;

const authFor = (userId) => ({ Authorization: `Bearer ${generateAccessToken(userId)}` });
const cashOf = async (userId) => (await PortfolioModel.findOne({ user_id: userId })).cash_balance;

let app;

beforeAll(async () => {
  await startMemoryMongo();
  // app.js switches mongoose to bufferCommands=false and registers every model at import
  // time, so it must be loaded only once the connection is open.
  app = require('../app');
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

describe('POST /api/v1/portfolio/buy', () => {
  it('fills at the server-side market price even if the client sends a different price', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 1000 });

    const res = await request(app)
      .post('/api/v1/portfolio/buy')
      .set(authFor(userId))
      .send({ symbol: 'aapl', shares: 1, price: 0.01 });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ symbol: 'AAPL', shares: 1, price: MARKET_PRICE, total: MARKET_PRICE });
    expect(res.body.data.message).toContain(String(MARKET_PRICE));
    expect(await cashOf(userId)).toBe(1000 - MARKET_PRICE);
    expect((await HoldingModel.findOne({ portfolio_id: portfolio._id })).average_price).toBe(MARKET_PRICE);
  });

  it('no longer requires a price in the body', async () => {
    const { userId } = await createPortfolio({ cash: 1000 });

    const res = await request(app).post('/api/v1/portfolio/buy').set(authFor(userId)).send({ symbol: 'AAPL', shares: 1 });

    expect(res.statusCode).toBe(200);
  });

  it('responds 503 with a stable code, and changes nothing, when market data is unavailable', async () => {
    const { userId } = await createPortfolio({ cash: 1000 });
    jest.spyOn(marketService, 'getQuote').mockRejectedValue(new marketService.MarketDataUnavailableError());

    const res = await request(app).post('/api/v1/portfolio/buy').set(authFor(userId)).send({ symbol: 'AAPL', shares: 1 });

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ success: false, error: { code: 'MARKET_DATA_UNAVAILABLE' } });
    expect(await cashOf(userId)).toBe(1000);
  });

  it('responds 400 when the balance cannot cover the order', async () => {
    const { userId } = await createPortfolio({ cash: 10 });

    const res = await request(app).post('/api/v1/portfolio/buy').set(authFor(userId)).send({ symbol: 'AAPL', shares: 1 });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: 'Insufficient funds' });
    expect(await cashOf(userId)).toBe(10);
  });

  it.each([
    [{}, 'Symbol is required'],
    [{ symbol: 'AAPL' }, 'Shares must be a positive number'],
    [{ symbol: 'AAPL', shares: -1 }, 'Shares must be a positive number'],
    [{ symbol: 'AAPL', shares: '2' }, 'Shares must be a positive number'],
    [{ symbol: 'AAPL', shares: 0.1234567 }, /decimal places/],
  ])('responds 400 for an invalid body %j', async (body, message) => {
    const { userId } = await createPortfolio({ cash: 1000 });

    const res = await request(app).post('/api/v1/portfolio/buy').set(authFor(userId)).send(body);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toEqual(typeof message === 'string' ? message : expect.stringMatching(message));
  });

  it('does not leak internal error details on unexpected failures', async () => {
    const { userId } = await createPortfolio({ cash: 1000 });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(PortfolioModel, 'findOne').mockImplementationOnce(() => {
      throw new Error('E11000 secret internal connection string mongodb://user:pass@host');
    });

    const res = await request(app).post('/api/v1/portfolio/buy').set(authFor(userId)).send({ symbol: 'AAPL', shares: 1 });

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Trade could not be completed');
    expect(JSON.stringify(res.body)).not.toContain('mongodb://');
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/portfolio/buy').send({ symbol: 'AAPL', shares: 1 });

    expect(res.statusCode).toBe(401);
  });

  it('treats a retried request with the same idempotency key as done, without notifying twice', async () => {
    const { userId } = await createPortfolio({ cash: 1000 });
    const send = () =>
      request(app)
        .post('/api/v1/portfolio/buy')
        .set({ ...authFor(userId), 'x-idempotency-key': 'retry-me-1' })
        .send({ symbol: 'AAPL', shares: 1 });

    const first = await send();
    const second = await send();

    expect(first.body.data.duplicate).toBeUndefined();
    expect(second.statusCode).toBe(200);
    expect(second.body.data).toMatchObject({ duplicate: true, message: 'This order was already processed.' });
    expect(await cashOf(userId)).toBe(1000 - MARKET_PRICE);
    expect(await NotificationModel.countDocuments({ user_id: userId })).toBe(1);
  });
});

describe('POST /api/v1/portfolio/sell', () => {
  it('fills at the server-side market price even if the client sends a different price', async () => {
    const { userId, portfolio } = await createPortfolio({ cash: 1000 });
    await request(app).post('/api/v1/portfolio/buy').set(authFor(userId)).send({ symbol: 'AAPL', shares: 2 });

    const res = await request(app)
      .post('/api/v1/portfolio/sell')
      .set(authFor(userId))
      .send({ symbol: 'AAPL', shares: 2, price: 9999999 });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ price: MARKET_PRICE, realized_pnl: 0 });
    expect(await cashOf(userId)).toBe(1000);
    expect(await HoldingModel.countDocuments({ portfolio_id: portfolio._id })).toBe(0);
  });

  it('responds 400 when selling shares that are not held', async () => {
    const { userId } = await createPortfolio({ cash: 1000 });

    const res = await request(app).post('/api/v1/portfolio/sell').set(authFor(userId)).send({ symbol: 'AAPL', shares: 1 });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Not enough shares');
  });

  it('responds 503 when market data is unavailable', async () => {
    const { userId } = await createPortfolio({ cash: 1000 });
    jest.spyOn(marketService, 'getQuote').mockRejectedValue(new marketService.MarketDataUnavailableError());

    const res = await request(app).post('/api/v1/portfolio/sell').set(authFor(userId)).send({ symbol: 'AAPL', shares: 1 });

    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('MARKET_DATA_UNAVAILABLE');
  });
});
