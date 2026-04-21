const {
  computeReconciliationSnapshot,
  buildReconciliationSummary,
} = require('../services/reconciliation.service');

describe('Reconciliation service', () => {
  const transactions = [
    { type: 'deposit', total: 1000, createdAt: '2026-04-01T10:00:00Z' },
    { type: 'buy', symbol: 'AAPL', shares: 5, price: 100, total: 500, createdAt: '2026-04-02T10:00:00Z' },
    { type: 'sell', symbol: 'AAPL', shares: 2, price: 120, total: 240, createdAt: '2026-04-03T10:00:00Z' },
    { type: 'withdrawal', total: 100, createdAt: '2026-04-04T10:00:00Z' },
  ];

  it('should compute a ledger-based reconciliation snapshot', () => {
    const snapshot = computeReconciliationSnapshot({ transactions });

    expect(snapshot.cash_balance).toBe(640);
    expect(snapshot.total_deposited).toBe(1000);
    expect(snapshot.total_withdrawn).toBe(100);
    expect(snapshot.realized_pnl).toBe(40);
    expect(snapshot.holdings).toEqual([
      expect.objectContaining({
        symbol: 'AAPL',
        shares: 3,
        average_price: 100,
      }),
    ]);
  });

  it('should detect portfolio mismatches from the transaction ledger', () => {
    const summary = buildReconciliationSummary({
      portfolio: {
        cash_balance: 600,
        total_deposited: 1000,
        total_withdrawn: 0,
        performance: { realized_pnl: 0 },
      },
      holdings: [
        { symbol: 'AAPL', shares: 4, average_price: 100 },
      ],
      transactions,
    });

    expect(summary.is_consistent).toBe(false);
    expect(summary.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'cash_balance' }),
        expect.objectContaining({ field: 'total_withdrawn' }),
        expect.objectContaining({ field: 'holdings.AAPL.shares' }),
      ])
    );
  });
});
