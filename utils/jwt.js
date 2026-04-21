const { createHash, randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');

const ACCESS_TOKEN_SECRET = process.env.JWT_SECRET || 'testsecret';
const REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_SECRET || ACCESS_TOKEN_SECRET;
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