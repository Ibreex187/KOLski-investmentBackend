const { resolveJwtSecrets } = require('../utils/jwt');

describe('resolveJwtSecrets', () => {
  let warnSpy;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it.each(['production', 'development', undefined])(
    'refuses to start without JWT_SECRET when NODE_ENV=%s',
    (nodeEnv) => {
      expect(() => resolveJwtSecrets({ NODE_ENV: nodeEnv })).toThrow(/JWT_SECRET is not set/);
    }
  );

  it('only falls back to a built-in secret in the test environment', () => {
    expect(resolveJwtSecrets({ NODE_ENV: 'test' })).toEqual({ access: 'testsecret', refresh: 'testsecret' });
  });

  it('never falls back to a guessable secret for a missing value in production', () => {
    // Regression: the old code used `process.env.JWT_SECRET || 'testsecret'` everywhere.
    expect(() => resolveJwtSecrets({ NODE_ENV: 'production' })).toThrow();
  });

  it.each(['change-me', 'CHANGE-ME', 'testsecret', 'secret', ' changeme '])(
    'rejects the placeholder secret "%s" in production',
    (placeholder) => {
      expect(() => resolveJwtSecrets({ NODE_ENV: 'production', JWT_SECRET: placeholder })).toThrow(/placeholder/);
    }
  );

  it('rejects a placeholder refresh secret in production', () => {
    expect(() =>
      resolveJwtSecrets({ NODE_ENV: 'production', JWT_SECRET: 'a-long-random-value', JWT_REFRESH_SECRET: 'change-me-too' })
    ).toThrow(/JWT_REFRESH_SECRET/);
  });

  it('accepts a real secret and uses a separate refresh secret when given', () => {
    expect(
      resolveJwtSecrets({ NODE_ENV: 'production', JWT_SECRET: 'access-secret-value', JWT_REFRESH_SECRET: 'refresh-secret-value' })
    ).toEqual({ access: 'access-secret-value', refresh: 'refresh-secret-value' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns (but still starts) in production when the refresh secret falls back to the access secret', () => {
    const secrets = resolveJwtSecrets({ NODE_ENV: 'production', JWT_SECRET: 'access-secret-value' });

    expect(secrets).toEqual({ access: 'access-secret-value', refresh: 'access-secret-value' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('JWT_REFRESH_SECRET'));
  });

  it('allows placeholder values outside production so local setups from .env.example keep working', () => {
    expect(resolveJwtSecrets({ NODE_ENV: 'development', JWT_SECRET: 'change-me' }).access).toBe('change-me');
  });
});
