const mongoose = require('mongoose');
const PriceAlertModel = require('../models/price.alert.model');
const NotificationModel = require('../models/notification.model');
const UserModel = require('../models/user.model');
const marketService = require('./market.service');
const { sendNotificationEmail } = require('../utils/mailer');

// How this runs
//  * On a long-lived server, startAlertWorker() calls processActiveAlerts() on a timer.
//  * On serverless (Vercel) there is no timer: an external scheduler calls
//    POST/GET /api/v1/internal/cron/check-alerts, which calls processActiveAlerts() once.
//  Either way several runs can overlap (scheduler retries, two schedulers, a slow run), so
//  every state change below is a conditional atomic update: a run that loses a race skips
//  the alert instead of notifying twice.

const MAX_ALERTS_PER_RUN = 1000;
const MAX_RETRY_ALERTS_PER_RUN = 50;
const NOTIFY_LEASE_MS = 60 * 1000; // longer than any single delivery can take
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000; // stop retrying stale alerts

const positiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// The market API has a tiny free quota (~25 calls/day), so a run only looks at a few
// symbols; alerts that were checked longest ago go first, so every symbol gets its turn.
const maxSymbolsPerRun = () => positiveInt(process.env.ALERT_MAX_SYMBOLS_PER_RUN, 2);
const emailTimeoutMs = () => positiveInt(process.env.ALERT_EMAIL_TIMEOUT_MS, 4000);
const maxNotifyAttempts = () => positiveInt(process.env.ALERT_MAX_NOTIFY_ATTEMPTS, 3);

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

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Creates the in-app notification (the record of truth, and what makes the alert
// "delivered"), then tries the email as a best-effort extra. A broken or slow SMTP
// server must not lose or delay the notification.
async function defaultSendAlertNotification(alert, quote) {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('Database unavailable');
  }

  const title = `Price Alert Triggered: ${alert.symbol}`;
  const message = `${alert.symbol} is now ${quote.price}, which is ${alert.direction} your target price of ${alert.target_price}.`;

  await NotificationModel.create({
    user_id: alert.user_id,
    type: 'alert',
    title,
    message,
    data: {
      symbol: alert.symbol,
      target_price: alert.target_price,
      direction: alert.direction,
      current_price: quote.price,
    },
  });

  try {
    const user = await UserModel.findById(alert.user_id);
    if (user?.email) {
      await withTimeout(
        sendNotificationEmail({ to: user.email, name: user.name, title, message }),
        emailTimeoutMs(),
        'Alert email'
      );
    }
  } catch (emailError) {
    console.error('Alert email failed (in-app notification was created):', emailError.message);
  }

  return true;
}

// One quote per distinct symbol, however many alerts share it.
async function fetchQuotes(symbols, getQuote) {
  const settled = await Promise.allSettled(
    symbols.map(async (symbol) => {
      const quote = await getQuote(symbol);
      // Fixture prices must never fire a real user's alert.
      if (quote?.source === 'demo') {
        throw new marketService.MarketDataUnavailableError('Demo prices are not used for alerts');
      }
      const price = quote?.price;
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        throw new marketService.MarketDataUnavailableError(`No valid price for ${symbol}`);
      }
      return quote;
    })
  );

  const quotes = new Map();
  const failures = new Map();
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      quotes.set(symbols[index], result.value);
    } else {
      failures.set(symbols[index], result.reason);
    }
  });
  return { quotes, failures };
}

// Deliver the notification for an alert this run has exclusively claimed.
async function deliver(alert, quote, sendAlertNotification) {
  try {
    await sendAlertNotification(alert, quote);
    await PriceAlertModel.updateOne({ _id: alert._id }, { $set: { notificationSent: true, lastError: '' } });
    return true;
  } catch (error) {
    await PriceAlertModel.updateOne(
      { _id: alert._id },
      { $set: { lastError: `Notification failed: ${error.message}`, notificationLeaseUntil: new Date() } }
    );
    return false;
  }
}

