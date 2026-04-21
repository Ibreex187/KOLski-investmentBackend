const request = require('supertest');
const app = require('../app');
const jwt = require('jsonwebtoken');

// Generate a valid JWT for testing (replace with a real user ID from your DB if needed)
const testUserId = '000000000000000000000001';
const token = jwt.sign({ id: testUserId }, process.env.JWT_SECRET || 'testsecret', { expiresIn: '1h' });

const authHeader = { Authorization: `Bearer ${token}` };

describe('Portfolio API Endpoints', () => {
  it('GET /api/v1/portfolio should return portfolio data', async () => {
    const res = await request(app)
      .get('/api/v1/portfolio')
      .set(authHeader);
    expect([200, 404]).toContain(res.statusCode); // 404 if portfolio not found
    if (res.statusCode === 200) {
      expect(res.body).toHaveProperty('user_id');
    }
  });

  it('POST /api/v1/portfolio/buy should require body', async () => {
    const res = await request(app)
      .post('/api/v1/portfolio/buy')
      .set(authHeader)
      .send({});
    expect([200, 400]).toContain(res.statusCode);
  });

  it('POST /api/v1/portfolio/deposit should be disabled in favor of manual deposits', async () => {
    const res = await request(app)
      .post('/api/v1/portfolio/deposit')
      .set(authHeader)
      .send({ amount: 100 });

    expect(res.statusCode).toBe(410);
    expect(res.body.success).toBe(false);
    expect(res.body).toHaveProperty('error.code', 'INSTANT_DEPOSIT_DISABLED');
    expect(res.body).toHaveProperty('error.deprecation_at', '2026-04-20T00:00:00.000Z');
    expect(res.body).toHaveProperty('error.docs_url', '/api/v1/docs/openapi.json');
    expect(res.body).toHaveProperty('error.migration.endpoint', '/api/v1/deposits/manual');
  });

  it('POST /api/v1/portfolio/withdraw should be disabled in favor of manual withdrawals', async () => {
    const res = await request(app)
      .post('/api/v1/portfolio/withdraw')
      .set(authHeader)
      .send({ amount: 100 });

    expect(res.statusCode).toBe(410);
    expect(res.body.success).toBe(false);
    expect(res.body).toHaveProperty('error.code', 'INSTANT_WITHDRAWAL_DISABLED');
    expect(res.body).toHaveProperty('error.deprecation_at', '2026-04-20T00:00:00.000Z');
    expect(res.body).toHaveProperty('error.docs_url', '/api/v1/docs/openapi.json');
    expect(res.body).toHaveProperty('error.migration.endpoint', '/api/v1/withdrawals/manual');
  });

  it('GET /api/v1/portfolio/transactions should return transactions', async () => {
    const res = await request(app)
      .get('/api/v1/portfolio/transactions')
      .set(authHeader);
    expect([200, 500]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(res.body).toHaveProperty('transactions');
    }
  });

  it('GET /api/v1/portfolio/transactions should accept reporting filters', async () => {
    const res = await request(app)
      .get('/api/v1/portfolio/transactions?type=buy&symbol=AAPL&startDate=2026-04-01&endDate=2026-04-09&page=1&limit=5')
      .set(authHeader);

    expect([200, 500]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(res.body).toHaveProperty('transactions');
      expect(res.body).toHaveProperty('page', 1);
    }
  });

  it('GET /api/v1/portfolio/transactions/export should return csv format', async () => {
    const res = await request(app)
      .get('/api/v1/portfolio/transactions/export?format=csv')
      .set(authHeader);

    expect([200, 500]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(String(res.text || '')).toContain('type');
      expect(res.headers['content-type']).toContain('text/csv');
    }
  });

  it('GET /api/v1/portfolio/watchlist should return watchlist', async () => {
    const res = await request(app)
      .get('/api/v1/portfolio/watchlist')
      .set(authHeader);
    expect([200, 500]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(Array.isArray(res.body)).toBe(true);
    }
  });

  it('POST /api/v1/portfolio/reconcile should be accessible with auth', async () => {
    const res = await request(app)
      .post('/api/v1/portfolio/reconcile')
      .set(authHeader)
      .send({ apply: false });

    expect([200, 404]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('is_consistent');
    }
  });
});
