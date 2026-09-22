const mongoose = require('mongoose');
const PortfolioModel = require('../models/portfolio.model');
const TransactionModel = require('../models/transaction.model');
const { adjustCash } = require('./cash.ledger');
const { claimPendingTransaction, releaseClaim, runUndo } = require('./pending.claim');
const { buildCreatedAtFilter } = require('../utils/date.range');

function toMoney(value) {
  return parseFloat(Number(value || 0).toFixed(2));
}

function isTransactionSupportError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('replica set') || message.includes('transaction numbers are only allowed');
}

async function runWithOptionalTransaction(work) {
  const canUseTransaction = mongoose.connection.readyState === 1 && typeof mongoose.startSession === 'function';
  if (!canUseTransaction) {
    return work(null);
  }

  const session = await mongoose.startSession();
  try {
    if (typeof session.withTransaction === 'function') {
      let result;
      try {
        await session.withTransaction(async () => {
          result = await work(session);
        });
        return result;
      } catch (error) {
        if (isTransactionSupportError(error)) {
          return work(null);
        }
        throw error;
      }
    }

    return work(session);
  } finally {
    if (typeof session.endSession === 'function') {
      await session.endSession();
    }
  }
}

async function findOneWithSession(model, filter, session) {
  const query = model.findOne(filter);
  if (session && query && typeof query.session === 'function') {
    return query.session(session);
  }
  return query;
}

async function findManyWithSession(model, filter, options, session) {
  const query = model.find(filter)
    .sort(options.sort || { createdAt: -1 })
    .skip(options.skip || 0)
    .limit(options.limit || 20);

  if (session && query && typeof query.session === 'function') {
    return query.session(session);
  }

  return query;
}

async function createWithSession(model, payload, session) {
  if (session) {
    const docs = await model.create([payload], { session });
    return Array.isArray(docs) ? docs[0] : docs;
  }
  return model.create(payload);
}

function makeStateTransitionError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function makeNotFoundError(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

function formatWithdrawalRecord(tx) {
  const metadata = tx.metadata || {};
  const reviewedAt = metadata.approved_at || metadata.rejected_at || null;

  return {
    withdrawal_id: tx._id,
    amount: tx.total,
    currency: metadata.currency || 'USD',
    status: tx.status,
    destination_reference: metadata.destination_reference || null,
    submitted_at: metadata.submitted_at || tx.createdAt,
    reviewed_at: reviewedAt,
    rejection_reason: metadata.rejection_reason || null,
    note: tx.note || '',
    created_at: tx.createdAt,
    updated_at: tx.updatedAt,
  };
}

function normalizePaging(options = {}) {
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(options.limit, 10) || 20));
  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

async function createManualWithdrawalRequest(userId, payload = {}) {
  const amount = toMoney(payload.amount);
  const currency = String(payload.currency || 'USD').toUpperCase();
  const destinationReference = String(payload.destination_reference || '').trim();
  const idempotencyKey = String(payload.idempotency_key || '').trim();
  const note = payload.note ? String(payload.note) : '';

  if (!amount || amount <= 0) {
    throw new Error('Amount must be a positive number');
  }
  if (!destinationReference) {
    throw new Error('Destination reference is required');
  }
  if (!idempotencyKey) {
    throw new Error('Idempotency key is required');
  }
  if (currency !== 'USD') {
    throw new Error('Only USD is supported for manual withdrawals right now');
  }

  try {
    return await runWithOptionalTransaction(async (session) => {
      const existing = await findOneWithSession(TransactionModel, {
        userId,
        type: 'withdrawal',
        reference_id: idempotencyKey,
        'metadata.withdrawal_flow': 'manual_bank_transfer',
      }, session);

      if (existing) {
        return {
          ...formatWithdrawalRecord(existing),
          idempotent: true,
        };
      }

      const portfolio = await findOneWithSession(PortfolioModel, { user_id: userId }, session);
      if (!portfolio) {
        throw makeNotFoundError('Portfolio not found');
      }

      if (toMoney(portfolio.cash_balance) < amount) {
        throw new Error('Insufficient cash balance for withdrawal request');
      }

      const tx = await createWithSession(TransactionModel, {
        userId,
        symbol: 'CASH',
        type: 'withdrawal',
        total: amount,
        status: 'pending',
        reference_id: idempotencyKey,
        note,
        metadata: {
          withdrawal_flow: 'manual_bank_transfer',
          source: 'withdrawals.manual',
          currency,
          destination_reference: destinationReference,
          idempotency_key: idempotencyKey,
          submitted_at: new Date(),
        },
      }, session);

      return {
        ...formatWithdrawalRecord(tx),
        idempotent: false,
      };
    });
  } catch (error) {
    // A simultaneous request with the same key won the unique (userId, reference_id)
    // index; treat this one as the idempotent repeat it is.
    if (error?.code === 11000) {
      const existing = await TransactionModel.findOne({
        userId,
        type: 'withdrawal',
        reference_id: idempotencyKey,
        'metadata.withdrawal_flow': 'manual_bank_transfer',
      });
      if (existing) {
        return { ...formatWithdrawalRecord(existing), idempotent: true };
      }
    }
    throw error;
  }
}

