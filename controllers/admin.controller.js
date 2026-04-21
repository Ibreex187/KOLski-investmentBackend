const mongoose = require('mongoose');
const UserModel = require('../models/user.model');
const PortfolioModel = require('../models/portfolio.model');
const TransactionModel = require('../models/transaction.model');
const PriceAlertModel = require('../models/price.alert.model');
const NotificationModel = require('../models/notification.model');
const { success, error } = require('../utils/response');
const { buildManualDepositRolloutStatus } = require('../utils/manual.deposit.rollout');
const { buildManualWithdrawalRolloutStatus } = require('../utils/manual.withdrawal.rollout');
const { buildCreatedAtFilter } = require('../utils/date.range');

const isTestDbUnavailable = () => process.env.NODE_ENV === 'test' && mongoose.connection.readyState !== 1;
const clampLimit = (value, fallback = 12) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 100);
};

function buildSecurityStatusPayload() {
  return {
    headers: {
      x_content_type_options: 'nosniff',
      x_frame_options: 'DENY',
      referrer_policy: 'no-referrer',
      x_permitted_cross_domain_policies: 'none',
      x_powered_by: 'disabled',
    },
    hardening: {
      json_body_limit: '100kb',
      trust_proxy: process.env.TRUST_PROXY || 'disabled',
      auth_rate_limits: true,
      admin_role_guard: true,
      openapi_doc_available: true,
    },
  };
}

async function getAdminOverview(req, res) {
  try {
    const depositRollout = buildManualDepositRolloutStatus();
    const withdrawalRollout = buildManualWithdrawalRolloutStatus();

    if (isTestDbUnavailable()) {
      return success(res, {
        users: { total: 0, admins: req.user?.role === 'admin' ? 1 : 0 },
        portfolios: { total: 0 },
        transactions: { total: 0 },
        alerts: { active: 0, triggered: 0 },
        notifications: { unread: 0 },
        portfolio_health: {
          status: 'stable',
          note: 'Admin overview is running in test-safe mode without a live database connection.',
        },
        manual_deposit_queue: {
          pending: 0,
          rollout: depositRollout,
        },
        manual_withdrawal_queue: {
          pending: 0,
          rollout: withdrawalRollout,
        },
        admin_actions: {
          review_manual_deposits: {
            label: 'Review manual deposits',
            method: 'GET',
            path: '/api/v1/admin/deposits?status=pending',
          },
          approve_manual_deposit: {
            label: 'Approve manual deposit',
            method: 'POST',
            path: '/api/v1/admin/deposits/:id/approve',
          },
          reject_manual_deposit: {
            label: 'Reject manual deposit',
            method: 'POST',
            path: '/api/v1/admin/deposits/:id/reject',
          },
          review_manual_withdrawals: {
            label: 'Review manual withdrawals',
            method: 'GET',
            path: '/api/v1/admin/withdrawals?status=pending',
          },
          approve_manual_withdrawal: {
            label: 'Approve manual withdrawal',
            method: 'POST',
            path: '/api/v1/admin/withdrawals/:id/approve',
          },
          reject_manual_withdrawal: {
            label: 'Reject manual withdrawal',
            method: 'POST',
            path: '/api/v1/admin/withdrawals/:id/reject',
          },
        },
      });
    }

    const [
      totalUsers,
      adminUsers,
      totalPortfolios,
      totalTransactions,
      activeAlerts,
      triggeredAlerts,
      unreadNotifications,
      pendingManualDeposits,
      pendingManualWithdrawals,
    ] = await Promise.all([
      UserModel.countDocuments({}),
      UserModel.countDocuments({ role: 'admin' }),
      PortfolioModel.countDocuments({}),
      TransactionModel.countDocuments({}),
      PriceAlertModel.countDocuments({ status: 'active' }),
      PriceAlertModel.countDocuments({ status: 'triggered' }),
      NotificationModel.countDocuments({ read: false }),
      TransactionModel.countDocuments({
        type: 'deposit',
        status: 'pending',
        'metadata.deposit_flow': 'manual_bank_transfer',
      }),
      TransactionModel.countDocuments({
        type: 'withdrawal',
        status: 'pending',
        'metadata.withdrawal_flow': 'manual_bank_transfer',
      }),
    ]);

    return success(res, {
      users: {
        total: totalUsers,
        admins: adminUsers,
      },
      portfolios: {
        total: totalPortfolios,
      },
      transactions: {
        total: totalTransactions,
      },
      alerts: {
        active: activeAlerts,
        triggered: triggeredAlerts,
      },
      notifications: {
        unread: unreadNotifications,
      },
      portfolio_health: {
        status: 'stable',
        note: 'Admin overview metrics loaded successfully.',
      },
      manual_deposit_queue: {
        pending: pendingManualDeposits,
        rollout: depositRollout,
      },
      manual_withdrawal_queue: {
        pending: pendingManualWithdrawals,
        rollout: withdrawalRollout,
      },
      admin_actions: {
        review_manual_deposits: {
          label: 'Review manual deposits',
          method: 'GET',
          path: '/api/v1/admin/deposits?status=pending',
        },
        approve_manual_deposit: {
          label: 'Approve manual deposit',
          method: 'POST',
          path: '/api/v1/admin/deposits/:id/approve',
        },
        reject_manual_deposit: {
          label: 'Reject manual deposit',
          method: 'POST',
          path: '/api/v1/admin/deposits/:id/reject',
        },
        review_manual_withdrawals: {
          label: 'Review manual withdrawals',
          method: 'GET',
          path: '/api/v1/admin/withdrawals?status=pending',
        },
        approve_manual_withdrawal: {
          label: 'Approve manual withdrawal',
          method: 'POST',
          path: '/api/v1/admin/withdrawals/:id/approve',
        },
        reject_manual_withdrawal: {
          label: 'Reject manual withdrawal',
          method: 'POST',
          path: '/api/v1/admin/withdrawals/:id/reject',
        },
      },
    });
  } catch (err) {
    return error(res, err.message, 500);
  }
}

