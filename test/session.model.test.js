const mongoose = require('mongoose');
const SessionModel = require('../models/session.model');

describe('Session model', () => {
  it('should require the core session fields', () => {
    const session = new SessionModel({});
    const validationError = session.validateSync();

    expect(validationError.errors.user_id).toBeDefined();
    expect(validationError.errors.session_id).toBeDefined();
    expect(validationError.errors.token_hash).toBeDefined();
    expect(validationError.errors.expires_at).toBeDefined();
  });

  it('should set safe defaults for a new session', () => {
    const session = new SessionModel({
      user_id: new mongoose.Types.ObjectId(),
      session_id: 'session-123',
      token_hash: 'hashed-refresh-token',
      expires_at: new Date(Date.now() + 60 * 60 * 1000),
    });

    expect(session.is_revoked).toBe(false);
    expect(session.revoked_at).toBeNull();
    expect(session.last_used_at).toBeInstanceOf(Date);
  });

  it('should support active-state and revoke helpers', () => {
    const session = new SessionModel({
      user_id: new mongoose.Types.ObjectId(),
      session_id: 'session-456',
      token_hash: 'hashed-refresh-token',
      expires_at: new Date(Date.now() + 60 * 60 * 1000),
    });

    expect(session.isActive()).toBe(true);

    session.revoke();

    expect(session.is_revoked).toBe(true);
    expect(session.revoked_at).toBeInstanceOf(Date);
    expect(session.isActive()).toBe(false);
  });
});
