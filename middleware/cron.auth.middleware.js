const { createHash, timingSafeEqual } = require('crypto');

// Guards machine-to-machine "cron" endpoints. Vercel Cron automatically sends
// `Authorization: Bearer <CRON_SECRET>` when a CRON_SECRET env var is set; any other
// scheduler (e.g. GitHub Actions) can send the same header.
//
// Fails closed: with no CRON_SECRET configured the endpoint is disabled (503) rather
// than open, so a missing env var can never expose it to the internet.
function requireCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return res.status(503).json({
      success: false,
      error: { code: 'CRON_NOT_CONFIGURED', message: 'Scheduled jobs are not configured on this server' },
    });
  }

  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  // Hash both sides so the comparison is constant-time regardless of input length.
  const expectedDigest = createHash('sha256').update(secret).digest();
  const providedDigest = createHash('sha256').update(provided).digest();

  if (!provided || !timingSafeEqual(expectedDigest, providedDigest)) {
    return res.status(401).json({ success: false, error: 'Not authorized' });
  }

  return next();
}

module.exports = requireCronSecret;
