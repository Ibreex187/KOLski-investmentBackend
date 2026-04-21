const { body, param } = require('express-validator');

// User registration validation
const registerValidation = [
  body('name')
    .trim()
    .notEmpty().withMessage('Name is required'),
  body('username')
    .trim()
    .notEmpty().withMessage('Username is required')
    .isAlphanumeric().withMessage('Username must be alphanumeric')
    .isLength({ min: 3, max: 20 }).withMessage('Username must be between 3 and 20 characters'),
  body('email')
    .isEmail().withMessage('Valid email is required')
    .normalizeEmail(),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
];

// Login validation
const loginValidation = [
  body('email')
    .isEmail().withMessage('Valid email is required')
    .normalizeEmail(),
  body('password')
    .notEmpty().withMessage('Password is required'),
];

const emailOnlyValidation = [
  body('email')
    .isEmail().withMessage('Valid email is required')
    .normalizeEmail(),
];

// OTP validation
const otpValidation = [
  body('email')
    .isEmail().withMessage('Valid email is required')
    .normalizeEmail(),
  body('otp')
    .isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits')
    .isNumeric().withMessage('OTP must be numeric'),
];

const verifyEmailValidation = [
  body('token')
    .trim()
    .notEmpty().withMessage('Verification token is required'),
];

const refreshTokenValidation = [
  body('refreshToken')
    .trim()
    .notEmpty().withMessage('Refresh token is required'),
];

const sessionIdParamValidation = [
  param('id')
    .trim()
    .notEmpty().withMessage('Session ID is required')
    .isUUID().withMessage('Invalid session ID format'),
];

const resetPasswordValidation = [
  body('resetToken')
    .trim()
    .notEmpty().withMessage('Reset token is required'),
  body('newPassword')
    .isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
  body('confirmPassword')
    .notEmpty().withMessage('Password confirmation is required'),
];

// Price alert creation validation
const createAlertValidation = [
  body('symbol')
    .trim()
    .notEmpty().withMessage('Symbol is required')
    .isString().withMessage('Symbol must be a string'),
  body('target_price')
    .notEmpty().withMessage('Target price is required')
    .isFloat({ gt: 0 }).withMessage('Target price must be a positive number')
    .toFloat(),
  body('direction')
    .notEmpty().withMessage('Direction is required')
    .isIn(['above', 'below']).withMessage('Direction must be "above" or "below"'),
];

// Price alert delete validation
const deleteAlertValidation = [
  param('id')
    .matches(/^[a-fA-F0-9]{24}$/).withMessage('Invalid alert ID format'),
];

const createManualDepositValidation = [
  body('amount')
    .notEmpty().withMessage('Amount is required')
    .isFloat({ gt: 0 }).withMessage('Amount must be a positive number')
    .toFloat(),
  body('currency')
    .optional()
    .isString().withMessage('Currency must be a string')
    .customSanitizer((value) => String(value).toUpperCase())
    .isIn(['USD']).withMessage('Only USD is supported for manual deposits right now'),
  body('transfer_reference')
    .trim()
    .notEmpty().withMessage('Transfer reference is required')
    .isLength({ min: 4, max: 128 }).withMessage('Transfer reference must be between 4 and 128 characters'),
  body('idempotency_key')
    .trim()
    .notEmpty().withMessage('Idempotency key is required')
    .isLength({ min: 6, max: 128 }).withMessage('Idempotency key must be between 6 and 128 characters'),
  body('note')
    .optional()
    .isString().withMessage('Note must be a string')
    .isLength({ max: 500 }).withMessage('Note cannot exceed 500 characters'),
];

const manualDepositIdValidation = [
  param('id')
    .matches(/^[a-fA-F0-9]{24}$/).withMessage('Invalid deposit ID format'),
];

const approveManualDepositValidation = [
  ...manualDepositIdValidation,
  body('admin_note')
    .optional()
    .isString().withMessage('Admin note must be a string')
    .isLength({ max: 500 }).withMessage('Admin note cannot exceed 500 characters'),
  body('bank_settlement_ref')
    .optional()
    .trim()
    .isLength({ min: 2, max: 128 }).withMessage('Bank settlement reference must be between 2 and 128 characters'),
];

const rejectManualDepositValidation = [
  ...manualDepositIdValidation,
  body('reason')
    .trim()
    .notEmpty().withMessage('Rejection reason is required')
    .isLength({ min: 3, max: 300 }).withMessage('Rejection reason must be between 3 and 300 characters'),
  body('admin_note')
    .optional()
    .isString().withMessage('Admin note must be a string')
    .isLength({ max: 500 }).withMessage('Admin note cannot exceed 500 characters'),
];

const createManualWithdrawalValidation = [
  body('amount')
    .notEmpty().withMessage('Amount is required')
    .isFloat({ gt: 0 }).withMessage('Amount must be a positive number')
    .toFloat(),
  body('currency')
    .optional()
    .isString().withMessage('Currency must be a string')
    .customSanitizer((value) => String(value).toUpperCase())
    .isIn(['USD']).withMessage('Only USD is supported for manual withdrawals right now'),
  body('destination_reference')
    .trim()
    .notEmpty().withMessage('Destination reference is required')
    .isLength({ min: 4, max: 128 }).withMessage('Destination reference must be between 4 and 128 characters'),
  body('idempotency_key')
    .trim()
    .notEmpty().withMessage('Idempotency key is required')
    .isLength({ min: 6, max: 128 }).withMessage('Idempotency key must be between 6 and 128 characters'),
  body('note')
    .optional()
    .isString().withMessage('Note must be a string')
    .isLength({ max: 500 }).withMessage('Note cannot exceed 500 characters'),
];

const manualWithdrawalIdValidation = [
  param('id')
    .matches(/^[a-fA-F0-9]{24}$/).withMessage('Invalid withdrawal ID format'),
];

const approveManualWithdrawalValidation = [
  ...manualWithdrawalIdValidation,
  body('admin_note')
    .optional()
    .isString().withMessage('Admin note must be a string')
    .isLength({ max: 500 }).withMessage('Admin note cannot exceed 500 characters'),
  body('bank_settlement_ref')
    .optional()
    .trim()
    .isLength({ min: 2, max: 128 }).withMessage('Bank settlement reference must be between 2 and 128 characters'),
];

const rejectManualWithdrawalValidation = [
  ...manualWithdrawalIdValidation,
  body('reason')
    .trim()
    .notEmpty().withMessage('Rejection reason is required')
    .isLength({ min: 3, max: 300 }).withMessage('Rejection reason must be between 3 and 300 characters'),
  body('admin_note')
    .optional()
    .isString().withMessage('Admin note must be a string')
    .isLength({ max: 500 }).withMessage('Admin note cannot exceed 500 characters'),
];

module.exports = {
  registerValidation,
  loginValidation,
  emailOnlyValidation,
  otpValidation,
  verifyEmailValidation,
  refreshTokenValidation,
  sessionIdParamValidation,
  resetPasswordValidation,
  createAlertValidation,
  deleteAlertValidation,
  createManualDepositValidation,
  manualDepositIdValidation,
  approveManualDepositValidation,
  rejectManualDepositValidation,
  createManualWithdrawalValidation,
  manualWithdrawalIdValidation,
  approveManualWithdrawalValidation,
  rejectManualWithdrawalValidation,
};
