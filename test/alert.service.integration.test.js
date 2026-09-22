// Price-alert processing against a real (in-memory) MongoDB.
//
// Alert runs are triggered by external schedulers, so overlapping runs are expected.
// These tests pin the properties that matter for that: one notification per alert no
// matter how many runs race, one quote per symbol, bounded market-API use, fair rotation
// across symbols, and retry of notifications that failed to deliver.

const mongoose = require('mongoose');
const {
  startMemoryMongo,
  stopMemoryMongo,
  resetCollections,
} = require('./helpers/memory.mongo');

jest.mock('../utils/mailer', () => ({
  sendNotificationEmail: jest.fn().mockResolvedValue(undefined),
}));

const PriceAlertModel = require('../models/price.alert.model');
const NotificationModel = require('../models/notification.model');
const UserModel = require('../models/user.model');
const { sendNotificationEmail } = require('../utils/mailer');
const { shouldTriggerAlert, processActiveAlerts } = require('../services/alert.service');

jest.setTimeout(120000);

const quotes = (prices) => jest.fn(async (symbol) => {
  if (!(symbol in prices)) throw new Error(`no quote for ${symbol}`);
  return { symbol, price: prices[symbol], source: 'live' };
});

async function createAlert(overrides = {}) {
  return PriceAlertModel.create({
    user_id: new mongoose.Types.ObjectId(),
    symbol: 'AAPL',
    target_price: 180,
    direction: 'above',
    ...overrides,
  });
}

const reload = (alert) => PriceAlertModel.findById(alert._id);

beforeAll(async () => {
  await startMemoryMongo();
});

afterAll(async () => {
  await stopMemoryMongo();
});

beforeEach(async () => {
  await resetCollections();
  await UserModel.deleteMany({});
  sendNotificationEmail.mockClear();
  sendNotificationEmail.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('shouldTriggerAlert', () => {
  it.each([
    ['above', 180, 180, true],
    ['above', 180, 181, true],
    ['above', 180, 179.99, false],
    ['below', 100, 100, true],
    ['below', 100, 99, true],
    ['below', 100, 100.01, false],
  ])('%s target %d at price %d -> %s', (direction, target, price, expected) => {
    expect(shouldTriggerAlert({ direction, target_price: target }, price)).toBe(expected);
  });

  it.each([[NaN], [undefined], ['181'], [null]])('never triggers on a non-numeric price (%p)', (price) => {
    expect(shouldTriggerAlert({ direction: 'above', target_price: 1 }, price)).toBe(false);
  });
});

describe('processActiveAlerts', () => {
  it('triggers an alert once the price crosses, records it, and notifies the owner', async () => {
    const alert = await createAlert({ symbol: 'AAPL', target_price: 180, direction: 'above' });

    const summary = await processActiveAlerts({ getQuote: quotes({ AAPL: 185 }) });

    expect(summary).toMatchObject({ checkedCount: 1, triggeredCount: 1, notifiedCount: 1 });
    const saved = await reload(alert);
    expect(saved).toMatchObject({ status: 'triggered', triggered: true, notificationSent: true, triggeredPrice: 185 });
    expect(saved.triggeredAt).toBeInstanceOf(Date);

    const notifications = await NotificationModel.find({ user_id: alert.user_id });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ type: 'alert' });
    expect(notifications[0].data).toMatchObject({ symbol: 'AAPL', current_price: 185 });
  });

  it('leaves the alert active, but records the check, when the threshold is not met', async () => {
    const alert = await createAlert({ symbol: 'MSFT', target_price: 300, direction: 'above' });

    const summary = await processActiveAlerts({ getQuote: quotes({ MSFT: 250 }) });

    expect(summary).toMatchObject({ checkedCount: 1, triggeredCount: 0 });
    const saved = await reload(alert);
    expect(saved.status).toBe('active');
    expect(saved.lastCheckedAt).toBeInstanceOf(Date);
    expect(await NotificationModel.countDocuments()).toBe(0);
  });

  it('handles "below" alerts', async () => {
    const alert = await createAlert({ symbol: 'TSLA', target_price: 100, direction: 'below' });

    await processActiveAlerts({ getQuote: quotes({ TSLA: 99 }) });

    expect((await reload(alert)).status).toBe('triggered');
  });

  it('does not notify again for an alert that already triggered', async () => {
    await createAlert({ symbol: 'AAPL', target_price: 180 });
    const getQuote = quotes({ AAPL: 185 });

    await processActiveAlerts({ getQuote });
    await processActiveAlerts({ getQuote });
    await processActiveAlerts({ getQuote });

    expect(await NotificationModel.countDocuments()).toBe(1);
  });

  it('skips disabled alerts', async () => {
    const alert = await createAlert({ status: 'disabled' });
    const getQuote = quotes({ AAPL: 999 });

    await processActiveAlerts({ getQuote });

    expect(getQuote).not.toHaveBeenCalled();
    expect((await reload(alert)).status).toBe('disabled');
  });

  it('does nothing when there are no alerts', async () => {
    const getQuote = jest.fn();

    await expect(processActiveAlerts({ getQuote })).resolves.toMatchObject({ checkedCount: 0, triggeredCount: 0 });
    expect(getQuote).not.toHaveBeenCalled();
  });

  it('returns an empty summary, without touching anything, when the database is not connected', async () => {
    Object.defineProperty(mongoose.connection, 'readyState', { value: 0, configurable: true });
    try {
      const getQuote = jest.fn();

      await expect(processActiveAlerts({ getQuote })).resolves.toMatchObject({ checkedCount: 0, triggeredCount: 0 });
      expect(getQuote).not.toHaveBeenCalled();
    } finally {
      delete mongoose.connection.readyState;
    }
  });
});

