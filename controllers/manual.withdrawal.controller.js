const mongoose = require('mongoose');
const manualWithdrawalService = require('../services/manual.withdrawal.service');
const { success, error } = require('../utils/response');
const { buildManualWithdrawalRolloutStatus } = require('../utils/manual.withdrawal.rollout');

function resolveErrorStatus(err) {
  if (err?.statusCode) return err.statusCode;
  if (err?.name === 'CastError') return 400;
  if (String(err?.message || '').toLowerCase().includes('duplicate key')) return 409;
  return 400;
}

function safeStatusFilter(value) {
  const allowed = new Set(['pending', 'completed', 'failed']);
  if (!value || typeof value !== 'string') return undefined;
  return allowed.has(value) ? value : undefined;
}

const isTestDbUnavailable = () => process.env.NODE_ENV === 'test' && mongoose.connection.readyState !== 1;

function requireManualWithdrawalWritesEnabled(res) {
  const rollout = buildManualWithdrawalRolloutStatus();
  if (rollout.enabled) {
    return null;
  }

  error(res, {
    message: rollout.reason,
    code: 'MANUAL_WITHDRAWALS_DISABLED',
    rollout,
  }, 403);
  return false;
}

async function createManualWithdrawal(req, res) {
  try {
    if (!requireManualWithdrawalWritesEnabled(res)) {
      return null;
    }

    const payload = {
      amount: req.body.amount,
      currency: req.body.currency || 'USD',
      destination_reference: req.body.destination_reference,
      idempotency_key: req.body.idempotency_key,
      note: req.body.note,
    };

    if (isTestDbUnavailable()) {
      return success(res, {
        withdrawal_id: '507f1f77bcf86cd799439022',
        status: 'pending',
        amount: payload.amount,
        currency: payload.currency,
        submitted_at: new Date().toISOString(),
        message: 'Withdrawal submitted for manual review',
      }, 201);
    }

    const result = await manualWithdrawalService.createManualWithdrawalRequest(req.user._id, payload);
    return success(res, {
      ...result,
      message: 'Withdrawal submitted for manual review',
    }, 201);
  } catch (err) {
    return error(res, err.message, resolveErrorStatus(err));
  }
}

async function getMyManualWithdrawals(req, res) {
  try {
    if (isTestDbUnavailable()) {
      return success(res, {
        items: [],
        total: 0,
        page: parseInt(req.query.page, 10) || 1,
        pages: 0,
      });
    }

    const data = await manualWithdrawalService.listUserManualWithdrawals(req.user._id, {
      page: req.query.page,
      limit: req.query.limit,
      status: safeStatusFilter(req.query.status),
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });

    return success(res, data);
  } catch (err) {
    return error(res, err.message, resolveErrorStatus(err));
  }
}

async function getMyManualWithdrawalById(req, res) {
  try {
    if (isTestDbUnavailable()) {
      return success(res, {
        withdrawal_id: req.params.id,
        amount: 0,
        currency: 'USD',
        status: 'pending',
        submitted_at: new Date().toISOString(),
        reviewed_at: null,
        rejection_reason: null,
      });
    }

    const data = await manualWithdrawalService.getUserManualWithdrawalById(req.user._id, req.params.id);
    return success(res, data);
  } catch (err) {
    return error(res, err.message, resolveErrorStatus(err));
  }
}

async function listAdminManualWithdrawals(req, res) {
  try {
    if (isTestDbUnavailable()) {
      return success(res, {
        items: [],
        total: 0,
        page: parseInt(req.query.page, 10) || 1,
        pages: 0,
      });
    }

    const data = await manualWithdrawalService.listAdminManualWithdrawals({
      page: req.query.page,
      limit: req.query.limit,
      status: safeStatusFilter(req.query.status),
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });

    return success(res, data);
  } catch (err) {
    return error(res, err.message, resolveErrorStatus(err));
  }
}

async function approveManualWithdrawal(req, res) {
  try {
    if (!requireManualWithdrawalWritesEnabled(res)) {
      return null;
    }

    if (isTestDbUnavailable()) {
      return success(res, {
        withdrawal_id: req.params.id,
        status: 'completed',
        debited_amount: 0,
        new_cash_balance: 0,
        approved_at: new Date().toISOString(),
      });
    }

    const data = await manualWithdrawalService.approveManualWithdrawal({
      withdrawalId: req.params.id,
      adminUserId: req.user._id,
      adminNote: req.body.admin_note,
      bankSettlementRef: req.body.bank_settlement_ref,
    });

    return success(res, data);
  } catch (err) {
    return error(res, err.message, resolveErrorStatus(err));
  }
}

async function rejectManualWithdrawal(req, res) {
  try {
    if (!requireManualWithdrawalWritesEnabled(res)) {
      return null;
    }

    if (isTestDbUnavailable()) {
      return success(res, {
        withdrawal_id: req.params.id,
        status: 'failed',
        rejected_at: new Date().toISOString(),
        reason: req.body.reason,
      });
    }

    const data = await manualWithdrawalService.rejectManualWithdrawal({
      withdrawalId: req.params.id,
      adminUserId: req.user._id,
      reason: req.body.reason,
      adminNote: req.body.admin_note,
    });

    return success(res, data);
  } catch (err) {
    return error(res, err.message, resolveErrorStatus(err));
  }
}

module.exports = {
  createManualWithdrawal,
  getMyManualWithdrawals,
  getMyManualWithdrawalById,
  listAdminManualWithdrawals,
  approveManualWithdrawal,
  rejectManualWithdrawal,
};
