import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireTickLock,
  constantProductCurveImpact,
  inputReserveForPath,
  releaseTickLock,
  renewTickLock,
} from './engine.js';

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

test('fee-excluded curve impact is directionally and decimal-scale invariant', () => {
  const stable = '0x0000000000000000000000000000000000000001';
  const wrapped = '0x0000000000000000000000000000000000000002';
  const pool = {
    token0: stable,
    reserve0: 100_000_000n,
    reserve1: 100n * 10n ** 18n,
  };
  const buyReserve = inputReserveForPath([stable, wrapped], pool);
  const sellReserve = inputReserveForPath([wrapped, stable], pool);
  assert.throws(() => inputReserveForPath(['0x0000000000000000000000000000000000000003', wrapped], pool), /do not match/);
  const buyWithSixDecimalInput = constantProductCurveImpact(1_000_000n, buyReserve, 150);
  const sellWithEighteenDecimalInput = constantProductCurveImpact(10n ** 18n, sellReserve, 150);
  assert.equal(buyWithSixDecimalInput.impactBps, 100);
  assert.equal(sellWithEighteenDecimalInput.impactBps, buyWithSixDecimalInput.impactBps);
  assert.equal(buyWithSixDecimalInput.exceedsLimit, false);
});

test('fee-excluded curve impact scales with trade size and enforces the threshold', () => {
  const smallTrade = constantProductCurveImpact(1_000_000n, 1_000_000_000n, 150);
  const largeTrade = constantProductCurveImpact(25_000_000n, 100_000_000n, 150);
  const atLimit = constantProductCurveImpact(1n, 99n, 100);
  const overLimit = constantProductCurveImpact(1n, 98n, 100);

  assert.equal(smallTrade.impactBps, 10);
  assert.equal(smallTrade.exceedsLimit, false);
  assert.equal(largeTrade.impactBps, 2000);
  assert.equal(largeTrade.exceedsLimit, true);
  assert.equal(atLimit.impactBps, 100);
  assert.equal(atLimit.exceedsLimit, false);
  assert.equal(overLimit.impactBps, 102);
  assert.equal(overLimit.exceedsLimit, true);
});
