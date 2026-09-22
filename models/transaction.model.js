const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  symbol: { type: String, required: true, uppercase: true },
  type: { type: String, enum: ['buy', 'sell', 'deposit', 'withdrawal'], required: true },
  shares: { type: Number, default: 0 },
  price: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'completed' },
  note: { type: String, default: '' },
  reference_id: { type: String, default: null, trim: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, strict: 'throw' });

transactionSchema.index({ userId: 1, createdAt: -1 });
// NOTE: a compound sparse index still indexes documents whose reference_id is null/missing
// (userId is always present), so two reference-less transactions for one user collide.
// Every writer therefore stores a reference (see storedReference in portfolio.service).
// A partialFilterExpression index would fix this properly but needs a data migration.
transactionSchema.index({ userId: 1, reference_id: 1 }, { unique: true, sparse: true });

const TransactionModel = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);

module.exports = TransactionModel;