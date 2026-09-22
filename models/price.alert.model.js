const mongoose = require('mongoose');

const priceAlertSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  symbol: { type: String, required: true, uppercase: true, trim: true, index: true },
  target_price: { type: Number, required: true, min: 0 },
  direction: { type: String, enum: ['above', 'below'], required: true },
  status: { type: String, enum: ['active', 'triggered', 'disabled'], default: 'active', index: true },
  triggered: { type: Boolean, default: false },
  triggeredAt: { type: Date, default: null },
  lastCheckedAt: { type: Date, default: null },
  notificationSent: { type: Boolean, default: false },
  notificationAttempts: { type: Number, default: 0 },
  // Delivery lease: whoever is delivering holds it until this time. Failure releases it at once;
  // a run that dies mid-delivery just lets it expire. Null = never claimed (or legacy data).
  notificationLeaseUntil: { type: Date, default: null },
  triggeredPrice: { type: Number, default: null },
  lastError: { type: String, default: '' },
}, { timestamps: true, strict: 'throw' });

priceAlertSchema.index({ user_id: 1, symbol: 1, status: 1, createdAt: -1 });

const PriceAlertModel = mongoose.models.PriceAlert || mongoose.model('PriceAlert', priceAlertSchema);

module.exports = PriceAlertModel;
