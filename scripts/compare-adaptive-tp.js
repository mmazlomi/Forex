#!/usr/bin/env node
'use strict';

// Stage H reporting CLI for the Adaptive Take-Profit engine — prints a fixed-vs-adaptive
// walk-forward comparison table. Never imported by server.js or any scheduler; run manually:
//
//   node scripts/compare-adaptive-tp.js --engine spot --symbol BTC/USDT --exchange kucoin \
//     --start 2026-01-01 --end 2026-06-01 --windows 4
//
//   node scripts/compare-adaptive-tp.js --engine reversal --symbol BTC/USDT:USDT \
//     --exchange kucoin --market futures --start 2026-01-01 --end 2026-06-01

const { compareFixedVsAdaptive } = require('../src/services/backtesting/adaptive-tp-comparison');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function fmtPercent(n) {
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : 'n/a';
}
function fmtNum(n, digits = 2) {
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

function printRow(label, metrics) {
  console.log(
    `${label.padEnd(10)} trades=${String(metrics.tradeCount).padEnd(6)} ` +
    `winRate=${fmtPercent(metrics.winRatePercent).padEnd(9)} ` +
    `PF=${fmtNum(metrics.profitFactor).padEnd(7)} ` +
    `expectancy=${fmtNum(metrics.expectancy).padEnd(9)} ` +
    `maxDD=${fmtPercent(metrics.maxDrawdownPercent).padEnd(9)} ` +
    `sharpe=${fmtNum(metrics.sharpeRatio).padEnd(7)} ` +
    `netPnL=${fmtPercent(metrics.totalPnlPercent)}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.symbol || !args.exchange || !args.start || !args.end) {
    console.error('Usage: node scripts/compare-adaptive-tp.js --engine spot|reversal --symbol <SYM> --exchange <EX> --start <ISO> --end <ISO> [--market spot|futures] [--windows 4] [--timeframe 1h]');
    process.exitCode = 1;
    return;
  }

  const result = await compareFixedVsAdaptive({
    engine: args.engine || 'spot',
    symbol: args.symbol,
    exchange: args.exchange,
    market: args.market || 'spot',
    timeframe: args.timeframe || '1h',
    startUtc: new Date(args.start).toISOString(),
    endUtc: new Date(args.end).toISOString(),
    windowCount: args.windows ? parseInt(args.windows, 10) : 4,
  });

  console.log(`\nFixed vs Adaptive Take-Profit — ${result.engine} engine, ${result.symbol}@${result.exchange} (${result.market}), ${result.startUtc} -> ${result.endUtc}, ${result.windowCount} walk-forward windows\n`);
  printRow('Fixed', result.fixed.compositeMetrics);
  printRow('Adaptive', result.adaptive.compositeMetrics);
  console.log('');
  for (const r of result.ranked) {
    console.log(`  ${r.label}: compositeScore=${Number.isFinite(r.compositeScore) ? r.compositeScore.toFixed(4) : '-Infinity'}${r.disqualifiedReason ? ` (DISQUALIFIED: ${r.disqualifiedReason})` : ''}`);
  }
  console.log(`\nWinner: ${result.winner || 'inconclusive — see disqualification reasons above'}\n`);
  console.log('Note: every window uses the SAME fixed parameters (no per-window re-optimization) for BOTH runs — this measures consistency across time, not best-case performance.');
}

main().catch((err) => {
  console.error(`compare-adaptive-tp failed: ${err.message}`);
  process.exitCode = 1;
});
