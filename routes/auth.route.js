const express = require('express');
const router = express.Router();
const {
  registerValidation,
  loginValidation,
  emailOnlyValidation,
  otpValidation,
  verifyEmailValidation,
  refreshTokenValidation,
  sessionIdParamValidation,
  resetPasswordValidation,
} = require('../validators/validation.rules.js');
const validate = require('../middleware/express.validator.middleware.js');
const authMiddleware = require('../middleware/auth.middleware.js');
const {
  loginLimiter,
  verificationLimiter,
  forgotPasswordLimiter,
  refreshTokenLimiter,
} = require('../middleware/rateLimit.middleware.js');
const {
  register,
  login,
  getMe,
  sendVerification,
  verifyEmail,
  refreshToken,
  logout,
  logoutAll,
  listSessions,
  revokeSession,
  requestForgotPasswordotp,
  verifyForgotPasswordotp,
  resetForgotPassword,
} = require('../controllers/auth.controller.js');

// Registration route
router.post('/register', registerValidation, validate, register);

// Login route
router.post('/login', loginLimiter, loginValidation, validate, login);

// Get current user details
router.get('/me', authMiddleware, getMe);

// Email verification and session routes
router.post('/send-verification', verificationLimiter, emailOnlyValidation, validate, sendVerification);
router.post('/verify-email', verificationLimiter, verifyEmailValidation, validate, verifyEmail);
router.post('/refresh-token', refreshTokenLimiter, refreshTokenValidation, validate, refreshToken);
router.post('/logout', refreshTokenValidation, validate, logout);
router.post('/logout-all', authMiddleware, logoutAll);
router.get('/sessions', authMiddleware, listSessions);
router.delete('/sessions/:id', authMiddleware, sessionIdParamValidation, validate, revokeSession);

// Forgot password routes
router.post('/forgot-password', forgotPasswordLimiter, emailOnlyValidation, validate, requestForgotPasswordotp);
router.post('/verify-forgot-password-otp', otpValidation, validate, verifyForgotPasswordotp);
router.post('/reset-forgot-password', resetPasswordValidation, validate, resetForgotPassword);

module.exports = router;