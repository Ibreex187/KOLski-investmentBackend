// The market service must never invent prices outside the test environment.
// These tests flip NODE_ENV to "production" (Jest sets "test") and mock the provider.

jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('../utils/redis', () => ({
  safeGet: jest.fn().mockResolvedValue(null),
  safeSet: jest.fn().mockResolvedValue(undefined),
}));

const axios = require('axios');
const redis = require('../utils/redis');
const marketService = require('../services/market.service');

const { getQuote, searchSymbol, getHistoricalData, MarketDataUnavailableError } = marketService;

const liveQuotePayload = {
  'Global Quote': {
    '01. symbol': 'AAPL',
    '05. price': '190.1200',
    '06. volume': '1000',
    '07. latest trading day': '2026-09-18',
    '09. change': '1.10',
    '10. change percent': '0.58%',
  },
};

describe('market.service outside the test environment', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.ALPHA_VANTAGE_KEY = 'test-key';
    delete process.env.ALLOW_DEMO_MARKET_DATA;
    axios.get.mockReset();
    redis.safeGet.mockReset().mockResolvedValue(null);
    redis.safeSet.mockReset().mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getQuote', () => {
    it('returns the live price labelled as live and caches it', async () => {
      axios.get.mockResolvedValue({ data: liveQuotePayload });

      const quote = await getQuote('aapl');

      expect(quote).toMatchObject({ symbol: 'AAPL', price: 190.12, source: 'live' });
      expect(axios.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timeout: expect.any(Number) })
      );
      expect(redis.safeSet).toHaveBeenCalledWith('quote:AAPL', expect.any(String), 'EX', 60);
    });

    it('serves a cached quote without calling the provider', async () => {
      redis.safeGet.mockResolvedValue(JSON.stringify({ symbol: 'AAPL', price: 150, source: 'live' }));

      const quote = await getQuote('AAPL');

      expect(quote.price).toBe(150);
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('rejects instead of returning a fake price when the provider is rate limited', async () => {
      // Alpha Vantage signals quota exhaustion with HTTP 200 and a Note/Information field.
      axios.get.mockResolvedValue({ data: { Note: 'Thank you for using Alpha Vantage! Rate limit reached.' } });

      await expect(getQuote('AAPL')).rejects.toMatchObject({
        name: 'MarketDataUnavailableError',
        code: 'MARKET_DATA_UNAVAILABLE',
        status: 503,
      });
    });

    it('rejects when the provider request fails', async () => {
      axios.get.mockRejectedValue(new Error('socket hang up'));

      await expect(getQuote('AAPL')).rejects.toBeInstanceOf(MarketDataUnavailableError);
    });

    it('rejects when no API key is configured, without calling the provider', async () => {
      delete process.env.ALPHA_VANTAGE_KEY;

      await expect(getQuote('AAPL')).rejects.toBeInstanceOf(MarketDataUnavailableError);
      expect(axios.get).not.toHaveBeenCalled();
    });

    it.each([['0.0000'], ['-5'], ['not-a-number']])('rejects an invalid price (%s)', async (badPrice) => {
      axios.get.mockResolvedValue({
        data: { 'Global Quote': { ...liveQuotePayload['Global Quote'], '05. price': badPrice } },
      });

      await expect(getQuote('AAPL')).rejects.toBeInstanceOf(MarketDataUnavailableError);
      expect(redis.safeSet).not.toHaveBeenCalled();
    });

    it('rejects for an unknown symbol (empty quote)', async () => {
      axios.get.mockResolvedValue({ data: { 'Global Quote': {} } });

      await expect(getQuote('NOPE')).rejects.toBeInstanceOf(MarketDataUnavailableError);
    });

    it('serves clearly labelled demo data only when ALLOW_DEMO_MARKET_DATA=true', async () => {
      process.env.ALLOW_DEMO_MARKET_DATA = 'true';
      axios.get.mockRejectedValue(new Error('provider down'));

      const quote = await getQuote('TSLA');

      expect(quote).toMatchObject({ symbol: 'TSLA', source: 'demo' });
    });

    it('does not treat any other ALLOW_DEMO_MARKET_DATA value as opt-in', async () => {
      process.env.ALLOW_DEMO_MARKET_DATA = '1';
      axios.get.mockRejectedValue(new Error('provider down'));

      await expect(getQuote('TSLA')).rejects.toBeInstanceOf(MarketDataUnavailableError);
    });
  });

  describe('searchSymbol', () => {
    it('returns provider matches', async () => {
      axios.get.mockResolvedValue({
        data: { bestMatches: [{ '1. symbol': 'AAPL', '2. name': 'Apple Inc', '3. type': 'Equity', '4. region': 'United States' }] },
      });

      await expect(searchSymbol('apple')).resolves.toEqual([
        { symbol: 'AAPL', name: 'Apple Inc', type: 'Equity', region: 'United States' },
      ]);
    });

    it('returns an empty list (not a fake match) when nothing matches', async () => {
      axios.get.mockResolvedValue({ data: { bestMatches: [] } });

      await expect(searchSymbol('zzzzzz')).resolves.toEqual([]);
    });

    it('rejects when the provider is rate limited', async () => {
      axios.get.mockResolvedValue({ data: { Information: 'API rate limit' } });

      await expect(searchSymbol('apple')).rejects.toBeInstanceOf(MarketDataUnavailableError);
    });
  });

  describe('getHistoricalData', () => {
    it('maps the daily series', async () => {
      axios.get.mockResolvedValue({
        data: { 'Time Series (Daily)': { '2026-09-18': { '4. close': '190.5', '5. volume': '900' } } },
      });

      await expect(getHistoricalData('aapl')).resolves.toEqual([
        { date: '2026-09-18', close: 190.5, volume: 900, symbol: 'AAPL' },
      ]);
    });

    it('rejects instead of fabricating history when the provider returns no series', async () => {
      axios.get.mockResolvedValue({ data: { Note: 'limit' } });

      await expect(getHistoricalData('AAPL')).rejects.toBeInstanceOf(MarketDataUnavailableError);
    });
  });
});

describe('market.service in the test environment', () => {
  it('keeps serving deterministic demo data, labelled as demo', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      await expect(getQuote('MSFT')).resolves.toMatchObject({ symbol: 'MSFT', price: 185.42, source: 'demo' });
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});
