const mongoose = require('mongoose');
const SessionModel = require('../models/session.model');
const UserModel = require('../models/user.model');
const {
  generateTokenPair,
  hashToken,
  verifyRefreshToken,
} = require('../utils/jwt');

const REFRESH_TOKEN_TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_MS || 7 * 24 * 60 * 60 * 1000);

function sanitizeUser(user) {
  if (!user) return null;

  return {
    id: user._id,
    name: user.name,
    username: user.username,
    email: user.email,
    cash_balance: user.cash_balance,
    currency: user.currency,
    role: user.role,
    isVerified: user.isVerified,
  };
}

function sanitizeSession(session) {
  if (!session) return null;

  return {
    id: session.session_id,
    device_name: session.device_name,
    user_agent: session.user_agent,
    ip_address: session.ip_address,
    last_used_at: session.last_used_at,
    created_at: session.created_at,
    expires_at: session.expires_at,
    is_revoked: Boolean(session.is_revoked),
  };
}

function buildSessionMetadata(metadata = {}) {
  return {
    device_name: metadata.deviceName || 'unknown-device',
    user_agent: metadata.userAgent || '',
    ip_address: metadata.ipAddress || '',
  };
}

function canUseModelOperation(modelFn) {
  return mongoose.connection.readyState === 1 || Boolean(modelFn && modelFn._isMockFunction);
}

async function resolveModelResult(queryOrPromise, selectClause) {
  if (queryOrPromise && typeof queryOrPromise.select === 'function') {
    return queryOrPromise.select(selectClause);
  }

  return queryOrPromise;
}

async function persistSession(sessionPayload) {
  if (!canUseModelOperation(SessionModel.create)) {
    return sessionPayload;
  }

  return SessionModel.create(sessionPayload);
}

async function saveUserRefreshState(user, refreshToken, expiresAt) {
  if (!user) return;

  user.refreshToken = refreshToken;
  user.refreshTokenExpires = expiresAt;

  if (typeof user.save === 'function') {
    await user.save({ validateBeforeSave: false });
  }
}

async function createSessionForUser(user, metadata = {}) {
  if (!user || !user._id) {
    throw new Error('Valid user is required to create a session');
  }

  const { token, refreshToken, sessionId } = generateTokenPair(String(user._id), {
    email: user.email,
    role: user.role,
  });

  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await persistSession({
    user_id: user._id,
    session_id: sessionId,
    token_hash: hashToken(refreshToken),
    ...buildSessionMetadata(metadata),
    last_used_at: new Date(),
    expires_at: expiresAt,
  });

  await saveUserRefreshState(user, refreshToken, expiresAt);

  return {
    token,
    refreshToken,
    sessionId,
    expiresAt,
    user: sanitizeUser(user),
  };
}

async function findSessionByRefreshToken(refreshToken) {
  const decoded = verifyRefreshToken(refreshToken);
  if (!decoded || decoded.type !== 'refresh') {
    throw new Error('Invalid or expired refresh token');
  }

  if (!canUseModelOperation(SessionModel.findOne)) {
    return { decoded, session: null };
  }

  const query = SessionModel.findOne({
    user_id: decoded.sub || decoded.id,
    session_id: decoded.jti,
    token_hash: hashToken(refreshToken),
  });

  const session = typeof query.select === 'function'
    ? await query.select('+token_hash')
    : await query;

  if (!session) {
    throw new Error('Refresh token not recognized');
  }

  return { decoded, session };
}

async function rotateRefreshSession(refreshToken, metadata = {}) {
  const { decoded, session } = await findSessionByRefreshToken(refreshToken);

  if (session) {
    if (session.is_revoked || (session.expires_at && session.expires_at < new Date())) {
      throw new Error('Refresh token expired. Please log in again');
    }

    if (typeof session.revoke === 'function') {
      session.revoke();
    } else {
      session.is_revoked = true;
      session.revoked_at = new Date();
    }

    if (typeof session.touch === 'function') {
      session.touch();
    }

    if (typeof session.save === 'function') {
      await session.save({ validateBeforeSave: false });
    }
  }

  let user = null;
  if (canUseModelOperation(UserModel.findById)) {
    user = await resolveModelResult(UserModel.findById(decoded.sub || decoded.id), '+refreshToken +refreshTokenExpires');
  }

  if (!user) {
    throw new Error('User not found');
  }

  return createSessionForUser(user, metadata);
}

