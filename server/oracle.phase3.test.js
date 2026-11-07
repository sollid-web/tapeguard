import test from 'node:test';
import assert from 'node:assert/strict';
import { currentPrices } from './oracle.js';

function dbWithRows(rows) {
  return {
    prepare() {
      return {
        bind(asset) {
          return { async first() { return rows[asset] || null; } };
        },
      };
    },
    batch() { return Promise.resolve(); },
  };
}

test('oracle fails closed when the independent secondary feed is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  try {
    const now = Math.floor(Date.now() / 1000);
    await assert.rejects(
      currentPrices({}, dbWithRows({
        okb: { asset: 'okb', usd: 42, ts: now, source: 'cache' },
        usdt: { asset: 'usdt', usd: 1, ts: now, source: 'cache' },
      })),
      /required secondary price feed unavailable/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('oracle does not trade on cache values older than the execution freshness window', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 504 });
  try {
    const now = Math.floor(Date.now() / 1000);
    const prices = await currentPrices({}, dbWithRows({
      okb: { asset: 'okb', usd: 42, ts: now - 61, source: 'cache' },
      usdt: { asset: 'usdt', usd: 1, ts: now - 61, source: 'cache' },
    }));
    assert.equal(prices, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
