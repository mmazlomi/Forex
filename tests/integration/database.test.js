'use strict';

process.env.DATABASE_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, resetForTests } = require('../../src/database/connection');
const assetsRepository = require('../../src/database/repositories/assets-repository');
const futuresAssetsRepository = require('../../src/database/repositories/futures-assets-repository');
const signalsRepository = require('../../src/database/repositories/signals-repository');
const riskSettingsRepository = require('../../src/database/repositories/risk-settings-repository');
const emergencyStopRepository = require('../../src/database/repositories/emergency-stop-repository');
const usersRepository = require('../../src/database/repositories/users-repository');

test.beforeEach(() => {
  resetForTests();
});

test('schema creates all expected tables', () => {
  const db = getDb();
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const names = rows.map((r) => r.name).sort();
  for (const expected of [
    'users', 'sessions', 'assets', 'candles', 'fundamentals_cache', 'signals', 'risk_settings',
    'emergency_stop_global', 'emergency_stop_user',
    'demo_portfolio', 'demo_positions', 'demo_orders', 'real_portfolio', 'real_positions',
    'real_orders', 'real_audit_log', 'backtest_runs', 'backtest_trades', 'backtest_equity_curve', 'logs',
  ]) {
    assert.ok(names.includes(expected), `missing table: ${expected}`);
  }
});

