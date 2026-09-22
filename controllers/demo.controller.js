const { ensureDemoAccount } = require('../services/demo.service');
const { createSessionForUser } = require('../services/auth.service');

const getRequestSessionMeta = (req) => ({
  deviceName: req.get('x-device-name') || 'demo-button',
  userAgent: req.get('user-agent') || '',
  ipAddress: String(req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || '').split(',')[0].trim(),
});

// POST /api/v1/demo/login
// No credentials required by design: logs the caller into the single shared, seeded
// demo account. Uses the exact same session/token machinery as a normal login, so
// refresh, logout, and the sessions list all behave identically for a demo visitor.
async function demoLogin(req, res) {
  try {
    const user = await ensureDemoAccount();
    const session = await createSessionForUser(user, getRequestSessionMeta(req));

    return res.json({
      success: true,
      token: session.token,
      refreshToken: session.refreshToken,
      user: session.user,
    });
  } catch (err) {
    console.error('Demo login failed:', err);
    return res.status(500).json({ success: false, error: 'Could not start the demo session' });
  }
}

module.exports = { demoLogin };