async function listUserManualWithdrawals(userId, options = {}) {
  const paging = normalizePaging(options);
  const { filter: createdAtFilter, error: dateError } = buildCreatedAtFilter({
    startDate: options.startDate,
    endDate: options.endDate,
  });

  if (dateError) {
    throw new Error(dateError);
  }

  const filter = {
    userId,
    type: 'withdrawal',
    'metadata.withdrawal_flow': 'manual_bank_transfer',
    ...(createdAtFilter || {}),
  };

  if (options.status) {
    filter.status = options.status;
  }

  const [items, total] = await Promise.all([
    findManyWithSession(TransactionModel, filter, paging, null),
    TransactionModel.countDocuments(filter),
  ]);

  return {
    items: items.map(formatWithdrawalRecord),
    total,
    page: paging.page,
    pages: Math.ceil(total / paging.limit),
  };
}

async function getUserManualWithdrawalById(userId, withdrawalId) {
  const tx = await TransactionModel.findOne({
    _id: withdrawalId,
    userId,
    type: 'withdrawal',
    'metadata.withdrawal_flow': 'manual_bank_transfer',
  });

  if (!tx) {
    throw makeNotFoundError('Withdrawal not found');
  }

  return formatWithdrawalRecord(tx);
}

async function listAdminManualWithdrawals(options = {}) {
  const paging = normalizePaging(options);
  const { filter: createdAtFilter, error: dateError } = buildCreatedAtFilter({
    startDate: options.startDate,
    endDate: options.endDate,
  });

  if (dateError) {
    throw new Error(dateError);
  }

  const filter = {
    type: 'withdrawal',
    'metadata.withdrawal_flow': 'manual_bank_transfer',
    ...(createdAtFilter || {}),
  };

  if (options.status) {
    filter.status = options.status;
  }

  const [items, total] = await Promise.all([
    TransactionModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(paging.skip)
      .limit(paging.limit)
      .populate({ path: 'userId', select: 'name username email role' }),
    TransactionModel.countDocuments(filter),
  ]);

  return {
    items: items.map((tx) => ({
      ...formatWithdrawalRecord(tx),
      user: tx.userId
        ? {
          id: tx.userId._id,
          name: tx.userId.name || tx.userId.username || 'Unknown user',
          email: tx.userId.email || null,
        }
        : null,
    })),
    total,
    page: paging.page,
    pages: Math.ceil(total / paging.limit),
  };
}

async function approveManualWithdrawal({ withdrawalId, adminUserId, adminNote, bankSettlementRef }) {
  const baseFilter = {
    _id: withdrawalId,
    type: 'withdrawal',
    'metadata.withdrawal_flow': 'manual_bank_transfer',
  };
  const approval = {
    approved_by: adminUserId,
    approved_at: new Date(),
    bank_settlement_ref: bankSettlementRef || null,
    admin_note: adminNote || null,
  };

  return runWithOptionalTransaction(async (session) => {
    const undo = session ? null : [];

    try {
      // Claim first: only one concurrent approver can move a request out of "pending",
      // so the money below is applied at most once.
      const tx = await claimPendingTransaction({ filter: baseFilter, status: 'completed', metadata: approval }, session);
      if (!tx) {
        throw await explainUnclaimed(baseFilter, session);
      }
      undo?.push(() => releaseClaim(tx._id, 'completed', Object.keys(approval)));

    // Debit only while the balance still covers it (it may have been spent since the request).
    const portfolio = await adjustCash(tx.userId, -tx.total, { requireFunds: true, totalWithdrawnDelta: tx.total }, session);
    if (!portfolio) {
      const owner = await PortfolioModel.exists({ user_id: tx.userId });
      throw owner
        ? makeStateTransitionError('Insufficient cash balance to approve withdrawal')
        : makeNotFoundError('Portfolio not found for withdrawal owner');
    }

    return {
      withdrawal_id: tx._id,
      status: tx.status,
      debited_amount: tx.total,
      new_cash_balance: portfolio.cash_balance,
      approved_at: approval.approved_at,
    };
    } catch (error) {
      if (undo) await runUndo(undo);
      throw error;
    }
  });
}

async function explainUnclaimed(baseFilter, session) {
  const query = TransactionModel.exists(baseFilter);
  const exists = await (session ? query.session(session) : query);
  return exists
    ? makeStateTransitionError('Withdrawal is already reviewed')
    : makeNotFoundError('Withdrawal not found');
}

async function rejectManualWithdrawal({ withdrawalId, adminUserId, reason, adminNote }) {
  const baseFilter = {
    _id: withdrawalId,
    type: 'withdrawal',
    'metadata.withdrawal_flow': 'manual_bank_transfer',
  };
  const rejection = {
    rejected_by: adminUserId,
    rejected_at: new Date(),
    rejection_reason: reason,
    admin_note: adminNote || null,
  };

  const tx = await claimPendingTransaction({ filter: baseFilter, status: 'failed', metadata: rejection });
  if (!tx) {
    throw await explainUnclaimed(baseFilter, null);
  }

  return {
    withdrawal_id: tx._id,
    status: tx.status,
    rejected_at: rejection.rejected_at,
    reason,
  };
}

module.exports = {
  createManualWithdrawalRequest,
  listUserManualWithdrawals,
  getUserManualWithdrawalById,
  listAdminManualWithdrawals,
  approveManualWithdrawal,
  rejectManualWithdrawal,
};