describe('market API usage', () => {
  it('fetches one quote per symbol however many alerts share it', async () => {
    await Promise.all([
      createAlert({ symbol: 'AAPL', target_price: 100 }),
      createAlert({ symbol: 'AAPL', target_price: 200 }),
      createAlert({ symbol: 'AAPL', target_price: 300 }),
      createAlert({ symbol: 'MSFT', target_price: 300 }),
    ]);
    const getQuote = quotes({ AAPL: 250, MSFT: 100 });

    const summary = await processActiveAlerts({ getQuote });

    expect(getQuote).toHaveBeenCalledTimes(2);
    expect(summary.checkedCount).toBe(4);
    expect(summary.triggeredCount).toBe(2); // AAPL >= 100 and >= 200
  });

  it('checks at most maxSymbols symbols per run and reports the rest as skipped', async () => {
    for (const symbol of ['A', 'B', 'C', 'D']) await createAlert({ symbol });
    const getQuote = quotes({ A: 1, B: 1, C: 1, D: 1 });

    const summary = await processActiveAlerts({ getQuote, maxSymbols: 2 });

    expect(getQuote).toHaveBeenCalledTimes(2);
    expect(summary.checkedCount).toBe(2);
    expect(summary.skippedSymbols).toHaveLength(2);
  });

  it('rotates fairly: every symbol gets checked across successive limited runs', async () => {
    for (const symbol of ['A', 'B', 'C', 'D', 'E']) await createAlert({ symbol });
    const prices = { A: 1, B: 1, C: 1, D: 1, E: 1 };
    const checkedOrder = [];
    const getQuote = jest.fn(async (symbol) => {
      checkedOrder.push(symbol);
      return { symbol, price: prices[symbol], source: 'live' };
    });

    // Three runs of 2 symbols cover all 5 (no symbol is starved by always going first).
    for (let run = 0; run < 3; run += 1) {
      await processActiveAlerts({ getQuote, maxSymbols: 2 });
    }

    expect(new Set(checkedOrder)).toEqual(new Set(['A', 'B', 'C', 'D', 'E']));
    // ...and nothing was re-checked before everything had been checked once.
    expect(checkedOrder.slice(0, 5)).toHaveLength(new Set(checkedOrder.slice(0, 5)).size);
  });

  it('reads the per-run symbol limit from ALERT_MAX_SYMBOLS_PER_RUN', async () => {
    process.env.ALERT_MAX_SYMBOLS_PER_RUN = '1';
    try {
      await createAlert({ symbol: 'A' });
      await createAlert({ symbol: 'B' });
      const getQuote = quotes({ A: 1, B: 1 });

      await processActiveAlerts({ getQuote });

      expect(getQuote).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.ALERT_MAX_SYMBOLS_PER_RUN;
    }
  });
});

