// The cron endpoint is reachable from the public internet, so it must be locked to
// callers holding CRON_SECRET, disabled entirely when no secret is configured, and must
// never reveal alert/user data.

jest.mock('../services/alert.service', () => ({
  processActiveAlerts: jest.fn(),
  startAlertWorker: jest.fn(() => ({ stop() {} })),
  shouldTriggerAlert: jest.fn(),
}));

const request = require('supertest');
const app = require('../app');
const { processActiveAlerts } = require('../services/alert.service');

const PATH = '/api/v1/internal/cron/check-alerts';
const SECRET = 'a-long-random-cron-secret-value';
const summary = {
  checkedCount: 3,
  triggeredCount: 1,
  notifiedCount: 1,
  retriedCount: 0,
  failedSymbols: [],
  skippedSymbols: ['MSFT'],
};

describe('cron check-alerts endpoint', () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    processActiveAlerts.mockReset().mockResolvedValue(summary);
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  describe('authentication', () => {
    it('is disabled (503), not open, when CRON_SECRET is not configured', async () => {
      delete process.env.CRON_SECRET;

      const res = await request(app).get(PATH).set('Authorization', `Bearer ${SECRET}`);

      expect(res.statusCode).toBe(503);
      expect(res.body.error.code).toBe('CRON_NOT_CONFIGURED');
      expect(processActiveAlerts).not.toHaveBeenCalled();
    });

    it.each(['undefined', 'null', ''])('is not opened by sending the literal "%s" when no secret is configured', async (value) => {
      delete process.env.CRON_SECRET;

      const res = await request(app).get(PATH).set('Authorization', `Bearer ${value}`);

      expect(res.statusCode).toBe(503);
      expect(processActiveAlerts).not.toHaveBeenCalled();
    });

    it('rejects a request with no credentials', async () => {
      const res = await request(app).get(PATH);

      expect(res.statusCode).toBe(401);
      expect(processActiveAlerts).not.toHaveBeenCalled();
    });

    it.each([
      ['a wrong secret', 'Bearer wrong-secret'],
      ['a secret with different length', 'Bearer short'],
      ['a near-miss (one character off)', `Bearer ${SECRET.slice(0, -1)}X`],
      ['a prefix of the secret', `Bearer ${SECRET.slice(0, 10)}`],
      ['the secret plus extra characters', `Bearer ${SECRET}extra`],
      ['an empty bearer token', 'Bearer '],
      ['the wrong scheme', `Basic ${SECRET}`],
      ['the secret without a scheme', SECRET],
      ['a lowercase scheme', `bearer ${SECRET}`],
    ])('rejects %s', async (_label, header) => {
      const res = await request(app).get(PATH).set('Authorization', header);

      expect(res.statusCode).toBe(401);
      expect(processActiveAlerts).not.toHaveBeenCalled();
    });

    it('does not accept the secret in the query string or body', async () => {
      const viaQuery = await request(app).get(`${PATH}?secret=${SECRET}`);
      const viaBody = await request(app).post(PATH).send({ secret: SECRET });

      expect(viaQuery.statusCode).toBe(401);
      expect(viaBody.statusCode).toBe(401);
      expect(processActiveAlerts).not.toHaveBeenCalled();
    });

    it('never echoes the secret back', async () => {
      const res = await request(app).get(PATH).set('Authorization', 'Bearer nope');

      expect(JSON.stringify(res.body)).not.toContain(SECRET);
    });
  });

  describe('when authorised', () => {
    it('runs one alert pass on GET (how Vercel Cron calls it) and returns only counts', async () => {
      const res = await request(app).get(PATH).set('Authorization', `Bearer ${SECRET}`);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true, data: summary });
      expect(processActiveAlerts).toHaveBeenCalledTimes(1);
    });

    it('also accepts POST (how GitHub Actions calls it)', async () => {
      const res = await request(app).post(PATH).set('Authorization', `Bearer ${SECRET}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.data.checkedCount).toBe(3);
    });

    it('answers 500 with a generic message, hiding internals, when the run fails', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      processActiveAlerts.mockRejectedValue(new Error('mongodb://user:pass@host exploded'));

      const res = await request(app).get(PATH).set('Authorization', `Bearer ${SECRET}`);

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'Alert check failed' });
    });

    it('does not accept other methods', async () => {
      const res = await request(app).delete(PATH).set('Authorization', `Bearer ${SECRET}`);

      expect(res.statusCode).toBe(404);
      expect(processActiveAlerts).not.toHaveBeenCalled();
    });
  });
});

describe('vercel.json cron configuration', () => {
  const { crons = [] } = require('../vercel.json');

  const originalSecret = process.env.CRON_SECRET;

  beforeAll(() => {
    process.env.CRON_SECRET = SECRET;
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it('declares at least one cron', () => {
    expect(crons.length).toBeGreaterThan(0);
  });

  it.each(crons.map((cron) => [cron.path, cron.schedule]))('cron %s points at a real, protected route', async (path) => {
    const res = await request(app).get(path);

    // 401 = route exists and is locked; 404 would mean the cron calls nothing.
    expect(res.statusCode).toBe(401);
  });

  it.each(crons.map((cron) => [cron.schedule]))(
    'schedule "%s" runs at most once a day, which is all the free Hobby plan accepts (more frequent crons fail the deploy)',
    (schedule) => {
      const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule.split(' ');
      const isSingleNumber = (field) => /^\d+$/.test(field);

      expect(isSingleNumber(minute)).toBe(true);
      expect(isSingleNumber(hour)).toBe(true);
      expect([dayOfMonth, month, dayOfWeek]).toEqual(['*', '*', '*']);
    }
  );
});

