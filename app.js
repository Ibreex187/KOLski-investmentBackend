const dotenv = require('dotenv');
dotenv.config({ quiet: true });
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
mongoose.set('bufferTimeoutMS', 1000);

const authRoutes = require('./routes/auth.route.js');
const portfolioRoutes = require('./routes/portfolio.route.js');
const depositRoutes = require('./routes/deposit.route.js');
const withdrawalRoutes = require('./routes/withdrawal.route.js');
const marketRoutes = require('./routes/market.route.js');
const notificationRoutes = require('./routes/notification.route.js');
const adminRoutes = require('./routes/admin.route.js');
const openApiSpec = require('./docs/openapi.json');

const DEFAULT_ALLOWED_ORIGINS = ['https://kolskinv.vercel.app'];

function buildAllowedOrigins() {
  const fromEnv = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (fromEnv.length > 0) {
    return fromEnv;
  }

  if (process.env.NODE_ENV !== 'production') {
    return [
      ...DEFAULT_ALLOWED_ORIGINS,
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173'
    ];
  }

  return DEFAULT_ALLOWED_ORIGINS;
}

const allowedOrigins = buildAllowedOrigins();
function isAllowedOrigin(origin) {
  return allowedOrigins.includes(origin);
}

const allowedMethods = (process.env.CORS_ALLOWED_METHODS || 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const allowedHeaders = (process.env.CORS_ALLOWED_HEADERS || 'Content-Type,Authorization')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // Allow server-to-server calls and local tools with no Origin header.
    if (!origin) {
      return callback(null, true);
    }

    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    const corsError = new Error('CORS origin not allowed');
    corsError.status = 403;
    corsError.code = 'CORS_ORIGIN_NOT_ALLOWED';
    return callback(corsError);
  },
  credentials: true,
  methods: allowedMethods,
  allowedHeaders,
  optionsSuccessStatus: 204
};

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

// Middleware
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }

  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// Routes
// app.use((req, res, next) => {
//   console.log('--- Incoming request:', req.method, req.url);
//   next();
// });

app.get('/api/v1/docs/openapi.json', (req, res) => {
  res.status(200).json(openApiSpec);
});

app.use('/api/v1', authRoutes);
app.use('/api/v1', depositRoutes);
app.use('/api/v1', withdrawalRoutes);
app.use('/api/v1/portfolio', portfolioRoutes);
app.use('/api/v1/market', marketRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/admin', adminRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  const databaseConnected = mongoose.connection.readyState === 1;

  res.status(200).json({
    status: databaseConnected ? 'ok' : 'degraded',
    services: {
      database: databaseConnected ? 'connected' : 'disconnected',
    },
  });
});

// 404 handler
app.use((req, res, next) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
// Error handler
app.use((err, req, res, next) => {
  if (err && err.code === 'CORS_ORIGIN_NOT_ALLOWED') {
    return res.status(403).json({
      success: false,
      error: 'CORS_ORIGIN_NOT_ALLOWED',
      message: 'Request origin is not allowed'
    });
  }

  console.error('Error handler caught:', err);
  res.status(500).json({
    error: err.message || 'Internal server error',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});
module.exports = app;