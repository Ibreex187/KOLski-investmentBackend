const mongoose = require('mongoose');
const PriceAlertModel = require('../models/price.alert.model');
const { processActiveAlerts } = require('../services/alert.service');

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Alert service', () => {
  it('should mark an above alert as triggered when price crosses the target', async () => {
    const alert = {
      _id: new mongoose.Types.ObjectId(),
      user_id: new mongoose.Types.ObjectId(),
      symbol: 'AAPL',
      target_price: 180,
      direction: 'above',
      status: 'active',
      notificationSent: false,
      save: jest.fn().mockResolvedValue(true),
    };

    const result = await processActiveAlerts({
      alerts: [alert],
      getQuote: jest.fn().mockResolvedValue({ symbol: 'AAPL', price: 185 }),
      sendAlertNotification: jest.fn().mockResolvedValue(true),
    });

    expect(result.triggeredCount).toBe(1);
    expect(alert.status).toBe('triggered');
    expect(alert.notificationSent).toBe(true);
    expect(alert.save).toHaveBeenCalled();
  });

  it('should leave alert active when threshold is not met', async () => {
    const alert = {
      _id: new mongoose.Types.ObjectId(),
      user_id: new mongoose.Types.ObjectId(),
      symbol: 'MSFT',
      target_price: 300,
      direction: 'above',
      status: 'active',
      notificationSent: false,
      save: jest.fn().mockResolvedValue(true),
    };

    const result = await processActiveAlerts({
      alerts: [alert],
      getQuote: jest.fn().mockResolvedValue({ symbol: 'MSFT', price: 250 }),
      sendAlertNotification: jest.fn().mockResolvedValue(true),
    });

    expect(result.triggeredCount).toBe(0);
    expect(alert.status).toBe('active');
    expect(alert.notificationSent).toBe(false);
  });

  it('should fetch active alerts from the model when not provided directly', async () => {
    jest.spyOn(PriceAlertModel, 'find').mockResolvedValue([]);

    const result = await processActiveAlerts({
      getQuote: jest.fn(),
      sendAlertNotification: jest.fn(),
    });

    expect(PriceAlertModel.find).toHaveBeenCalledWith({ status: 'active' });
    expect(result.checkedCount).toBe(0);
  });
});
