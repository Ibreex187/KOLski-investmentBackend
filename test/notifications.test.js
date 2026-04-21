const request = require('supertest');
const app = require('../app');
const NotificationModel = require('../models/notification.model');

jest.mock('../middleware/auth.middleware.js', () => {
  return (req, res, next) => {
    req.user = { _id: '507f1f77bcf86cd799439011', email: 'test@example.com' };
    next();
  };
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Notifications API', () => {
  it('GET /api/v1/notifications should return notifications for the user', async () => {
    jest.spyOn(NotificationModel, 'find').mockReturnValue({
      sort: jest.fn().mockResolvedValue([
        { _id: '1', title: 'Alert', message: 'Triggered', read: false },
      ]),
    });

    const res = await request(app).get('/api/v1/notifications');

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('PATCH /api/v1/notifications/:id/read should validate notification id', async () => {
    const res = await request(app).patch('/api/v1/notifications/bad-id/read');

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('PATCH /api/v1/notifications/read-all should mark notifications as read', async () => {
    jest.spyOn(NotificationModel, 'updateMany').mockResolvedValue({ modifiedCount: 2 });

    const res = await request(app).patch('/api/v1/notifications/read-all');

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
