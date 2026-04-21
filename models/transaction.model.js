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
transactionSchema.index({ userId: 1, reference_id: 1 }, { unique: true, sparse: true });

const TransactionModel = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);

module.exports = TransactionModel;