function createJsonRateLimiter({
  windowMs,
  max,
  message,
  skipSuccessfulRequests = false,
}) {
  const store = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = String(req.ip || req.headers['x-forwarded-for'] || 'global').split(',')[0].trim();
    const current = store.get(key);

    if (!current || current.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      current.count += 1;
      store.set(key, current);
    }

    const entry = store.get(key);
    const remaining = Math.max(0, max - entry.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (skipSuccessfulRequests) {
      const originalEnd = res.end.bind(res);
      res.end = (...args) => {
        if (res.statusCode < 400) {
          const latest = store.get(key);
          if (latest) {
            latest.count = Math.max(0, latest.count - 1);
            store.set(key, latest);
          }
        }
        return originalEnd(...args);
      };
    }

    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({
        success: false,
        message,
      });
    }

    return next();
  };
}

const loginLimiter = createJsonRateLimiter({
  windowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX || 10),
  message: 'Too many login attempts. Please try again later.',
  skipSuccessfulRequests: true,
});

const verificationLimiter = createJsonRateLimiter({
  windowMs: Number(process.env.VERIFICATION_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.VERIFICATION_RATE_LIMIT_MAX || 5),
  message: 'Too many verification requests. Please try again later.',
});

const forgotPasswordLimiter = createJsonRateLimiter({
  windowMs: Number(process.env.FORGOT_PASSWORD_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.FORGOT_PASSWORD_RATE_LIMIT_MAX || 5),
  message: 'Too many password reset requests. Please try again later.',
});

const refreshTokenLimiter = createJsonRateLimiter({
  windowMs: Number(process.env.REFRESH_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.REFRESH_RATE_LIMIT_MAX || 20),
  message: 'Too many refresh attempts. Please try again later.',
});

module.exports = {
  createJsonRateLimiter,
  loginLimiter,
  verificationLimiter,
  forgotPasswordLimiter,
  refreshTokenLimiter,
};
