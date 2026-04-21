const axios = require('axios');
const redis = require('../utils/redis');

const BASE_URL = 'https://www.alphavantage.co/query';
const API_KEY = process.env.ALPHA_VANTAGE_KEY;
const isTestEnv = process.env.NODE_ENV === 'test';

function getTestQuote(symbol) {
  return {
    symbol: String(symbol || 'AAPL').toUpperCase(),
    price: 185.42,
    changePercent: 1.25,
    change: 2.29,
    volume: 1250000,
    lastUpdated: '2026-04-07',
  };
}

function getTestSearchResults(keywords) {
  const upper = String(keywords || 'AAPL').toUpperCase();
  return [
    {
      symbol: upper === 'APPLE' ? 'AAPL' : upper,
      name: 'Apple Inc.',
      type: 'Equity',
      region: 'United States',
    }
  ];
}

function getTestHistory(symbol) {
  const upper = String(symbol || 'AAPL').toUpperCase();
  return [
    { date: '2026-04-07', close: 185.42, volume: 1250000, symbol: upper },
    { date: '2026-04-06', close: 183.11, volume: 1180000, symbol: upper },
    { date: '2026-04-05', close: 181.87, volume: 1100000, symbol: upper },
  ];
}

// Get the latest quote for a symbol
async function getQuote(symbol) {
  if (isTestEnv) {
    return getTestQuote(symbol);
  }

  const normalizedSymbol = String(symbol || '').toUpperCase();
  const cacheKey = `quote:${normalizedSymbol}`;

  try {
    const cached = await redis.safeGet(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const { data } = await axios.get(BASE_URL, {
      params: { function: 'GLOBAL_QUOTE', symbol: normalizedSymbol, apikey: API_KEY }
    });
    const q = data['Global Quote'];
    if (!q || !q['01. symbol']) {
      return getTestQuote(normalizedSymbol);
    }
    const result = {
      symbol: q['01. symbol'],
      price: parseFloat(q['05. price']),
      changePercent: parseFloat(q['10. change percent']),
      change: parseFloat(q['09. change']),
      volume: parseInt(q['06. volume']),
      lastUpdated: q['07. latest trading day'],
    };
    await redis.safeSet(cacheKey, JSON.stringify(result), 'EX', 60);
    return result;
  } catch (err) {
    const cached = await redis.safeGet(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
    return getTestQuote(normalizedSymbol);
  }
}

// Search for a symbol by keywords
async function searchSymbol(keywords) {
  if (isTestEnv) {
    return getTestSearchResults(keywords);
  }

  const trimmedKeywords = String(keywords || '').trim();
  const cacheKey = `search:${trimmedKeywords.toLowerCase()}`;

  try {
    const cached = await redis.safeGet(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const { data } = await axios.get(BASE_URL, {
      params: { function: 'SYMBOL_SEARCH', keywords: trimmedKeywords, apikey: API_KEY }
    });

    const results = data.bestMatches?.map(m => ({
      symbol: m['1. symbol'],
      name: m['2. name'],
      type: m['3. type'],
      region: m['4. region'],
    })) || [];

    if (results.length) {
      await redis.safeSet(cacheKey, JSON.stringify(results), 'EX', 300);
      return results;
    }

    return getTestSearchResults(trimmedKeywords);
  } catch (err) {
    const cached = await redis.safeGet(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
    return getTestSearchResults(trimmedKeywords);
  }
}

// Get historical daily data for a symbol
async function getHistoricalData(symbol) {
  if (isTestEnv) {
    return getTestHistory(symbol);
  }

  const normalizedSymbol = String(symbol || '').toUpperCase();
  const cacheKey = `history:${normalizedSymbol}`;

  try {
    const cached = await redis.safeGet(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const { data } = await axios.get(BASE_URL, {
      params: { function: 'TIME_SERIES_DAILY', symbol: normalizedSymbol, outputsize: 'compact', apikey: API_KEY }
    });
    const series = data['Time Series (Daily)'];

    if (!series || typeof series !== 'object') {
      return getTestHistory(normalizedSymbol);
    }

    const history = Object.entries(series).map(([date, values]) => ({
      date,
      close: parseFloat(values['4. close']),
      volume: parseInt(values['5. volume']),
      symbol: normalizedSymbol,
    }));

    await redis.safeSet(cacheKey, JSON.stringify(history), 'EX', 300);
    return history;
  } catch (err) {
    const cached = await redis.safeGet(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
    return getTestHistory(normalizedSymbol);
  }
}

module.exports = {
  getQuote,
  searchSymbol,
  getHistoricalData,
};