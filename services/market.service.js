const axios = require('axios');
const redis = require('../utils/redis');

const BASE_URL = 'https://www.alphavantage.co/query';
const REQUEST_TIMEOUT_MS = 8000;

// Evaluated per call (not at import) so tests and runtime config changes take effect.
const isTestEnv = () => process.env.NODE_ENV === 'test';
const getApiKey = () => process.env.ALPHA_VANTAGE_KEY;

// Fixture data is only served in the test environment, or when ALLOW_DEMO_MARKET_DATA=true
// is set explicitly (e.g. a portfolio demo without an API key). It is always labelled
// `source: 'demo'` so it can never be mistaken for a real market price.
const isDemoDataAllowed = () => isTestEnv() || process.env.ALLOW_DEMO_MARKET_DATA === 'true';

class MarketDataUnavailableError extends Error {
  constructor(message = 'Market data is temporarily unavailable', cause) {
    super(message);
    this.name = 'MarketDataUnavailableError';
    this.code = 'MARKET_DATA_UNAVAILABLE';
    this.status = 503;
    if (cause) this.cause = cause;
  }
}

function getDemoQuote(symbol) {
  return {
    symbol: String(symbol || 'AAPL').toUpperCase(),
    price: 185.42,
    changePercent: 1.25,
    change: 2.29,
    volume: 1250000,
    lastUpdated: '2026-04-07',
    source: 'demo',
  };
}

function getDemoSearchResults(keywords) {
  const upper = String(keywords || 'AAPL').toUpperCase();
  return [
    {
      symbol: upper === 'APPLE' ? 'AAPL' : upper,
      name: 'Apple Inc.',
      type: 'Equity',
      region: 'United States',
      source: 'demo',
    }
  ];
}

function getDemoHistory(symbol) {
  const upper = String(symbol || 'AAPL').toUpperCase();
  return [
    { date: '2026-04-07', close: 185.42, volume: 1250000, symbol: upper, source: 'demo' },
    { date: '2026-04-06', close: 183.11, volume: 1180000, symbol: upper, source: 'demo' },
    { date: '2026-04-05', close: 181.87, volume: 1100000, symbol: upper, source: 'demo' },
  ];
}

// Alpha Vantage answers rate-limit/quota problems with HTTP 200 and a `Note` or
// `Information` field instead of data, so "no data in the payload" means "unavailable".
function describeProviderProblem(data) {
  return data?.Note || data?.Information || data?.['Error Message'] || null;
}

async function readCache(cacheKey) {
  const cached = await redis.safeGet(cacheKey);
  return cached ? JSON.parse(cached) : null;
}

async function fetchProvider(params) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new MarketDataUnavailableError('Market data provider is not configured');
  }

  const { data } = await axios.get(BASE_URL, {
    params: { ...params, apikey: apiKey },
    timeout: REQUEST_TIMEOUT_MS,
  });
  return data;
}

// Either serve clearly-labelled demo data (if explicitly allowed) or fail loudly.
function demoOrThrow(demoValue, error) {
  if (isDemoDataAllowed()) {
    return demoValue;
  }

  if (error instanceof MarketDataUnavailableError) {
    throw error;
  }
  throw new MarketDataUnavailableError(undefined, error);
}

// Get the latest quote for a symbol
async function getQuote(symbol) {
  const normalizedSymbol = String(symbol || '').toUpperCase();

  if (isTestEnv()) {
    return getDemoQuote(normalizedSymbol);
  }

  const cacheKey = `quote:${normalizedSymbol}`;

  try {
    const cached = await readCache(cacheKey);
    if (cached) {
      return cached;
    }

    const data = await fetchProvider({ function: 'GLOBAL_QUOTE', symbol: normalizedSymbol });
    const q = data?.['Global Quote'];
    if (!q || !q['01. symbol']) {
      throw new MarketDataUnavailableError(
        describeProviderProblem(data) ? 'Market data provider limit reached' : `No quote available for ${normalizedSymbol}`
      );
    }

    const price = parseFloat(q['05. price']);
    if (!Number.isFinite(price) || price <= 0) {
      throw new MarketDataUnavailableError(`Invalid quote received for ${normalizedSymbol}`);
    }

    const result = {
      symbol: q['01. symbol'],
      price,
      changePercent: parseFloat(q['10. change percent']),
      change: parseFloat(q['09. change']),
      volume: parseInt(q['06. volume'], 10),
      lastUpdated: q['07. latest trading day'],
      source: 'live',
    };
    await redis.safeSet(cacheKey, JSON.stringify(result), 'EX', 60);
    return result;
  } catch (err) {
    return demoOrThrow(getDemoQuote(normalizedSymbol), err);
  }
}

// Search for a symbol by keywords
async function searchSymbol(keywords) {
  const trimmedKeywords = String(keywords || '').trim();

  if (isTestEnv()) {
    return getDemoSearchResults(trimmedKeywords);
  }

  const cacheKey = `search:${trimmedKeywords.toLowerCase()}`;

  try {
    const cached = await readCache(cacheKey);
    if (cached) {
      return cached;
    }

    const data = await fetchProvider({ function: 'SYMBOL_SEARCH', keywords: trimmedKeywords });
    if (!Array.isArray(data?.bestMatches)) {
      throw new MarketDataUnavailableError(
        describeProviderProblem(data) ? 'Market data provider limit reached' : undefined
      );
    }

    const results = data.bestMatches.map((m) => ({
      symbol: m['1. symbol'],
      name: m['2. name'],
      type: m['3. type'],
      region: m['4. region'],
    }));

    if (results.length) {
      await redis.safeSet(cacheKey, JSON.stringify(results), 'EX', 300);
    }
    // An empty list is a legitimate answer ("no such symbol"), not an outage.
    return results;
  } catch (err) {
    return demoOrThrow(getDemoSearchResults(trimmedKeywords), err);
  }
}

// Get historical daily data for a symbol
async function getHistoricalData(symbol) {
  const normalizedSymbol = String(symbol || '').toUpperCase();

  if (isTestEnv()) {
    return getDemoHistory(normalizedSymbol);
  }

  const cacheKey = `history:${normalizedSymbol}`;

  try {
    const cached = await readCache(cacheKey);
    if (cached) {
      return cached;
    }

    const data = await fetchProvider({ function: 'TIME_SERIES_DAILY', symbol: normalizedSymbol, outputsize: 'compact' });
    const series = data?.['Time Series (Daily)'];

    if (!series || typeof series !== 'object') {
      throw new MarketDataUnavailableError(
        describeProviderProblem(data) ? 'Market data provider limit reached' : `No history available for ${normalizedSymbol}`
      );
    }

    const history = Object.entries(series).map(([date, values]) => ({
      date,
      close: parseFloat(values['4. close']),
      volume: parseInt(values['5. volume'], 10),
      symbol: normalizedSymbol,
    }));

    await redis.safeSet(cacheKey, JSON.stringify(history), 'EX', 300);
    return history;
  } catch (err) {
    return demoOrThrow(getDemoHistory(normalizedSymbol), err);
  }
}

module.exports = {
  getQuote,
  searchSymbol,
  getHistoricalData,
  MarketDataUnavailableError,
};
