'use strict';

process.env.DATABASE_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, resetForTests } = require('../../src/database/connection');
const assetsRepository = require('../../src/database/repositories/assets-repository');
const futuresAssetsRepository = require('../../src/database/repositories/futures-assets-repository');
const usersRepository = require('../../src/database/repositories/users-repository');

test.beforeEach(() => {
  resetForTests();
});

test('autopilot_enabled and timeframe_mode columns exist in assets, demo_futures_assets, and real_futures_assets tables', () => {
  const db = getDb();
  for (const table of ['assets', 'demo_futures_assets', 'real_futures_assets']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const colNames = cols.map((c) => c.name);
    assert.ok(colNames.includes('autopilot_enabled'), `missing autopilot_enabled in ${table}`);
    assert.ok(colNames.includes('timeframe_mode'), `missing timeframe_mode in ${table}`);
  }
});

test('assetsRepository.setAutopilot enables autopilot and cascades optimal settings including timeframe_mode', () => {
  const user = usersRepository.createUser('pilot-user', 'hash');
  assetsRepository.addAsset(user.id, {
    symbol: 'BTC/USDT',
    exchange: 'kucoin',
    market: 'spot',
    assetType: 'crypto',
  });

  const initial = assetsRepository.getAsset(user.id, 'BTC/USDT', 'kucoin');
  assert.equal(initial.autopilot_enabled, 0);
  assert.equal(initial.strategy_mode, 'manual');
  assert.equal(initial.timeframe_mode, 'manual');
  assert.equal(initial.auto_trade_enabled, 0);

  // Enable AutoPilot
  const enabledAsset = assetsRepository.setAutopilot(user.id, 'BTC/USDT', 'kucoin', true);
  assert.ok(enabledAsset);
  assert.equal(enabledAsset.autopilot_enabled, 1);
  assert.equal(enabledAsset.strategy_mode, 'auto');
  assert.equal(enabledAsset.timeframe_mode, 'auto');
  assert.equal(enabledAsset.trailing_mode, 'atr');
  assert.equal(enabledAsset.trailing_percent, null);
  assert.equal(enabledAsset.adaptive_tp_enabled, 1);
  assert.equal(enabledAsset.auto_trade_enabled, 1);

  // Disable AutoPilot
  const disabledAsset = assetsRepository.setAutopilot(user.id, 'BTC/USDT', 'kucoin', false);
  assert.ok(disabledAsset);
  assert.equal(disabledAsset.autopilot_enabled, 0);
  // Prior automated settings remain preserved
  assert.equal(disabledAsset.strategy_mode, 'auto');
  assert.equal(disabledAsset.timeframe_mode, 'auto');
  assert.equal(disabledAsset.trailing_mode, 'atr');
  assert.equal(disabledAsset.adaptive_tp_enabled, 1);
  assert.equal(disabledAsset.auto_trade_enabled, 1);
});

test('futuresAssetsRepository.setAutopilot enables autopilot and cascades settings for demo and real futures', () => {
  const user = usersRepository.createUser('futures-pilot-user', 'hash');

  for (const mode of ['demo', 'real']) {
    futuresAssetsRepository.addAsset(mode, user.id, {
      symbol: 'ETH/USDT:USDT',
      exchange: 'binance',
      leverage: 5,
    });

    const initial = futuresAssetsRepository.getAsset(mode, user.id, 'ETH/USDT:USDT', 'binance');
    assert.equal(initial.autopilot_enabled, 0);
    assert.equal(initial.timeframe_mode, 'manual');

    const active = futuresAssetsRepository.setAutopilot(mode, user.id, 'ETH/USDT:USDT', 'binance', true);
    assert.ok(active);
    assert.equal(active.autopilot_enabled, 1);
    assert.equal(active.strategy_mode, 'auto');
    assert.equal(active.timeframe_mode, 'auto');
    assert.equal(active.trailing_mode, 'atr');
    assert.equal(active.trailing_percent, null);
    assert.equal(active.adaptive_tp_enabled, 1);
    assert.equal(active.auto_trade_enabled, 1);

    const off = futuresAssetsRepository.setAutopilot(mode, user.id, 'ETH/USDT:USDT', 'binance', false);
    assert.ok(off);
    assert.equal(off.autopilot_enabled, 0);
    assert.equal(off.timeframe_mode, 'auto');
  }
});
