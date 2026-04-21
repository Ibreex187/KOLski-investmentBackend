const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: ['alert', 'trade', 'deposit', 'withdrawal', 'security', 'system'],
    required: true,
    default: 'system',
  },
  title: {
    type: String,
    required: true,
    trim: true,
  },
  message: {
    type: String,
    required: true,
    trim: true,
  },
  read: {
    type: Boolean,
    default: false,
    index: true,
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  readAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
  strict: 'throw',
});

notificationSchema.index({ user_id: 1, read: 1, createdAt: -1 });

notificationSchema.methods.markAsRead = function markAsRead() {
  this.read = true;
  this.readAt = new Date();
  return this;
};

const NotificationModel = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);

module.exports = NotificationModel;
