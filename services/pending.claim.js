const TransactionModel = require('../models/transaction.model');

const sessionOption = (session) => (session ? { session } : {});

// Atomically moves a *pending* transaction to `status` and records `metadata` fields,
// in one conditional update. When several reviewers act on the same request at once,
// exactly one of them gets the document back; everyone else gets null.
//
// (Read, check `status === 'pending'`, then save() is not safe: every concurrent reader
// sees "pending" and each one applies the money movement.)
async function claimPendingTransaction({ filter, status, metadata = {} }, session = null) {
  const set = { status };
  for (const [key, value] of Object.entries(metadata)) {
    set[`metadata.${key}`] = value;
  }

  return TransactionModel.findOneAndUpdate(
    { ...filter, status: 'pending' },
    { $set: set },
    { returnDocument: 'after', ...sessionOption(session) }
  );
}

// Inverse of claimPendingTransaction, used to roll a claim back when the money
// movement that must accompany it fails.
async function releaseClaim(transactionId, claimedStatus, metadataKeys) {
  const unset = {};
  for (const key of metadataKeys) {
    unset[`metadata.${key}`] = '';
  }

  return TransactionModel.updateOne(
    { _id: transactionId, status: claimedStatus },
    { $set: { status: 'pending' }, $unset: unset }
  );
}

// Runs registered undo steps newest-first, best effort.
async function runUndo(steps) {
  for (const undo of [...steps].reverse()) {
    try {
      await undo();
    } catch (undoError) {
      console.error('Rollback step failed; portfolio needs reconciliation:', undoError.message);
    }
  }
}

module.exports = { claimPendingTransaction, releaseClaim, runUndo };
