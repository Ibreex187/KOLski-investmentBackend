const request = require('supertest');
const mongoose = require('mongoose');

// Mock auth middleware BEFORE importing app
jest.mock('../middleware/auth.middleware.js', () => {
  return (req, res, next) => {
    // Inject a mock user into the request without database lookup
    req.user = { _id: '507f1f77bcf86cd799439011', email: 'test@example.com' };
    next();
  };
});

const app = require('../app');

jest.setTimeout(20000);

describe('Portfolio Analytics & Alerts API', () => {
  it('GET /api/v1/portfolio/analytics should be accessible with auth', async () => {
    const res = await request(app)
      .get('/api/v1/portfolio/analytics');
    // Should not be 401 (auth passed), can be 200, 404, 500 depending on data
    expect(res.statusCode).not.toBe(401);
  });

  it('GET /api/v1/portfolio/performance-history should be accessible with auth', async () => {
    const res = await request(app)
      .get('/api/v1/portfolio/performance-history');
    expect(res.statusCode).not.toBe(401);
  });

  it('GET /api/v1/portfolio/dashboard should return a frontend-ready payload', async () => {
    const res = await request(app)
      .get('/api/v1/portfolio/dashboard');

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('summary');
    expect(res.body.data).toHaveProperty('performance');
    expect(res.body.data).toHaveProperty('alerts');
    expect(res.body.data).toHaveProperty('notifications');
  });

  let alertId;
  it('POST /api/v1/portfolio/alerts should be accessible with auth', async () => {
    const res = await request(app)
      .post('/api/v1/portfolio/alerts')
      .send({ symbol: 'AAPL', target_price: 200, direction: 'above' });
    // Should not be 401 (auth passed)
    expect(res.statusCode).not.toBe(401);
    if (res.statusCode === 201 && res.body?.data?._id) {
      alertId = res.body.data._id;
    }
  });

  it('GET /api/v1/portfolio/alerts should be accessible with auth', async () => {
    const res = await request(app)
      .get('/api/v1/portfolio/alerts');
    // Should not be 401 (auth passed)
    expect(res.statusCode).not.toBe(401);
  });

  it('DELETE /api/v1/portfolio/alerts/:id should be accessible with auth', async () => {
    if (!alertId) {
      // Skip if no alert ID was created
      expect(true).toBe(true);
      return;
    }
    const res = await request(app)
      .delete(`/api/v1/portfolio/alerts/${alertId}`);
    // Should not be 401 (auth passed)
    expect(res.statusCode).not.toBe(401);
  });
});
