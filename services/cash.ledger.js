const PortfolioModel = require('../models/portfolio.model');

// Atomically add `delta` to a user's cash balance (kept to 2dp) in a single database
// update. Never read a portfolio, change `cash_balance` in memory and `save()` it:
// that writes back a stale balance and silently erases any change made in between.
//
//  - requireFunds: only match while the balance covers a debit, so it cannot go negative.
//  - realizedPnlDelta / totalDepositedDelta / totalWithdrawnDelta: kept in the same update.
//
// Resolves to the updated portfolio, or null when nothing matched (no portfolio, or
// insufficient funds when requireFunds is set).
async function adjustCash(userId, delta, options = {}, session = null) {
  const {
    requireFunds = false,
    realizedPnlDelta = 0,
    totalDepositedDelta = 0,
    totalWithdrawnDelta = 0,
  } = options;

  const filter = { user_id: userId };
  if (requireFunds) {
    filter.cash_balance = { $gte: -delta };
  }

  const addRounded = (path, amount) => ({
    $round: [{ $add: [{ $ifNull: [`$${path}`, 0] }, amount] }, 2],
  });

  const fields = {
    cash_balance: { $round: [{ $add: ['$cash_balance', delta] }, 2] },
    last_updated: '$$NOW',
  };
  if (realizedPnlDelta) fields['performance.realized_pnl'] = addRounded('performance.realized_pnl', realizedPnlDelta);
  if (totalDepositedDelta) fields.total_deposited = addRounded('total_deposited', totalDepositedDelta);
  if (totalWithdrawnDelta) fields.total_withdrawn = addRounded('total_withdrawn', totalWithdrawnDelta);

  return PortfolioModel.findOneAndUpdate(
    filter,
    [{ $set: fields }],
    { new: true, updatePipeline: true, timestamps: false, ...(session ? { session } : {}) }
  );
}

module.exports = { adjustCash };
