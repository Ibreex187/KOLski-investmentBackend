const mongoose = require('mongoose');
const PortfolioSnapshotModel = require('../models/portfolio.snapshot.model');
const {
  buildPerformanceHistory,
  buildAllocationBreakdown,
  buildReturnsSummary,
  buildBenchmarkComparison,
  buildRiskInsights,
  buildDashboardPayload,
  buildRecommendationCards,
} = require('../services/analytics.service');

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Analytics service', () => {
  it('should build chart-friendly performance history from snapshots', async () => {
    const snapshots = [
      {
        total_value: 1200,
        cash_balance: 200,
        invested: 1000,
        profit_loss: 200,
        captured_at: new Date('2026-04-08T10:00:00Z'),
      },
      {
        total_value: 1100,
        cash_balance: 150,
        invested: 950,
        profit_loss: 150,
        captured_at: new Date('2026-04-07T10:00:00Z'),
      },
    ];

    const history = await buildPerformanceHistory({ snapshots });

    expect(history.length).toBe(2);
    expect(history[0]).toHaveProperty('date');
    expect(history[0]).toHaveProperty('total_value', 1100);
    expect(history[1]).toHaveProperty('profit_loss', 200);
  });

  it('should read snapshots from the model when not provided directly', async () => {
    jest.spyOn(PortfolioSnapshotModel, 'find').mockReturnValue({
      sort: jest.fn().mockResolvedValue([]),
    });

    const userId = new mongoose.Types.ObjectId();
    const history = await buildPerformanceHistory({ userId });

    expect(Array.isArray(history)).toBe(true);
    expect(PortfolioSnapshotModel.find).toHaveBeenCalledWith({ user_id: userId });
  });

  it('should build allocation breakdown and top movers from holdings', () => {
    const result = buildAllocationBreakdown({
      holdings: [
        {
          symbol: 'AAPL',
          sector: 'Technology',
          market_value: 600,
          unrealized_pnl: 120,
          unrealized_pnl_percent: 25,
        },
        {
          symbol: 'MSFT',
          sector: 'Technology',
          market_value: 300,
          unrealized_pnl: -20,
          unrealized_pnl_percent: -6.67,
        },
        {
          symbol: 'JNJ',
          sector: 'Healthcare',
          market_value: 100,
          unrealized_pnl: 10,
          unrealized_pnl_percent: 11,
        },
      ],
      totalValue: 1000,
    });

    expect(result.by_symbol[0]).toHaveProperty('symbol', 'AAPL');
    expect(result.by_symbol[0]).toHaveProperty('allocation_percent', 60);
    expect(result.by_sector[0]).toHaveProperty('sector', 'Technology');
    expect(result.by_sector[0]).toHaveProperty('allocation_percent', 90);
    expect(result.top_gainers[0]).toHaveProperty('symbol', 'AAPL');
    expect(result.top_losers[0]).toHaveProperty('symbol', 'MSFT');
  });

  it('should build returns summary from portfolio history', () => {
    const result = buildReturnsSummary({
      history: [
        { captured_at: '2026-03-09T10:00:00Z', total_value: 800 },
        { captured_at: '2026-04-02T10:00:00Z', total_value: 900 },
        { captured_at: '2026-04-08T10:00:00Z', total_value: 1000 },
      ],
      currentValue: 1100,
      now: new Date('2026-04-09T10:00:00Z'),
    });

    expect(result).toMatchObject({
      day: 10,
      week: 22.22,
      month: 37.5,
    });
  });

  it('should build benchmark comparison against SPY history', () => {
    const result = buildBenchmarkComparison({
      portfolioHistory: [
        { captured_at: '2026-03-09T10:00:00Z', total_value: 800 },
        { captured_at: '2026-04-02T10:00:00Z', total_value: 900 },
        { captured_at: '2026-04-08T10:00:00Z', total_value: 1000 },
      ],
      currentPortfolioValue: 1100,
      benchmarkHistory: [
        { date: '2026-03-09', close: 400 },
        { date: '2026-04-02', close: 490 },
        { date: '2026-04-08', close: 500 },
        { date: '2026-04-09', close: 510 },
      ],
      benchmarkSymbol: 'SPY',
      now: new Date('2026-04-09T10:00:00Z'),
    });

    expect(result.benchmark_symbol).toBe('SPY');
    expect(result.day).toMatchObject({
      portfolio_return_percent: 10,
      benchmark_return_percent: 2,
      alpha_percent: 8,
    });
    expect(result.week).toMatchObject({
      portfolio_return_percent: 22.22,
      benchmark_return_percent: 4.08,
      alpha_percent: 18.14,
    });
  });

  it('should build risk insights with concentration and volatility summary', () => {
    const result = buildRiskInsights({
      holdings: [
        {
          symbol: 'AAPL',
          sector: 'Technology',
          market_value: 650,
          allocation_percent: 65,
          unrealized_pnl_percent: 12,
        },
        {
          symbol: 'MSFT',
          sector: 'Technology',
          market_value: 200,
          allocation_percent: 20,
          unrealized_pnl_percent: 6,
        },
        {
          symbol: 'JNJ',
          sector: 'Healthcare',
          market_value: 150,
          allocation_percent: 15,
          unrealized_pnl_percent: -3,
        },
      ],
      totalValue: 1000,
      returnsSummary: {
        day: 3.2,
        week: 8.5,
        month: 14.1,
      },
    });

    expect(result.diversification_score).toBe(35);
    expect(result.volatility_level).toBe('high');
    expect(result.concentration_warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('AAPL'),
        expect.stringContaining('Technology'),
      ])
    );
    expect(result.risk_flags.length).toBeGreaterThan(0);
  });

  it('should build a frontend-ready dashboard payload', () => {
    const result = buildDashboardPayload({
      analytics: {
        cash_balance: 200,
        total_value: 1200,
        invested: 1000,
        profit_loss: 200,
        profit_loss_percent: 20,
        returns_summary: { day: 2, week: 5, month: 8 },
        benchmark_comparison: { benchmark_symbol: 'SPY' },
        allocation_breakdown: { by_symbol: [], by_sector: [] },
        top_gainers: [{ symbol: 'AAPL' }],
        top_losers: [{ symbol: 'MSFT' }],
        risk_insights: { volatility_level: 'medium' },
      },
      notifications: [
        { title: 'Price alert hit', read: false },
      ],
      alerts: [
        { symbol: 'AAPL', status: 'active' },
        { symbol: 'MSFT', status: 'triggered' },
      ],
      unreadNotificationCount: 1,
    });

    expect(result.summary).toMatchObject({
      total_value: 1200,
      unread_notifications: 1,
      active_alerts: 1,
    });
    expect(result.performance.returns_summary).toHaveProperty('week', 5);
    expect(result.top_movers.gainers[0]).toHaveProperty('symbol', 'AAPL');
    expect(result.alerts).toHaveProperty('triggered_count', 1);
    expect(result.notifications).toHaveProperty('unread_count', 1);
  });

  it('should build recommendation cards from analytics signals', () => {
    const result = buildRecommendationCards({
      analytics: {
        returns_summary: { day: 1.2, week: 6.5, month: 14.2 },
        benchmark_comparison: {
          month: { alpha_percent: 5.6 },
        },
        risk_insights: {
          concentration_warnings: [
            'AAPL accounts for 65% of the portfolio, which is above the recommended single-asset limit.',
          ],
          risk_flags: [
            'Portfolio volatility is elevated based on recent return swings.',
          ],
          diversification_score: 35,
          volatility_level: 'high',
        },
      },
      alerts: [
        { status: 'active', symbol: 'AAPL' },
      ],
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'risk', priority: 'high' }),
        expect.objectContaining({ type: 'performance', priority: 'positive' }),
      ])
    );
  });
});
