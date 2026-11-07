import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireTickLock, releaseTickLock, renewTickLock } from './engine.js';

function lockDb({ changes = 1 } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return { bind(...args) {
        return { async run() { calls.push({ sql, args }); return { meta: { changes } }; } };
      } };
    },
  };
}

test('tick lock acquisition returns a lease and uses an expiry guard', async () => {
  const db = lockDb();
  const lease = await acquireTickLock(db);
  assert.ok(lease.token);
  assert.match(db.calls[0].sql, /ON CONFLICT\(key\).*WHERE state\.ts < \?/s);
});

test('a delayed owner cannot release a newer lease', async () => {
  const db = lockDb({ changes: 0 });
  await releaseTickLock(db, { token: 'old', expiresAt: 1 });
  assert.match(db.calls[0].sql, /WHERE key = 'tick_lock' AND value = \?/);
  assert.equal(db.calls[0].args[0], JSON.stringify({ token: 'old', expiresAt: 1 }));
});

test('renewal fails when the lease token no longer matches', async () => {
  const db = lockDb({ changes: 0 });
  assert.equal(await renewTickLock(db, { token: 'old', expiresAt: 1 }), false);
});