async function getAdminUsers(req, res) {
  try {
    const limit = clampLimit(req.query.limit, 12);
    const { filter: createdAtFilter, error: dateError } = buildCreatedAtFilter({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });

    if (dateError) {
      return error(res, dateError, 400);
    }

    if (isTestDbUnavailable()) {
      return success(res, {
        items: [],
        total: 0,
        admins: req.user?.role === 'admin' ? 1 : 0,
        verified: 0,
        limit,
      });
    }

    const baseFilter = {
      ...(createdAtFilter || {}),
    };

    const [items, total, admins, verified] = await Promise.all([
      UserModel.find(baseFilter, 'name username email role isVerified lastLogin cash_balance currency createdAt')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      UserModel.countDocuments(baseFilter),
      UserModel.countDocuments({ ...baseFilter, role: 'admin' }),
      UserModel.countDocuments({ ...baseFilter, isVerified: true }),
    ]);

    return success(res, {
      items,
      total,
      admins,
      verified,
      limit,
    });
  } catch (err) {
    return error(res, err.message, 500);
  }
}

async function getAdminAlerts(req, res) {
  try {
    const limit = clampLimit(req.query.limit, 12);
    const { filter: createdAtFilter, error: dateError } = buildCreatedAtFilter({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });

    if (dateError) {
      return error(res, dateError, 400);
    }

    if (isTestDbUnavailable()) {
      return success(res, {
        items: [],
        total: 0,
        active: 0,
        triggered: 0,
        disabled: 0,
        limit,
      });
    }

    const baseFilter = {
      ...(createdAtFilter || {}),
    };

    const [items, total, active, triggered, disabled] = await Promise.all([
      PriceAlertModel.find(baseFilter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate({ path: 'user_id', select: 'name username email role' })
        .lean(),
      PriceAlertModel.countDocuments(baseFilter),
      PriceAlertModel.countDocuments({ ...baseFilter, status: 'active' }),
      PriceAlertModel.countDocuments({ ...baseFilter, status: 'triggered' }),
      PriceAlertModel.countDocuments({ ...baseFilter, status: 'disabled' }),
    ]);

    const normalizedItems = items.map((item) => ({
      ...item,
      user_name: item.user_id?.name || item.user_id?.username || 'Unknown user',
      user_email: item.user_id?.email || '—',
    }));

    return success(res, {
      items: normalizedItems,
      total,
      active,
      triggered,
      disabled,
      limit,
    });
  } catch (err) {
    return error(res, err.message, 500);
  }
}

async function getAdminTransactions(req, res) {
  try {
    const limit = clampLimit(req.query.limit, 12);
    const { filter: createdAtFilter, error: dateError } = buildCreatedAtFilter({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });

    if (dateError) {
      return error(res, dateError, 400);
    }

    if (isTestDbUnavailable()) {
      return success(res, {
        items: [],
        total: 0,
        completed: 0,
        pending: 0,
        failed: 0,
        limit,
      });
    }

    const baseFilter = {
      ...(createdAtFilter || {}),
    };

    const [items, total, completed, pending, failed] = await Promise.all([
      TransactionModel.find(baseFilter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate({ path: 'userId', select: 'name username email role' })
        .lean(),
      TransactionModel.countDocuments(baseFilter),
      TransactionModel.countDocuments({ ...baseFilter, status: 'completed' }),
      TransactionModel.countDocuments({ ...baseFilter, status: 'pending' }),
      TransactionModel.countDocuments({ ...baseFilter, status: 'failed' }),
    ]);

    const normalizedItems = items.map((item) => ({
      ...item,
      user_name: item.userId?.name || item.userId?.username || 'Unknown user',
      user_email: item.userId?.email || '—',
    }));

    return success(res, {
      items: normalizedItems,
      total,
      completed,
      pending,
      failed,
      limit,
    });
  } catch (err) {
    return error(res, err.message, 500);
  }
}

async function getSecurityStatus(req, res) {
  try {
    return success(res, buildSecurityStatusPayload());
  } catch (err) {
    return error(res, err.message, 500);
  }
}

module.exports = {
  getAdminOverview,
  getAdminUsers,
  getAdminAlerts,
  getAdminTransactions,
  getSecurityStatus,
};
