const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  session_id: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true,
  },
  token_hash: {
    type: String,
    required: true,
    select: false,
  },
  device_name: {
    type: String,
    trim: true,
    default: 'unknown-device',
  },
  user_agent: {
    type: String,
    trim: true,
    default: '',
  },
  ip_address: {
    type: String,
    trim: true,
    default: '',
  },
  last_used_at: {
    type: Date,
    default: Date.now,
  },
  expires_at: {
    type: Date,
    required: true,
    index: true,
  },
  revoked_at: {
    type: Date,
    default: null,
  },
  is_revoked: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  strict: 'throw',
});

SessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
SessionSchema.index({ user_id: 1, is_revoked: 1, expires_at: -1 });

SessionSchema.methods.isActive = function isActive() {
  return !this.is_revoked && this.expires_at instanceof Date && this.expires_at > new Date();
};

SessionSchema.methods.revoke = function revoke() {
  this.is_revoked = true;
  this.revoked_at = this.revoked_at || new Date();
  return this;
};

SessionSchema.methods.touch = function touch(when = new Date()) {
  this.last_used_at = when;
  return this;
};

const SessionModel = mongoose.models.Session || mongoose.model('Session', SessionSchema);

module.exports = SessionModel;
