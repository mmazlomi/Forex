'use strict';

const { getDb } = require('../connection');

const SCOPES = ['global', 'demo', 'real'];

function getGlobalState() {
  const db = getDb();
  const row = db.prepare('SELECT * FROM emergency_stop_global WHERE id = 1').get();
  if (row) return { scope: 'global', ...row };
  return { scope: 'global', active: 0, reason: null, activated_at_utc: null, reset_at_utc: null };
}

function getUserState(scope, userId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM emergency_stop_user WHERE user_id = ? AND scope = ?').get(userId, scope);
  if (row) return row;
  return { user_id: userId, scope, active: 0, reason: null, activated_at_utc: null, reset_at_utc: null };
}

/**
 * `global` is a genuine instance-wide admin panic button (any logged-in user may trigger/reset
 * it — this app has no admin/role system) that halts trading for every account regardless of
 * their own per-user state. `demo`/`real` check the global override first, then that user's own
 * scoped stop — matches the original single-table semantics, just split across two tables.
 */
function isActive(scope, userId) {
  const globalActive = !!getGlobalState().active;
  if (scope === 'global') return globalActive;
  if (globalActive) return true;
  return !!getUserState(scope, userId).active;
}

function setActive(scope, userId, active, reason) {
  const db = getDb();
  const nowUtc = new Date().toISOString();

  if (scope === 'global') {
    const existing = getGlobalState();
    db.prepare(
      `INSERT INTO emergency_stop_global (id, active, reason, activated_at_utc, reset_at_utc)
       VALUES (1, @active, @reason, @activatedAtUtc, @resetAtUtc)
       ON CONFLICT(id) DO UPDATE SET
         active = excluded.active, reason = excluded.reason,
         activated_at_utc = excluded.activated_at_utc, reset_at_utc = excluded.reset_at_utc`
    ).run({
      active: active ? 1 : 0,
      reason: reason || null,
      activatedAtUtc: active ? nowUtc : existing.activated_at_utc,
      resetAtUtc: active ? null : nowUtc,
    });
    return getGlobalState();
  }

  const existing = getUserState(scope, userId);
  db.prepare(
    `INSERT INTO emergency_stop_user (user_id, scope, active, reason, activated_at_utc, reset_at_utc)
     VALUES (@userId, @scope, @active, @reason, @activatedAtUtc, @resetAtUtc)
     ON CONFLICT(user_id, scope) DO UPDATE SET
       active = excluded.active, reason = excluded.reason,
       activated_at_utc = excluded.activated_at_utc, reset_at_utc = excluded.reset_at_utc`
  ).run({
    userId,
    scope,
    active: active ? 1 : 0,
    reason: reason || null,
    activatedAtUtc: active ? nowUtc : existing.activated_at_utc,
    resetAtUtc: active ? null : nowUtc,
  });
  return getUserState(scope, userId);
}

module.exports = { getGlobalState, getUserState, isActive, setActive, SCOPES };
