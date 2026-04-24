const path = require('path');

describe('Serverless handler CORS on DB failure', () => {
  const appPath = path.resolve(__dirname, '../app.js');
  const dbPath = path.resolve(__dirname, '../utils/db.js');
  const handlerPath = path.resolve(__dirname, '../api/index.js');

  afterEach(() => {
    jest.resetModules();
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.NODE_ENV;
  });

  it('returns CORS headers for allowed origin when DB connection fails', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOWED_ORIGINS = 'https://kolskinv.vercel.app';

    jest.doMock(appPath, () => jest.fn());
    jest.doMock(dbPath, () => ({
      connectToDatabase: jest.fn().mockRejectedValue(new Error('db down')),
    }));

    // eslint-disable-next-line global-require
    const handler = require(handlerPath);

    const req = {
      headers: {
        origin: 'https://kolskinv.vercel.app',
      },
    };

    const response = {
      statusCode: null,
      headers: {},
      payload: null,
      setHeader(name, value) {
        this.headers[name] = value;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.payload = body;
        return this;
      },
    };

    await handler(req, response);

    expect(response.statusCode).toBe(500);
    expect(response.payload).toEqual({
      success: false,
      message: 'Database connection failed',
    });
    expect(response.headers['Access-Control-Allow-Origin']).toBe('https://kolskinv.vercel.app');
    expect(response.headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(response.headers.Vary).toBe('Origin');
  });
});
