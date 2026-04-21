const request = require('supertest');
const app = require('../app');
const jwt = require('jsonwebtoken');

// Generate a valid JWT for testing (replace with a real user ID from your DB if needed)
const testUserId = '000000000000000000000001';
const token = jwt.sign({ id: testUserId }, process.env.JWT_SECRET || 'testsecret', { expiresIn: '1h' });

const authHeader = { Authorization: `Bearer ${token}` };

describe('Market API Endpoints', () => {
  it('GET /api/v1/market/quote/:symbol should return quote data', async () => {
    const res = await request(app)
      .get('/api/v1/market/quote/AAPL')
      .set(authHeader);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('symbol', 'AAPL');
  });

  it('GET /api/v1/market/search?q=apple should return search results', async () => {
    const res = await request(app)
      .get('/api/v1/market/search?q=apple')
      .set(authHeader);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/v1/market/history/:symbol should return historical data', async () => {
    const res = await request(app)
      .get('/api/v1/market/history/AAPL')
      .set(authHeader);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/v1/market/portfolio-prices should return prices object or empty', async () => {
    const res = await request(app)
      .get('/api/v1/market/portfolio-prices')
      .set(authHeader);
    expect(res.statusCode).toBe(200);
    expect(typeof res.body).toBe('object');
  });
});
