const { createHash, randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');

// Placeholder values from .env.example / docs must never sign real tokens.
const INSECURE_SECRET_VALUES = new Set(['change-me', 'change-me-too', 'changeme', 'secret', 'testsecret']);

// Resolves the signing secrets, refusing to run with a missing or well-known secret.
// Only the test environment (NODE_ENV=test) gets a built-in fallback so the suite
// runs without configuration; anywhere else an unset JWT_SECRET is a startup error,
// because a hardcoded fallback would let anyone forge tokens.
function resolveJwtSecrets(env = process.env) {
    const isTest = env.NODE_ENV === 'test';
    const isProduction = env.NODE_ENV === 'production';
    const access = env.JWT_SECRET;

    if (!access) {
        if (isTest) {
            return { access: 'testsecret', refresh: env.JWT_REFRESH_SECRET || 'testsecret' };
        }
        throw new Error('JWT_SECRET is not set. Define a long random value in your environment (see .env.example).');
    }

    if (isProduction && INSECURE_SECRET_VALUES.has(access.trim().toLowerCase())) {
        throw new Error('JWT_SECRET is set to a placeholder value. Use a long random secret in production.');
    }

    const refresh = env.JWT_REFRESH_SECRET || access;
    if (isProduction) {
        if (!env.JWT_REFRESH_SECRET) {
            console.warn('JWT_REFRESH_SECRET is not set; refresh tokens are signed with JWT_SECRET. Set a separate value.');
        } else if (INSECURE_SECRET_VALUES.has(refresh.trim().toLowerCase())) {
            throw new Error('JWT_REFRESH_SECRET is set to a placeholder value. Use a long random secret in production.');
        }
    }

    return { access, refresh };
}

const { access: ACCESS_TOKEN_SECRET, refresh: REFRESH_TOKEN_SECRET } = resolveJwtSecrets();
const ACCESS_TOKEN_TTL = process.env.JWT_EXPIRES_IN || '5h';
const REFRESH_TOKEN_TTL = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

const generateAccessToken = (id, extraPayload = {}) => {
    try {
        const normalizedId = String(id);
        return jwt.sign({ sub: normalizedId, id: normalizedId, type: 'access', ...extraPayload }, ACCESS_TOKEN_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
    } catch (error) {
        return null;
    }
};

const generateRefreshToken = (id, options = {}) => {
    try {
        const normalizedId = String(id);
        const sessionId = options.sessionId || randomUUID();
        const extraPayload = options.extraPayload || {};
        return jwt.sign({ sub: normalizedId, id: normalizedId, jti: sessionId, type: 'refresh', ...extraPayload }, REFRESH_TOKEN_SECRET, { expiresIn: REFRESH_TOKEN_TTL });
    } catch (error) {
        return null;
    }
};

const generateTokenPair = (id, extraPayload = {}) => {
    const sessionId = randomUUID();
    return {
        token: generateAccessToken(id, extraPayload),
        refreshToken: generateRefreshToken(id, { sessionId, extraPayload }),
        sessionId,
    };
};

const hashToken = (token) => createHash('sha256').update(String(token || '')).digest('hex');

const verifyToken = (token) => {
    try {
        return jwt.verify(token, ACCESS_TOKEN_SECRET);
    } catch (error) {
        return null;
    }
};

const verifyRefreshToken = (token) => {
    try {
        return jwt.verify(token, REFRESH_TOKEN_SECRET);
    } catch (error) {
        return null;
    }
};

module.exports = {
    resolveJwtSecrets,
    ACCESS_TOKEN_TTL,
    REFRESH_TOKEN_TTL,
    generateAccessToken,
    generateToken: generateAccessToken,
    generateRefreshToken,
    generateTokenPair,
    hashToken,
    verifyToken,
    verifyRefreshToken,
};