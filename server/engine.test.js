import test from 'node:test';
import assert from 'node:assert/strict';
import { expireQueue, queueOutcome } from './engine.js';

function fakeDb({ changed = 0 } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              calls.push({ sql, args });
              return { meta: { changes: changed } };
            },
          };
        },
      };
    },
  };
}

test('failed submission remains retryable while blocked submission stops the drain', () => {
  assert.deepEqual(queueOutcome('queued'), {
    status: 'pending', retryable: true, globalBlocked: false,
  });
  assert.deepEqual(queueOutcome('blocked'), {
    status: 'pending', retryable: false, globalBlocked: true,
  });
});

test('confirmed and rejected outcomes close queue rows', () => {
  assert.deepEqual(queueOutcome('sent'), {
    status: 'sent', retryable: false, globalBlocked: false,
  });
  assert.deepEqual(queueOutcome('rejected'), {
    status: 'skipped', retryable: false, globalBlocked: false,
  });
});

test('old pending transactions expire and are not eligible for retry', async () => {
  const db = fakeDb({ changed: 2 });
  const count = await expireQueue(db, { maxQueueAgeS: 900 });
  assert.equal(count, 2);
  assert.match(db.calls[0].sql, /UPDATE queue SET status = 'expired'/);
  assert.match(db.calls[0].args[0], /expired: not sent within 900s/);
});

test('queue recovery reports no work when no rows expire', async () => {
  const db = fakeDb({ changed: 0 });
  assert.equal(await expireQueue(db, { maxQueueAgeS: 60 }), 0);
  assert.equal(db.calls.length, 1);
});

test('trade-step failures do not create a second outcome category', () => {
  const steps = ['approve failed', 'swap timeout', 'reset failed'];
  const outcomes = steps.map(() => queueOutcome('queued'));
  assert.equal(new Set(outcomes.map((item) => item.status)).size, 1);
  assert.ok(outcomes.every((item) => item.retryable));
});
