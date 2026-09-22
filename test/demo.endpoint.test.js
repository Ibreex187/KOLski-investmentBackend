// The public "Try Demo" endpoint, against a real (in-memory) MongoDB.

const {
  startMemoryMongo,
  stopMemoryMongo,
  resetCollections,
} = require('./helpers/memory.mongo');

const UserModel = require('../models/user.model');
const SessionModel = require('../models/session.model');
const demoService = require('../services/demo.service');

jest.setTimeout(120000);

const PATH = '/api/v1/demo/login';
let app;
let request;

beforeAll(async () => {
  await startMemoryMongo();
  request = require('supertest');
  app = require('../app');
});

afterAll(async () => {
  await stopMemoryMongo();
});

beforeEach(async () => {
  await resetCollections();
  await UserModel.deleteMany({});
  await SessionModel.deleteMany({});
});

describe('POST /api/v1/demo/login', () => {
  it('logs in with no credentials and returns a normal session for the demo user', async () => {
    const res = await request(app).post(PATH).send({});

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({
      email: demoService.DEMO_EMAIL,
      role: 'user',
      isDemo: true,
    });
  });

  it('the token actually authenticates as the demo user', async () => {
    const login = await request(app).post(PATH);

    const me = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${login.body.token}`);

    expect(me.statusCode).toBe(200);
    expect(me.body.data).toMatchObject({ email: demoService.DEMO_EMAIL, isDemo: true });
  });

  it('never grants admin access', async () => {
    const login = await request(app).post(PATH);

    const overview = await request(app).get('/api/v1/admin/overview').set('Authorization', `Bearer ${login.body.token}`);

    expect(overview.statusCode).toBe(403);
  });

  it('seeds the account on the very first login', async () => {
    expect(await UserModel.countDocuments({ email: demoService.DEMO_EMAIL })).toBe(0);

    await request(app).post(PATH);

    const user = await UserModel.findOne({ email: demoService.DEMO_EMAIL });
    expect(user).not.toBeNull();
    expect(user.isDemo).toBe(true);
  });

  it('gives repeat visitors their own session without resetting the shared data', async () => {
    const first = await request(app).post(PATH);
    const second = await request(app).post(PATH);

    // Access tokens carry no unique id and can be issued within the same second, so two
    // logins can legitimately produce byte-identical (still equally valid) access tokens.
    // The refresh token always carries a unique session id (jti) and is the reliable check.
    expect(first.body.refreshToken).not.toBe(second.body.refreshToken);
    expect(first.body.user.email).toBe(second.body.user.email);
    // Two independent sessions exist for the one shared account.
    expect(await SessionModel.countDocuments({})).toBe(2);
  });

  it('is rate limited', async () => {
    const max = Number(process.env.DEMO_LOGIN_RATE_LIMIT_MAX || 30);

    let last;
    for (let i = 0; i <= max; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      last = await request(app).post(PATH);
    }

    expect(last.statusCode).toBe(429);
  });

  it('does not accept other methods', async () => {
    const res = await request(app).get(PATH);
    expect(res.statusCode).toBe(404);
  });
});