// Alerts that fired but whose notification failed (e.g. a database blip), or whose run
// died mid-delivery. Only alerts whose delivery lease has lapsed are retried, so an alert
// another run is delivering right now is left alone; the compare-and-set on the attempt
// counter then lets exactly one overlapping run take each retry.
async function retryUndelivered({ sendAlertNotification }) {
  const now = new Date();
  const pending = await PriceAlertModel.find({
    status: 'triggered',
    notificationSent: false,
    notificationAttempts: { $lt: maxNotifyAttempts() },
    notificationLeaseUntil: { $lte: now },
    triggeredAt: { $gte: new Date(now.getTime() - RETRY_WINDOW_MS) },
  }).limit(MAX_RETRY_ALERTS_PER_RUN);

  let retried = 0;
  let delivered = 0;

  for (const alert of pending) {
    const claimed = await PriceAlertModel.findOneAndUpdate(
      {
        _id: alert._id,
        status: 'triggered',
        notificationSent: false,
        notificationAttempts: alert.notificationAttempts,
        notificationLeaseUntil: { $lte: now },
      },
      {
        $set: {
          notificationAttempts: alert.notificationAttempts + 1,
          notificationLeaseUntil: new Date(Date.now() + NOTIFY_LEASE_MS),
        },
      },
      { returnDocument: 'after' }
    );
    if (!claimed) continue;

    retried += 1;
    // Report the price that fired the alert; a fresh quote is not needed to retell it.
    const quote = { symbol: claimed.symbol, price: claimed.triggeredPrice ?? claimed.target_price };
    if (await deliver(claimed, quote, sendAlertNotification)) {
      delivered += 1;
    }
  }

  return { retried, delivered };
}

async function processActiveAlerts(options = {}) {
  const getQuote = options.getQuote || marketService.getQuote;
  const sendAlertNotification = options.sendAlertNotification || defaultSendAlertNotification;
  const symbolLimit = options.maxSymbols ?? maxSymbolsPerRun();

  const summary = {
    checkedCount: 0,
    triggeredCount: 0,
    notifiedCount: 0,
    retriedCount: 0,
    failedSymbols: [],
    skippedSymbols: [],
  };

  if (mongoose.connection.readyState !== 1) {
    return summary;
  }

  // Retry earlier failed deliveries first, so a notification that fails in this run waits
  // for the next run (a scheduler interval later) instead of being hammered immediately.
  const retry = await retryUndelivered({ sendAlertNotification });
  summary.retriedCount = retry.retried;
  summary.notifiedCount += retry.delivered;

  // Never-checked first (null sorts first), then least recently checked.
  const active = await PriceAlertModel.find({ status: 'active' })
    .sort({ lastCheckedAt: 1 })
    .limit(MAX_ALERTS_PER_RUN);

  const symbols = [];
  for (const alert of active) {
    if (!symbols.includes(alert.symbol)) symbols.push(alert.symbol);
  }
  const chosen = new Set(symbols.slice(0, symbolLimit));
  summary.skippedSymbols = symbols.slice(symbolLimit);

  const { quotes, failures } = await fetchQuotes([...chosen], getQuote);
  summary.failedSymbols = [...failures.keys()];

  for (const alert of active) {
    if (!chosen.has(alert.symbol)) continue;
    summary.checkedCount += 1;
    const now = new Date();

    const failure = failures.get(alert.symbol);
    if (failure) {
      await PriceAlertModel.updateOne(
        { _id: alert._id, status: 'active' },
        { $set: { lastCheckedAt: now, lastError: failure.message } }
      );
      continue;
    }

    const quote = quotes.get(alert.symbol);
    if (!shouldTriggerAlert(alert, quote.price)) {
      await PriceAlertModel.updateOne(
        { _id: alert._id, status: 'active' },
        { $set: { lastCheckedAt: now, lastError: '' } }
      );
      continue;
    }

    // Claim the alert. Only the run that flips it out of "active" notifies.
    const claimed = await PriceAlertModel.findOneAndUpdate(
      { _id: alert._id, status: 'active' },
      {
        $set: {
          status: 'triggered',
          triggered: true,
          triggeredAt: now,
          triggeredPrice: quote.price,
          lastCheckedAt: now,
          notificationAttempts: 1,
          notificationLeaseUntil: new Date(Date.now() + NOTIFY_LEASE_MS),
        },
      },
      { returnDocument: 'after' }
    );
    if (!claimed) continue;

    summary.triggeredCount += 1;
    if (await deliver(claimed, quote, sendAlertNotification)) {
      summary.notifiedCount += 1;
    }
  }

  return summary;
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
