const request = require('supertest');
const app = require('../app');

describe('CORS enforcement', () => {
  it('returns exact 403 JSON for disallowed origins', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://blocked-origin.example');

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: 'CORS_ORIGIN_NOT_ALLOWED',
      message: 'Request origin is not allowed'
    });
  });
});
