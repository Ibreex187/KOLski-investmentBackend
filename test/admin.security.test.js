const request = require('supertest');
const app = require('../app');
const { generateToken } = require('../utils/jwt');

const userHeader = {
  Authorization: `Bearer ${generateToken('000000000000000000000001', { role: 'user' })}`,
};

const adminHeader = {
  Authorization: `Bearer ${generateToken('000000000000000000000002', { role: 'admin' })}`,
};

describe('Admin + security hardening', () => {
  const originalManualDepositsEnabled = process.env.MANUAL_DEPOSITS_ENABLED;

  afterEach(() => {
    if (originalManualDepositsEnabled === undefined) {
      delete process.env.MANUAL_DEPOSITS_ENABLED;
    } else {
      process.env.MANUAL_DEPOSITS_ENABLED = originalManualDepositsEnabled;
    }
  });

  it('GET /health should return security headers', async () => {
    const res = await request(app).get('/health');

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.body).toHaveProperty('services.database');
  });

  it('GET /api/v1/admin/overview should reject non-admin users', async () => {
    const res = await request(app)
      .get('/api/v1/admin/overview')
      .set(userHeader);

    expect(res.statusCode).toBe(403);
  });

  it('GET /api/v1/admin/overview should allow admin users', async () => {
    const res = await request(app)
      .get('/api/v1/admin/overview')
      .set(adminHeader);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('users');
    expect(res.body.data).toHaveProperty('portfolio_health');
    expect(res.body.data).toHaveProperty('manual_deposit_queue');
    expect(res.body.data).toHaveProperty('manual_withdrawal_queue');
    expect(res.body.data).toHaveProperty('admin_actions');
  });

  it('GET /api/v1/admin/security-status should allow admin users', async () => {
    const res = await request(app)
      .get('/api/v1/admin/security-status')
      .set(adminHeader);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('headers');
    expect(res.body.data).toHaveProperty('hardening');
  });

  it('GET /api/v1/docs/openapi.json should expose API spec metadata', async () => {
    const res = await request(app)
      .get('/api/v1/docs/openapi.json');

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('openapi');
    expect(res.body).toHaveProperty('info');
    expect(res.body.info).toHaveProperty('title');
    expect(res.body.paths).toHaveProperty('/api/v1/deposits/manual');
    expect(res.body.paths).toHaveProperty('/api/v1/deposits');
    expect(res.body.paths).toHaveProperty('/api/v1/deposits/{id}');
    expect(res.body.paths).toHaveProperty('/api/v1/admin/deposits');
    expect(res.body.paths).toHaveProperty('/api/v1/admin/deposits/{id}/approve');
    expect(res.body.paths).toHaveProperty('/api/v1/admin/deposits/{id}/reject');
    expect(res.body.paths).toHaveProperty('/api/v1/withdrawals/manual');
    expect(res.body.paths).toHaveProperty('/api/v1/withdrawals');
    expect(res.body.paths).toHaveProperty('/api/v1/withdrawals/{id}');
    expect(res.body.paths).toHaveProperty('/api/v1/admin/withdrawals');
    expect(res.body.paths).toHaveProperty('/api/v1/admin/withdrawals/{id}/approve');
    expect(res.body.paths).toHaveProperty('/api/v1/admin/withdrawals/{id}/reject');
  });

  it('POST /api/v1/deposits/manual should respect MANUAL_DEPOSITS_ENABLED=false', async () => {
    process.env.MANUAL_DEPOSITS_ENABLED = 'false';

    const res = await request(app)
      .post('/api/v1/deposits/manual')
      .set(userHeader)
      .send({
        amount: 100,
        currency: 'USD',
        transfer_reference: 'WIRE-1234',
        idempotency_key: 'idem-rollout-test-1',
      });

    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body).toHaveProperty('error.code', 'MANUAL_DEPOSITS_DISABLED');
  });

  it('POST /api/v1/admin/deposits/:id/approve should respect MANUAL_DEPOSITS_ENABLED=false', async () => {
    process.env.MANUAL_DEPOSITS_ENABLED = 'false';

    const res = await request(app)
      .post('/api/v1/admin/deposits/507f1f77bcf86cd799439099/approve')
      .set(adminHeader)
      .send({ admin_note: 'test' });

    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body).toHaveProperty('error.code', 'MANUAL_DEPOSITS_DISABLED');
  });
});
