const mongoose = require('mongoose');
const SessionModel = require('../models/session.model');
const UserModel = require('../models/user.model');
const { verifyToken, verifyRefreshToken } = require('../utils/jwt');
const {
  createSessionForUser,
  rotateRefreshSession,
  revokeSessionByRefreshToken,
} = require('../services/auth.service');

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Auth service', () => {
  it('should create a hashed session and return a token pair', async () => {
    const userId = new mongoose.Types.ObjectId();
    const mockSave = jest.fn().mockResolvedValue(true);
    const mockUser = {
      _id: userId,
      name: 'Service User',
      username: 'serviceuser',
      email: 'service@example.com',
      cash_balance: 0,
      currency: 'USD',
      role: 'user',
      isVerified: true,
      save: mockSave,
    };

    const createSpy = jest.spyOn(SessionModel, 'create').mockResolvedValue({ _id: new mongoose.Types.ObjectId() });

    const result = await createSessionForUser(mockUser, {
      userAgent: 'jest',
      ipAddress: '127.0.0.1',
      deviceName: 'test-runner',
    });

    expect(result).toHaveProperty('token');
    expect(result).toHaveProperty('refreshToken');
    expect(result).toHaveProperty('sessionId');
    expect(verifyToken(result.token).id).toBe(String(userId));
    expect(verifyRefreshToken(result.refreshToken).jti).toBe(result.sessionId);
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      user_id: userId,
      session_id: result.sessionId,
      token_hash: expect.any(String),
      device_name: 'test-runner',
      user_agent: 'jest',
      ip_address: '127.0.0.1',
    }));
    expect(mockSave).toHaveBeenCalled();
  });

  it('should rotate a refresh session and revoke the old one', async () => {
    const userId = new mongoose.Types.ObjectId();
    const mockUser = {
      _id: userId,
      name: 'Rotating User',
      username: 'rotatinguser',
      email: 'rotate@example.com',
      cash_balance: 0,
      currency: 'USD',
      role: 'user',
      isVerified: true,
      save: jest.fn().mockResolvedValue(true),
    };

    const initialSession = await createSessionForUser(mockUser, { deviceName: 'first-device' });

    const existingSession = {
      user_id: userId,
      session_id: initialSession.sessionId,
      token_hash: 'old-hash',
      expires_at: new Date(Date.now() + 60_000),
      is_revoked: false,
      revoked_at: null,
      save: jest.fn().mockResolvedValue(true),
      revoke() {
        this.is_revoked = true;
        this.revoked_at = new Date();
        return this;
      },
      touch() {
        return this;
      },
    };

    jest.spyOn(SessionModel, 'findOne').mockReturnValue({
      select: jest.fn().mockResolvedValue(existingSession),
    });
    jest.spyOn(UserModel, 'findById').mockResolvedValue(mockUser);
    jest.spyOn(SessionModel, 'create').mockResolvedValue({ _id: new mongoose.Types.ObjectId() });

    const rotated = await rotateRefreshSession(initialSession.refreshToken, {
      deviceName: 'second-device',
    });

    expect(rotated).toHaveProperty('token');
    expect(rotated).toHaveProperty('refreshToken');
    expect(rotated.sessionId).not.toBe(initialSession.sessionId);
    expect(existingSession.is_revoked).toBe(true);
    expect(existingSession.save).toHaveBeenCalled();
  });

  it('should revoke a session by refresh token', async () => {
    const existingSession = {
      is_revoked: false,
      revoked_at: null,
      save: jest.fn().mockResolvedValue(true),
      revoke() {
        this.is_revoked = true;
        this.revoked_at = new Date();
        return this;
      },
    };

    const userId = new mongoose.Types.ObjectId();
    const mockUser = {
      _id: userId,
      name: 'Logout User',
      username: 'logoutuser',
      email: 'logout@example.com',
      cash_balance: 0,
      currency: 'USD',
      role: 'user',
      isVerified: true,
      save: jest.fn().mockResolvedValue(true),
    };

    const session = await createSessionForUser(mockUser, { deviceName: 'logout-device' });

    jest.spyOn(SessionModel, 'findOne').mockReturnValue({
      select: jest.fn().mockResolvedValue(existingSession),
    });
    jest.spyOn(UserModel, 'findById').mockResolvedValue(mockUser);

    const revoked = await revokeSessionByRefreshToken(session.refreshToken);

    expect(revoked).toBe(true);
    expect(existingSession.is_revoked).toBe(true);
    expect(existingSession.save).toHaveBeenCalled();
  });
});
