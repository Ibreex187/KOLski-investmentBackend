const mongoose = require('mongoose');

const portfolioSnapshotSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  portfolio_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Portfolio',
    required: true,
    index: true,
  },
  total_value: {
    type: Number,
    required: true,
    min: 0,
  },
  cash_balance: {
    type: Number,
    required: true,
    min: 0,
  },
  invested: {
    type: Number,
    required: true,
    min: 0,
  },
  profit_loss: {
    type: Number,
    required: true,
    default: 0,
  },
  captured_at: {
    type: Date,
    required: true,
    default: Date.now,
    index: true,
  },
}, {
  timestamps: true,
  strict: 'throw',
});

portfolioSnapshotSchema.index({ user_id: 1, captured_at: -1 });
portfolioSnapshotSchema.index({ portfolio_id: 1, captured_at: -1 });

const PortfolioSnapshotModel = mongoose.models.PortfolioSnapshot || mongoose.model('PortfolioSnapshot', portfolioSnapshotSchema);

module.exports = PortfolioSnapshotModel;
