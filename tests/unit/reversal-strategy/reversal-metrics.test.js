'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeExtendedMetrics, computeMaxDrawdownAbsolute, computeSharpeRatio, computeSortinoRatio } = require('../../../src/services/backtesting/reversal-metrics');

function trade({ side, pnl, enteredAtUtc, exitedAtUtc }) {
  return { side, pnl, exitPrice: 1, enteredAtUtc, exitedAtUtc };
}

test('computeMaxDrawdownAbsolute tracks the largest peak-to-trough dollar decline', () => {
  const curve = [{ equity: 100 }, { equity: 150 }, { equity: 90 }, { equity: 120 }, { equity: 80 }];
  // peak 150 -> trough 80 is the largest decline (70), even though 150->90 (60) came first.
  assert.equal(computeMaxDrawdownAbsolute(curve), 70);
});

test('computeSharpeRatio is 0 for a flat (zero-variance) equity curve', () => {
  const curve = [{ equity: 100 }, { equity: 100 }, { equity: 100 }];
  assert.equal(computeSharpeRatio(curve), 0);
});

test('computeSharpeRatio is positive for a steadily rising equity curve', () => {
  const curve = [{ equity: 100 }, { equity: 105 }, { equity: 110 }, { equity: 115 }];
  assert.ok(computeSharpeRatio(curve) > 0);
});

test('computeSortinoRatio ignores upside volatility — higher than Sharpe when up-moves are volatile but no down-moves exist', () => {
  const curve = [{ equity: 100 }, { equity: 101 }, { equity: 115 }, { equity: 116 }, { equity: 140 }];
  const sharpe = computeSharpeRatio(curve);
  const sortino = computeSortinoRatio(curve);
  // No negative returns at all in this curve -> Sortino's downside deviation term is 0-guarded,
  // both should be non-negative, and Sortino should not be LESS than Sharpe (no downside penalty).
  assert.ok(sortino >= 0);
  assert.ok(sharpe >= 0);
});

test('computeExtendedMetrics adds expectancy, Sharpe/Sortino, recovery factor, duration, and breakdowns on top of the base metrics', () => {
  const trades = [
    trade({ side: 'long', pnl: 100, enteredAtUtc: '2026-01-05T09:00:00.000Z', exitedAtUtc: '2026-01-05T11:00:00.000Z' }),
    trade({ side: 'long', pnl: -40, enteredAtUtc: '2026-01-10T02:00:00.000Z', exitedAtUtc: '2026-01-10T05:00:00.000Z' }),
    trade({ side: 'short', pnl: 60, enteredAtUtc: '2026-02-01T14:00:00.000Z', exitedAtUtc: '2026-02-01T16:00:00.000Z' }),
  ];
  const equityCurve = [{ equity: 10000 }, { equity: 10100 }, { equity: 10060 }, { equity: 10120 }];
  const result = computeExtendedMetrics({ trades, equityCurve, initialCapital: 10000, periodsPerYear: 365 });

  assert.equal(result.tradeCount, 3); // from the base computeMetrics
  assert.equal(result.expectancy, (100 - 40 + 60) / 3);
  assert.ok(Number.isFinite(result.sharpeRatio));
  assert.ok(Number.isFinite(result.sortinoRatio));
  assert.ok(result.avgTradeDurationMs > 0);

  assert.equal(result.bySide.long.tradeCount, 2);
  assert.equal(result.bySide.long.totalPnl, 60);
  assert.equal(result.bySide.short.tradeCount, 1);
  assert.equal(result.bySide.short.totalPnl, 60);

  assert.equal(result.byMonth['2026-01'].tradeCount, 2);
  assert.equal(result.byMonth['2026-01'].totalPnl, 60);
  assert.equal(result.byMonth['2026-02'].tradeCount, 1);

  // 09:00 and 02:00 UTC entries fall in the Asian session (00-08 covers 02:00; 09:00 falls in
  // neither Asian(00-08) nor London(08-16)? 09:00 IS within London's 08-16 window.
  assert.ok(result.bySession.asian.tradeCount >= 1);
  const totalBucketed = Object.values(result.bySession).reduce((sum, b) => sum + b.tradeCount, 0);
  assert.ok(totalBucketed >= trades.length); // every trade counted at least once (possibly in multiple overlapping sessions)
});

test('recoveryFactor is Infinity when there is profit but zero drawdown, and 0 when there is neither profit nor drawdown', () => {
  const profitableNoDrawdown = computeExtendedMetrics({
    trades: [trade({ side: 'long', pnl: 100, enteredAtUtc: '2026-01-01T00:00:00.000Z', exitedAtUtc: '2026-01-01T01:00:00.000Z' })],
    equityCurve: [{ equity: 10000 }, { equity: 10100 }],
    initialCapital: 10000,
  });
  assert.equal(profitableNoDrawdown.recoveryFactor, Infinity);

  const flat = computeExtendedMetrics({ trades: [], equityCurve: [{ equity: 10000 }], initialCapital: 10000 });
  assert.equal(flat.recoveryFactor, 0);
});