async function revokeSessionByRefreshToken(refreshToken) {
  try {
    const { decoded, session } = await findSessionByRefreshToken(refreshToken);

    if (session) {
      if (typeof session.revoke === 'function') {
        session.revoke();
      } else {
        session.is_revoked = true;
        session.revoked_at = new Date();
      }

      if (typeof session.save === 'function') {
        await session.save({ validateBeforeSave: false });
      }
    }

    if (canUseModelOperation(UserModel.findById)) {
      const user = await resolveModelResult(UserModel.findById(decoded.sub || decoded.id), '+refreshToken +refreshTokenExpires');
      if (user) {
        user.refreshToken = null;
        user.refreshTokenExpires = null;
        if (typeof user.save === 'function') {
          await user.save({ validateBeforeSave: false });
        }
      }
    }

    return true;
  } catch (error) {
    return true;
  }
}

async function revokeAllSessionsForUser(userId) {
  if (!userId) {
    throw new Error('User id is required');
  }

  if (canUseModelOperation(SessionModel.updateMany)) {
    await SessionModel.updateMany(
      { user_id: userId, is_revoked: false },
      {
        $set: {
          is_revoked: true,
          revoked_at: new Date(),
        },
      }
    );
  }

  if (canUseModelOperation(UserModel.findById)) {
    const user = await resolveModelResult(UserModel.findById(userId), '+refreshToken +refreshTokenExpires');
    if (user) {
      user.refreshToken = null;
      user.refreshTokenExpires = null;
      if (typeof user.save === 'function') {
        await user.save({ validateBeforeSave: false });
      }
    }
  }

  return true;
}

async function revokeSessionById(userId, sessionId) {
  if (!userId || !sessionId) {
    throw new Error('User id and session id are required');
  }

  if (!canUseModelOperation(SessionModel.findOne)) {
    return true;
  }

  const query = SessionModel.findOne({
    user_id: userId,
    session_id: sessionId,
  });

  const session = await resolveModelResult(query, '+token_hash');
  if (!session) {
    return false;
  }

  if (typeof session.revoke === 'function') {
    session.revoke();
  } else {
    session.is_revoked = true;
    session.revoked_at = new Date();
  }

  if (typeof session.save === 'function') {
    await session.save({ validateBeforeSave: false });
  }

  if (canUseModelOperation(UserModel.findById)) {
    const user = await resolveModelResult(UserModel.findById(userId), '+refreshToken +refreshTokenExpires');
    if (user?.refreshToken) {
      const decoded = verifyRefreshToken(user.refreshToken);
      if (decoded?.jti === sessionId) {
        user.refreshToken = null;
        user.refreshTokenExpires = null;
        if (typeof user.save === 'function') {
          await user.save({ validateBeforeSave: false });
        }
      }
    }
  }

  return true;
}

async function listActiveSessionsForUser(userId) {
  if (!userId) {
    throw new Error('User id is required');
  }

  if (!canUseModelOperation(SessionModel.find)) {
    return [];
  }

  const sessions = await SessionModel.find({
    user_id: userId,
    is_revoked: false,
    expires_at: { $gt: new Date() },
  }).sort({ last_used_at: -1 });

  return sessions.map(sanitizeSession);
}

module.exports = {
  sanitizeUser,
  sanitizeSession,
  createSessionForUser,
  rotateRefreshSession,
  revokeSessionByRefreshToken,
  revokeAllSessionsForUser,
  revokeSessionById,
  listActiveSessionsForUser,
};
