const mongoose = require('mongoose');
const PriceAlertModel = require('../models/price.alert.model');
const NotificationModel = require('../models/notification.model');
const UserModel = require('../models/user.model');
const marketService = require('./market.service');
const { sendNotificationEmail } = require('../utils/mailer');

function shouldTriggerAlert(alert, currentPrice) {
  if (!alert || typeof currentPrice !== 'number' || Number.isNaN(currentPrice)) {
    return false;
  }

  if (alert.direction === 'above') {
    return currentPrice >= alert.target_price;
  }

  if (alert.direction === 'below') {
    return currentPrice <= alert.target_price;
  }

  return false;
}

async function defaultSendAlertNotification(alert, quote) {
  if (mongoose.connection.readyState !== 1) {
    return false;
  }

  const user = await UserModel.findById(alert.user_id);
  if (!user?.email) {
    return false;
  }

  const message = `${alert.symbol} is now ${quote.price}, which is ${alert.direction} your target price of ${alert.target_price}.`;

  await sendNotificationEmail({
    to: user.email,
    name: user.name,
    title: `Price Alert Triggered: ${alert.symbol}`,
    message,
  });

  await NotificationModel.create({
    user_id: alert.user_id,
    type: 'alert',
    title: `Price Alert Triggered: ${alert.symbol}`,
    message,
    data: {
      symbol: alert.symbol,
      target_price: alert.target_price,
      direction: alert.direction,
      current_price: quote.price,
    },
  });

  return true;
}

async function processActiveAlerts(options = {}) {
  const getQuote = options.getQuote || marketService.getQuote;
  const sendAlertNotification = options.sendAlertNotification || defaultSendAlertNotification;

  let alerts = options.alerts;
  if (!alerts) {
    if (mongoose.connection.readyState !== 1 && !PriceAlertModel.find?._isMockFunction) {
      return { checkedCount: 0, triggeredCount: 0, alerts: [] };
    }

    alerts = await PriceAlertModel.find({ status: 'active' });
  }

  let checkedCount = 0;
  let triggeredCount = 0;

  for (const alert of alerts) {
    checkedCount += 1;

    try {
      const quote = await getQuote(alert.symbol);
      const currentPrice = Number(quote?.price);

      alert.lastCheckedAt = new Date();

      if (shouldTriggerAlert(alert, currentPrice)) {
        alert.status = 'triggered';
        alert.triggered = true;
        alert.triggeredAt = new Date();

        if (!alert.notificationSent) {
          await sendAlertNotification(alert, quote);
          alert.notificationSent = true;
        }

        triggeredCount += 1;
      }

      if (typeof alert.save === 'function') {
        await alert.save({ validateBeforeSave: false });
      }
    } catch (error) {
      alert.lastError = error.message;
      if (typeof alert.save === 'function') {
        await alert.save({ validateBeforeSave: false });
      }
    }
  }

  return {
    checkedCount,
    triggeredCount,
    alerts,
  };
}

function startAlertWorker(options = {}) {
  const intervalMs = Number(options.intervalMs || process.env.ALERT_CHECK_INTERVAL_MS || 60 * 1000);
  const runImmediately = options.runImmediately !== false;

  if (process.env.NODE_ENV === 'test') {
    return { stop() {} };
  }

  let isRunning = false;

  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await processActiveAlerts();
    } catch (error) {
      console.error('Alert worker error:', error.message);
    } finally {
      isRunning = false;
    }
  };

  if (runImmediately) {
    tick();
  }

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = {
  shouldTriggerAlert,
  processActiveAlerts,
  startAlertWorker,
};