test('assets repository round-trips a record via parameterized queries', () => {
  const user = usersRepository.createUser('alice', 'irrelevant-hash');
  assetsRepository.addAsset(user.id, { symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', assetType: 'crypto', defaultTimeframe: '1h' });
  const found = assetsRepository.getAsset(user.id, 'BTC/USDT', 'kucoin');
  assert.equal(found.symbol, 'BTC/USDT');

  const list = assetsRepository.listAssets(user.id);
  assert.equal(list.length, 1);

  const removed = assetsRepository.removeAsset(user.id, 'BTC/USDT', 'kucoin');
  assert.equal(removed, true);
  assert.equal(assetsRepository.listAssets(user.id).length, 0);
});

test('setTimeframe updates default_timeframe in place and is visible via getAsset (affects AI Auto-Trade, not just display)', () => {
  const user = usersRepository.createUser('timeframe-test-user', 'irrelevant-hash');
  assetsRepository.addAsset(user.id, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto', defaultTimeframe: '1h' });

  const updated = assetsRepository.setTimeframe(user.id, 'BTC/USDT', 'kucoin', '4h');
  assert.equal(updated.default_timeframe, '4h');
  assert.equal(assetsRepository.getAsset(user.id, 'BTC/USDT', 'kucoin').default_timeframe, '4h');

  // No matching asset -> null, not a throw (mirrors setStrategy/setAutoTrade's contract).
  assert.equal(assetsRepository.setTimeframe(user.id, 'ETH/USDT', 'kucoin', '1d'), null);
});

test('setStrategyMode/setSelectedStrategies/listAutoStrategyModeAssets (spot): defaults to manual, opts into auto, and only auto-mode assets are listed', () => {
  const user = usersRepository.createUser('strategy-mode-test-user', 'irrelevant-hash');
  assetsRepository.addAsset(user.id, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.addAsset(user.id, { symbol: 'ETH/USDT', exchange: 'kucoin', assetType: 'crypto' }); // stays manual

  assert.equal(assetsRepository.getAsset(user.id, 'BTC/USDT', 'kucoin').strategy_mode, 'manual');

  const afterMode = assetsRepository.setStrategyMode(user.id, 'BTC/USDT', 'kucoin', 'auto');
  assert.equal(afterMode.strategy_mode, 'auto');
  assert.equal(afterMode.selected_strategy_ids_json, null, 'switching to auto does not itself populate a selection');

  const afterSelection = assetsRepository.setSelectedStrategies(user.id, 'BTC/USDT', 'kucoin', ['trend-following', 'momentum']);
  assert.deepEqual(JSON.parse(afterSelection.selected_strategy_ids_json), ['trend-following', 'momentum']);
  assert.ok(afterSelection.strategy_selection_updated_at_utc);

  const autoModeAssets = assetsRepository.listAutoStrategyModeAssets();
  assert.equal(autoModeAssets.length, 1);
  assert.equal(autoModeAssets[0].symbol, 'BTC/USDT');

  // Switching back to manual doesn't clear the prior selection — it's just ignored while manual.
  assetsRepository.setStrategyMode(user.id, 'BTC/USDT', 'kucoin', 'manual');
  const backToManual = assetsRepository.getAsset(user.id, 'BTC/USDT', 'kucoin');
  assert.equal(backToManual.strategy_mode, 'manual');
  assert.deepEqual(JSON.parse(backToManual.selected_strategy_ids_json), ['trend-following', 'momentum']);
  assert.equal(assetsRepository.listAutoStrategyModeAssets().length, 0);
});

test('setStrategyMode/setSelectedStrategies/listAutoStrategyModeAssets (futures): demo and real opt in independently', () => {
  const user = usersRepository.createUser('futures-strategy-mode-test-user', 'irrelevant-hash');
  futuresAssetsRepository.addAsset('demo', user.id, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin' });
  futuresAssetsRepository.addAsset('real', user.id, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin' });

  futuresAssetsRepository.setStrategyMode('demo', user.id, 'BTC/USDT:USDT', 'kucoin', 'auto');
  futuresAssetsRepository.setSelectedStrategies('demo', user.id, 'BTC/USDT:USDT', 'kucoin', ['balanced', 'mean-reversion', 'momentum']);

  const demoAsset = futuresAssetsRepository.getAsset('demo', user.id, 'BTC/USDT:USDT', 'kucoin');
  assert.deepEqual(JSON.parse(demoAsset.selected_strategy_ids_json), ['balanced', 'mean-reversion', 'momentum']);

  const realAsset = futuresAssetsRepository.getAsset('real', user.id, 'BTC/USDT:USDT', 'kucoin');
  assert.equal(realAsset.strategy_mode, 'manual', 'the same symbol on the real watchlist is a fully independent row, untouched by the demo change');
  assert.equal(realAsset.selected_strategy_ids_json, null);

  assert.equal(futuresAssetsRepository.listAutoStrategyModeAssets('demo').length, 1);
  assert.equal(futuresAssetsRepository.listAutoStrategyModeAssets('real').length, 0);
});

test('two different users can each watch the same symbol/exchange independently', () => {
  const alice = usersRepository.createUser('alice2', 'irrelevant-hash');
  const bob = usersRepository.createUser('bob2', 'irrelevant-hash');
  assetsRepository.addAsset(alice.id, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.addAsset(bob.id, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });

  assert.equal(assetsRepository.listAssets(alice.id).length, 1);
  assert.equal(assetsRepository.listAssets(bob.id).length, 1);
  // Removing bob's copy must not affect alice's.
  assetsRepository.removeAsset(bob.id, 'BTC/USDT', 'kucoin');
  assert.equal(assetsRepository.listAssets(alice.id).length, 1);
  assert.equal(assetsRepository.listAssets(bob.id).length, 0);
});

test('a symbol containing SQL metacharacters is stored and retrieved verbatim, not executed', () => {
  const user = usersRepository.createUser('carol', 'irrelevant-hash');
  const malicious = "BTC'; DROP TABLE assets; --/USDT";
  assetsRepository.addAsset(user.id, { symbol: malicious, exchange: 'kucoin', assetType: 'crypto' });
  const found = assetsRepository.getAsset(user.id, malicious, 'kucoin');
  assert.equal(found.symbol, malicious);
  // Table must still exist and be queryable — proves the string was bound as data, not SQL.
  assert.equal(assetsRepository.listAssets(user.id).length, 1);
});

test('signals table enforces the BUY/SELL/HOLD/NO_DATA status constraint', () => {
  assert.throws(() => {
    signalsRepository.insertSignal({
      id: 'x', symbol: 'BTC/USDT', exchange: 'kucoin', timeframe: '1h', tsUtc: new Date().toISOString(),
      price: 100, technicalScore: 0, fundamentalScore: 0, finalScore: 0, status: 'MAYBE', confidence: 0,
      reasonsJson: '[]', technicalSummaryJson: '{}', fundamentalSummaryJson: '{}', entry: null, stopLoss: null,
      takeProfit: null, riskRewardRatio: null, dataQuality: 'good', warningsJson: '[]', strategyVersion: '1.0.0',
      sourceMode: 'demo',
    });
  });
});

test('risk settings ensureDefaults seeds once and upsert updates in place', () => {
  const user = usersRepository.createUser('risk-settings-test-user', 'irrelevant-hash');
  const defaults = {
    maxRiskPerTradePercent: 1, maxDailyLossPercent: 3, maxOpenPositions: 5,
    maxOrderValue: 1000, minRiskRewardRatio: 1.5, maxPortfolioExposurePercent: 50,
  };
  const first = riskSettingsRepository.ensureDefaults(user.id, 'demo', defaults);
  assert.equal(first.max_risk_per_trade_percent, 1);

  riskSettingsRepository.upsertRiskSettings(user.id, 'demo', { ...defaults, maxRiskPerTradePercent: 2 });
  const updated = riskSettingsRepository.getRiskSettings(user.id, 'demo');
  assert.equal(updated.max_risk_per_trade_percent, 2);
});

test('risk settings are independent per user', () => {
  const alice = usersRepository.createUser('risk-settings-alice', 'irrelevant-hash');
  const bob = usersRepository.createUser('risk-settings-bob', 'irrelevant-hash');
  const defaults = {
    maxRiskPerTradePercent: 1, maxDailyLossPercent: 3, maxOpenPositions: 5,
    maxOrderValue: 1000, minRiskRewardRatio: 1.5, maxPortfolioExposurePercent: 50,
  };
  riskSettingsRepository.ensureDefaults(alice.id, 'demo', defaults);
  riskSettingsRepository.upsertRiskSettings(bob.id, 'demo', { ...defaults, maxRiskPerTradePercent: 9 });
  assert.equal(riskSettingsRepository.getRiskSettings(alice.id, 'demo').max_risk_per_trade_percent, 1);
  assert.equal(riskSettingsRepository.getRiskSettings(bob.id, 'demo').max_risk_per_trade_percent, 9);
});

test('emergency stop scopes (global/demo/real) are tracked independently, per user, with global overriding everyone', () => {
  const alice = usersRepository.createUser('emergency-stop-alice', 'irrelevant-hash');
  const bob = usersRepository.createUser('emergency-stop-bob', 'irrelevant-hash');

  assert.equal(emergencyStopRepository.isActive('demo', alice.id), false);
  emergencyStopRepository.setActive('demo', alice.id, true, 'test');
  assert.equal(emergencyStopRepository.isActive('demo', alice.id), true);
  assert.equal(emergencyStopRepository.isActive('real', alice.id), false);
  // Bob's own demo/real stops are untouched by Alice's.
  assert.equal(emergencyStopRepository.isActive('demo', bob.id), false);

  emergencyStopRepository.setActive('global', alice.id, true, 'kill switch');
  // Global overrides every scope, for every user — not just whoever triggered it.
  assert.equal(emergencyStopRepository.isActive('real', alice.id), true);
  assert.equal(emergencyStopRepository.isActive('demo', bob.id), true);
  assert.equal(emergencyStopRepository.isActive('real', bob.id), true);
});