describe('quote problems', () => {
  it('records the error, does not trigger, and still rotates when a quote fails', async () => {
    const alert = await createAlert({ symbol: 'BAD', target_price: 1, direction: 'above' });

    const summary = await processActiveAlerts({ getQuote: quotes({}) });

    expect(summary.failedSymbols).toEqual(['BAD']);
    const saved = await reload(alert);
    expect(saved.status).toBe('active');
    expect(saved.lastError).toMatch(/no quote/);
    expect(saved.lastCheckedAt).toBeInstanceOf(Date); // so a failing symbol does not starve the others
  });

  it('a failing symbol does not stop other symbols from triggering', async () => {
    await createAlert({ symbol: 'BAD' });
    const good = await createAlert({ symbol: 'GOOD', target_price: 10 });

    await processActiveAlerts({ getQuote: quotes({ GOOD: 20 }) });

    expect((await reload(good)).status).toBe('triggered');
  });

  it('clears an old error once the quote works again', async () => {
    const alert = await createAlert({ symbol: 'AAPL', target_price: 999, lastError: 'previous failure' });

    await processActiveAlerts({ getQuote: quotes({ AAPL: 100 }) });

    expect((await reload(alert)).lastError).toBe('');
  });

  it.each([
    ['demo fixture data', { price: 185.42, source: 'demo' }],
    ['a zero price', { price: 0, source: 'live' }],
    ['a string price', { price: '190', source: 'live' }],
    ['no price', { source: 'live' }],
  ])('never triggers on %s', async (_label, quote) => {
    const alert = await createAlert({ symbol: 'AAPL', target_price: 1, direction: 'above' });

    await processActiveAlerts({ getQuote: jest.fn().mockResolvedValue(quote) });

    expect((await reload(alert)).status).toBe('active');
    expect(await NotificationModel.countDocuments()).toBe(0);
  });
});

describe('overlapping runs', () => {
  it('sends exactly one notification per alert when many runs race', async () => {
    const alerts = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createAlert({ symbol: `S${i}`, target_price: 1, direction: 'above' }))
    );
    const prices = Object.fromEntries(alerts.map((a) => [a.symbol, 50]));

    const summaries = await Promise.all(
      Array.from({ length: 8 }, () => processActiveAlerts({ getQuote: quotes(prices), maxSymbols: 10 }))
    );

    expect(await NotificationModel.countDocuments()).toBe(6);
    expect(summaries.reduce((sum, s) => sum + s.triggeredCount, 0)).toBe(6);
    expect(sendNotificationEmail).not.toHaveBeenCalled(); // no user records -> no email, but no crash
    for (const alert of alerts) {
      expect(await NotificationModel.countDocuments({ user_id: alert.user_id })).toBe(1);
    }
  });
});

