const request = require('supertest');
const app = require('../app');
const UserModel = require('../models/user.model');
const {
  generateToken,
  generateRefreshToken,
  verifyToken,
  verifyRefreshToken,
} = require('../utils/jwt');

const authHeader = {
  Authorization: `Bearer ${generateToken('000000000000000000000001')}`,
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Auth upgrade API', () => {
  it('POST /api/v1/send-verification should validate email', async () => {
    const res = await request(app)
      .post('/api/v1/send-verification')
      .send({});

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/v1/verify-email should validate token', async () => {
    const res = await request(app)
      .post('/api/v1/verify-email')
      .send({});

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/v1/refresh-token should validate refreshToken', async () => {
    const res = await request(app)
      .post('/api/v1/refresh-token')
      .send({});

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/v1/logout should validate refreshToken', async () => {
    const res = await request(app)
      .post('/api/v1/logout')
      .send({});

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('Email verification and login flow', () => {
  it('POST /api/v1/login should block unverified users', async () => {
    const mockUser = {
      _id: '507f1f77bcf86cd799439012',
      name: 'Pending User',
      username: 'pendinguser',
      email: 'pending@example.com',
      cash_balance: 0,
      currency: 'USD',
      role: 'user',
      isVerified: false,
      comparePassword: jest.fn().mockResolvedValue(true),
      save: jest.fn(),
    };

    jest.spyOn(UserModel, 'findOne').mockReturnValue({
      select: jest.fn().mockResolvedValue(mockUser),
    });

    const res = await request(app)
      .post('/api/v1/login')
      .send({ email: 'pending@example.com', password: 'TestPassword123' });

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toMatch(/verify/i);
  });

  it('POST /api/v1/verify-email should verify the user and return tokens', async () => {
    const mockUser = {
      _id: '507f1f77bcf86cd799439013',
      name: 'Verified User',
      username: 'verifieduser',
      email: 'verified@example.com',
      cash_balance: 100,
      currency: 'USD',
      role: 'user',
      isVerified: false,
      emailVerificationToken: 'token-123',
      emailVerificationExpires: new Date(Date.now() + 60_000),
      save: jest.fn().mockResolvedValue(true),
    };

    jest.spyOn(UserModel, 'findOne').mockReturnValue({
      select: jest.fn().mockResolvedValue(mockUser),
    });

    const res = await request(app)
      .post('/api/v1/verify-email')
      .send({ token: 'token-123' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('token');
    expect(res.body.data).toHaveProperty('refreshToken');
    expect(res.body.data.user.isVerified).toBe(true);
  });
});

describe('Session management API', () => {
  it('GET /api/v1/sessions should return active sessions', async () => {
    const res = await request(app)
      .get('/api/v1/sessions')
      .set(authHeader);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('POST /api/v1/logout-all should revoke all sessions for the current user', async () => {
    const res = await request(app)
      .post('/api/v1/logout-all')
      .set(authHeader)
      .send({});

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('DELETE /api/v1/sessions/:id should validate session id format', async () => {
    const res = await request(app)
      .delete('/api/v1/sessions/not-a-uuid')
      .set(authHeader);

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('JWT helpers', () => {
  it('should generate and verify an access token', () => {
    const token = generateToken('user-123');
    const decoded = verifyToken(token);

    expect(typeof token).toBe('string');
    expect(decoded.id).toBe('user-123');
  });

  it('should generate and verify a refresh token', () => {
    const token = generateRefreshToken('user-456');
    const decoded = verifyRefreshToken(token);

    expect(typeof token).toBe('string');
    expect(decoded.id).toBe('user-456');
  });
});
