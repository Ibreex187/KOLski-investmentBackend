// When the market provider is down the API must say so (503 + stable code),
// not answer 200 with invented data or a generic 500.

jest.mock('../services/market.service', () => {
  class MarketDataUnavailableError extends Error {
    constructor(message = 'Market data is temporarily unavailable') {
      super(message);
      this.name = 'MarketDataUnavailableError';
      this.code = 'MARKET_DATA_UNAVAILABLE';
      this.status = 503;
    }
  }

  return {
    MarketDataUnavailableError,
    getQuote: jest.fn().mockRejectedValue(new MarketDataUnavailableError()),
    searchSymbol: jest.fn().mockRejectedValue(new MarketDataUnavailableError()),
    getHistoricalData: jest.fn().mockRejectedValue(new MarketDataUnavailableError()),
  };
});

const request = require('supertest');
const app = require('../app');
const { generateAccessToken } = require('../utils/jwt');

const auth = { Authorization: `Bearer ${generateAccessToken('000000000000000000000001')}` };

describe('market endpoints during a provider outage', () => {
  it.each([
    ['/api/v1/market/quote/AAPL'],
    ['/api/v1/market/search?q=apple'],
    ['/api/v1/market/history/AAPL'],
  ])('GET %s responds 503 with MARKET_DATA_UNAVAILABLE', async (path) => {
    const res = await request(app).get(path).set(auth);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'MARKET_DATA_UNAVAILABLE', message: expect.any(String) },
    });
  });
});