describe('notification delivery', () => {
  it('leaves a triggered alert undelivered when sending fails, then retries it', async () => {
    const alert = await createAlert({ symbol: 'AAPL', target_price: 100 });
    const send = jest.fn()
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValue(true);

    const first = await processActiveAlerts({ getQuote: quotes({ AAPL: 150 }), sendAlertNotification: send });

    expect(first).toMatchObject({ triggeredCount: 1, notifiedCount: 0 });
    let saved = await reload(alert);
    expect(saved).toMatchObject({ status: 'triggered', notificationSent: false, notificationAttempts: 1 });
    expect(saved.lastError).toMatch(/db blip/);

    const second = await processActiveAlerts({ getQuote: quotes({ AAPL: 150 }), sendAlertNotification: send });

    expect(second).toMatchObject({ retriedCount: 1, notifiedCount: 1 });
    saved = await reload(alert);
    expect(saved).toMatchObject({ notificationSent: true, notificationAttempts: 2, lastError: '' });
    expect(send).toHaveBeenCalledTimes(2);
    // The retry reports the price that fired the alert, not a fresh quote.
    expect(send.mock.calls[1][1]).toMatchObject({ price: 150 });
  });

  it('gives up after ALERT_MAX_NOTIFY_ATTEMPTS attempts', async () => {
    process.env.ALERT_MAX_NOTIFY_ATTEMPTS = '3';
    try {
      const alert = await createAlert({ symbol: 'AAPL', target_price: 100 });
      const send = jest.fn().mockRejectedValue(new Error('always down'));

      for (let run = 0; run < 6; run += 1) {
        await processActiveAlerts({ getQuote: quotes({ AAPL: 150 }), sendAlertNotification: send });
      }

      expect(send).toHaveBeenCalledTimes(3);
      expect((await reload(alert)).notificationAttempts).toBe(3);
    } finally {
      delete process.env.ALERT_MAX_NOTIFY_ATTEMPTS;
    }
  });

  it('takes each retry attempt in only one of several overlapping runs', async () => {
    const alert = await createAlert({ symbol: 'AAPL', target_price: 100 });
    await processActiveAlerts({
      getQuote: quotes({ AAPL: 150 }),
      sendAlertNotification: jest.fn().mockRejectedValue(new Error('down')),
    });
    const send = jest.fn().mockResolvedValue(true);

    await Promise.all(
      Array.from({ length: 6 }, () => processActiveAlerts({ getQuote: quotes({}), sendAlertNotification: send }))
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect((await reload(alert)).notificationSent).toBe(true);
  });
});

describe('delivery lease', () => {
  const inMinutes = (minutes) => new Date(Date.now() + minutes * 60 * 1000);

  async function createTriggered(overrides = {}) {
    return createAlert({
      status: 'triggered',
      triggered: true,
      triggeredAt: new Date(),
      triggeredPrice: 150,
      notificationSent: false,
      notificationAttempts: 1,
      ...overrides,
    });
  }

  it('leaves alone an alert another run is delivering right now (fresh lease)', async () => {
    const alert = await createTriggered({ notificationLeaseUntil: inMinutes(1) });
    const send = jest.fn().mockResolvedValue(true);

    const summary = await processActiveAlerts({ getQuote: quotes({}), sendAlertNotification: send });

    expect(summary.retriedCount).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect((await reload(alert)).notificationAttempts).toBe(1);
  });

  it('recovers an alert whose run died mid-delivery once the lease has expired', async () => {
    const alert = await createTriggered({ notificationLeaseUntil: inMinutes(-1) });
    const send = jest.fn().mockResolvedValue(true);

    const summary = await processActiveAlerts({ getQuote: quotes({}), sendAlertNotification: send });

    expect(summary).toMatchObject({ retriedCount: 1, notifiedCount: 1 });
    expect(await reload(alert)).toMatchObject({ notificationSent: true, notificationAttempts: 2 });
  });

  it('does not resurrect old undelivered alerts (outside the 24h retry window, or from before leases existed)', async () => {
    const stale = await createTriggered({
      notificationLeaseUntil: inMinutes(-1),
      triggeredAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });
    const legacy = await createTriggered({ notificationLeaseUntil: null });
    const send = jest.fn().mockResolvedValue(true);

    await processActiveAlerts({ getQuote: quotes({}), sendAlertNotification: send });

    expect(send).not.toHaveBeenCalled();
    expect((await reload(stale)).notificationSent).toBe(false);
    expect((await reload(legacy)).notificationSent).toBe(false);
  });

  it('never double-notifies across repeated rounds of racing runs', async () => {
    for (let round = 0; round < 5; round += 1) {
      await resetCollections();
      const alerts = await Promise.all(
        Array.from({ length: 4 }, (_, i) => createAlert({ symbol: `R${i}`, target_price: 1 }))
      );
      const prices = Object.fromEntries(alerts.map((a) => [a.symbol, 50]));

      await Promise.all(
        Array.from({ length: 10 }, () => processActiveAlerts({ getQuote: quotes(prices), maxSymbols: 10 }))
      );

      expect(await NotificationModel.countDocuments()).toBe(4);
    }
  });
});

describe('default notification delivery', () => {
  it('creates the in-app notification and emails the user', async () => {
    const user = await UserModel.create({
      name: 'Ada', username: 'ada', email: 'ada@example.com', password: 'Password1!', isVerified: true,
    });
    await createAlert({ user_id: user._id, symbol: 'AAPL', target_price: 100 });

    await processActiveAlerts({ getQuote: quotes({ AAPL: 150 }) });

    expect(await NotificationModel.countDocuments({ user_id: user._id })).toBe(1);
    expect(sendNotificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ada@example.com', title: 'Price Alert Triggered: AAPL' })
    );
  });

  it('still delivers (in-app) when the email fails: the alert is not lost or retried forever', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    sendNotificationEmail.mockRejectedValue(new Error('SMTP down'));
    const user = await UserModel.create({
      name: 'Ada', username: 'ada2', email: 'ada2@example.com', password: 'Password1!', isVerified: true,
    });
    const alert = await createAlert({ user_id: user._id, symbol: 'AAPL', target_price: 100 });

    const summary = await processActiveAlerts({ getQuote: quotes({ AAPL: 150 }) });

    expect(summary.notifiedCount).toBe(1);
    expect(await NotificationModel.countDocuments({ user_id: user._id })).toBe(1);
    expect((await reload(alert))).toMatchObject({ notificationSent: true, notificationAttempts: 1 });
  });

  it('does not wait forever on a hung email server', async () => {
    process.env.ALERT_EMAIL_TIMEOUT_MS = '50';
    try {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      sendNotificationEmail.mockReturnValue(new Promise(() => {})); // never settles
      const user = await UserModel.create({
        name: 'Ada', username: 'ada3', email: 'ada3@example.com', password: 'Password1!', isVerified: true,
      });
      const alert = await createAlert({ user_id: user._id, symbol: 'AAPL', target_price: 100 });

      const summary = await processActiveAlerts({ getQuote: quotes({ AAPL: 150 }) });

      expect(summary.notifiedCount).toBe(1);
      expect((await reload(alert)).notificationSent).toBe(true);
    } finally {
      delete process.env.ALERT_EMAIL_TIMEOUT_MS;
    }
  });
});
