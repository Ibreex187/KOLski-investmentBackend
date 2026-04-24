const dotenv = require('dotenv');
dotenv.config({ quiet: true });

const app = require('../app');
const { connectToDatabase } = require('../utils/db');

const DEFAULT_ALLOWED_ORIGINS = ['https://kolskinv.vercel.app', 'https://www.kolskinv.vercel.app'];

function normalizeOrigin(value) {
    if (!value || typeof value !== 'string') return '';
    return value
        .trim()
        .replace(/^['\"]|['\"]$/g, '')
        .replace(/\/$/, '')
        .toLowerCase();
}

function buildAllowedOrigins(env = process.env) {
    const fromEnv = (env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((origin) => normalizeOrigin(origin))
        .filter(Boolean);

    if (fromEnv.length > 0) {
        return Array.from(new Set(fromEnv));
    }

    if (env.NODE_ENV !== 'production') {
        return Array.from(new Set([
            ...DEFAULT_ALLOWED_ORIGINS,
            'http://localhost:3000',
            'http://localhost:5173',
            'http://127.0.0.1:3000',
            'http://127.0.0.1:5173'
        ].map((origin) => normalizeOrigin(origin))));
    }

    return Array.from(new Set(DEFAULT_ALLOWED_ORIGINS.map((origin) => normalizeOrigin(origin))));
}

function applyCorsHeadersOnFailure(req, res) {
    const requestOrigin = normalizeOrigin(req.headers?.origin);
    if (!requestOrigin) return;

    const allowedOrigins = buildAllowedOrigins();
    if (!allowedOrigins.includes(requestOrigin)) return;

    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
}

module.exports = async (req, res) => {
    try {
        // Never block CORS preflight on database availability.
        if (req.method === 'OPTIONS') {
            return app(req, res);
        }

        await connectToDatabase();
        return app(req, res);
    } catch (error) {
        applyCorsHeadersOnFailure(req, res);
        return res.status(503).json({
            success: false,
            code: 'DATABASE_UNAVAILABLE',
            message: 'Database connection failed'
        });
    }
};
