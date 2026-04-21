const Redis = require('ioredis');

const isTestEnv = process.env.NODE_ENV === 'test';

// Create a Redis client — optional in development
// If Redis is not running the app will continue without caching
const redis = new Redis(6379, '127.0.0.1', {
  lazyConnect: true,
  enableOfflineQueue: false,
  retryStrategy: () => null, // disable auto-reconnect
  maxRetriesPerRequest: 0,
});

let connectPromise = null;

redis.on('error', () => {
  // Suppress connection errors — app runs without caching when Redis is unavailable
});

async function ensureRedisReady() {
  if (isTestEnv) {
    return false;
  }

  if (redis.status === 'ready') {
    return true;
  }

  if (connectPromise) {
    await connectPromise;
    return redis.status === 'ready';
  }

  if (redis.status === 'wait' || redis.status === 'end') {
    connectPromise = redis.connect()
      .catch(() => false)
      .finally(() => {
        connectPromise = null;
      });

    await connectPromise;
  }

  return redis.status === 'ready';
}

// Helper: safe get (returns null if Redis is unavailable)
redis.safeGet = async (key) => {
  try {
    if (!(await ensureRedisReady())) return null;
    return await redis.get(key);
  } catch {
    return null;
  }
};

// Helper: safe set (no-op if Redis is unavailable)
redis.safeSet = async (key, value, ...args) => {
  try {
    if (!(await ensureRedisReady())) return;
    await redis.set(key, value, ...args);
  } catch {
    // ignore
  }
};

module.exports = redis;
