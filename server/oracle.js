// Price oracle for the daemon. The agent has to value the portfolio (OKB and the
// stable leg) to know when it is off balance, so it needs a price feed that works
// without a key. Three sources, in order:
//   1. a manual price the owner posted   (works offline / during a demo)
//   2. PRICE_URL, a secret URL returning { "okb": 42.5, "usdt": 1 }
//   3. a keyless public feed (cached in D1 so the daemon stays under its limits)
// Whatever happens, the last known value is kept and reused instead of guessing.

const CACHE_SECONDS = 45;
const MANUAL_TTL_SECONDS = 3600;
const PUBLIC_FEED = 'https://api.coingecko.com/api/v3/simple/price?ids=okb,tether&vs_currencies=usd&precision=4';
// Second, independent source. X Layer is OKX's chain, so OKX is the natural
// cross-check. No key, no signature - but two unrelated origins that agree are far
// harder to spoof than one, and the daemon refuses to trade when they disagree.
const SECONDARY_FEED = 'https://www.okx.com/api/v5/market/ticker?instId=OKB-USDT';
const MAX_DEVIATION_BPS = 200;

async function fetchSecondary () {
  try {
    const response = await fetch(SECONDARY_FEED, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const value = Number(body?.data?.[0]?.last);
    if (!Number.isFinite(value) || value <= 0) return null;
    return { okb: value, source: 'okx' };
  } catch {
    return null;
  }
}

/** Marks the price unusable when the two sources disagree beyond tolerance. */
async function crossChecked (prices) {
  const secondary = await fetchSecondary();
  if (!secondary) {
    return { ...prices, secondary: null, disagree: false, deviationBps: 0, check: 'single source: cross-check feed unavailable' };
  }
  const diff = prices.okb > secondary.okb ? prices.okb - secondary.okb : secondary.okb - prices.okb;
  const deviationBps = Math.round((diff / secondary.okb) * 10000);
  const disagree = deviationBps > MAX_DEVIATION_BPS;
  return {
    ...prices,
    secondary: secondary.okb,
    disagree,
    deviationBps,
    check: disagree
      ? `feeds disagree by ${deviationBps} bps (max ${MAX_DEVIATION_BPS}) - trading refused`
      : `cross-checked against okx (${deviationBps} bps apart)`,
  };
}

export async function storedPrice (db, asset) {
  const row = await db.prepare('SELECT asset, usd, ts, source FROM prices WHERE asset = ?').bind(asset).first();
  if (!row) return null;
  return { usd: Number(row.usd), ts: Number(row.ts), source: String(row.source) };
}

export async function setManualPrice (db, asset, usd) {
  const value = Number(usd);
  if (!Number.isFinite(value) || value <= 0) throw new Error('invalid price for ' + asset);
  await db
    .prepare('INSERT INTO prices (asset, usd, ts, source) VALUES (?, ?, ?, ?) ON CONFLICT(asset) DO UPDATE SET usd = excluded.usd, ts = excluded.ts, source = excluded.source')
    .bind(asset, value, Math.floor(Date.now() / 1000), 'manual')
    .run();
  return value;
}

async function storePrice (db, asset, usd, source) {
  await db
    .prepare('INSERT INTO prices (asset, usd, ts, source) VALUES (?, ?, ?, ?) ON CONFLICT(asset) DO UPDATE SET usd = excluded.usd, ts = excluded.ts, source = excluded.source')
    .bind(asset, usd, Math.floor(Date.now() / 1000), source)
    .run();
}

function pickNumber (source, keys) {
  for (const key of keys) {
    const value = source ? source[key] : undefined;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) && Number(value) > 0) return Number(value);
    if (value && typeof value === 'object' && typeof value.usd === 'number' && value.usd > 0) return value.usd;
  }
  return null;
}

async function fetchFeed (env) {
  const url = typeof env.PRICE_URL === 'string' && env.PRICE_URL.startsWith('http') ? env.PRICE_URL : PUBLIC_FEED;
  const source = url === PUBLIC_FEED ? 'public' : 'custom';
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error('price feed http ' + response.status);
  const body = await response.json();
  const okb = pickNumber(body, ['okb', 'okbUsd', 'okb_usd', 'OKB']);
  const usdt = pickNumber(body, ['usdt', 'usdtUsd', 'usdt_usd', 'USDT', 'tether']);
  if (!okb) throw new Error('price feed did not contain an OKB price');
  return { okb, usdt: usdt || 1, source };
}

/** @returns {{okb:number, usdt:number, source:string, ts:number, stale:boolean}|null} */
export async function currentPrices (env, db) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cached = await storedPrice(db, 'okb');
  const cachedUsdt = await storedPrice(db, 'usdt');

  // 1. a recent manual price wins: the owner asked for it explicitly.
  if (cached && cached.source === 'manual' && nowSeconds - cached.ts < MANUAL_TTL_SECONDS) {
    return crossChecked({ okb: cached.usd, usdt: cachedUsdt ? cachedUsdt.usd : 1, source: 'manual', ts: cached.ts, stale: false });
  }
  // 2. a fresh cached value.
  if (cached && nowSeconds - cached.ts < CACHE_SECONDS) {
    return crossChecked({ okb: cached.usd, usdt: cachedUsdt ? cachedUsdt.usd : 1, source: cached.source, ts: cached.ts, stale: false });
  }
  // 3. ask the feed.
  try {
    const fresh = await fetchFeed(env);
    await db.batch([
      db.prepare('INSERT INTO prices (asset, usd, ts, source) VALUES (?, ?, ?, ?) ON CONFLICT(asset) DO UPDATE SET usd = excluded.usd, ts = excluded.ts, source = excluded.source').bind('okb', fresh.okb, nowSeconds, fresh.source),
      db.prepare('INSERT INTO prices (asset, usd, ts, source) VALUES (?, ?, ?, ?) ON CONFLICT(asset) DO UPDATE SET usd = excluded.usd, ts = excluded.ts, source = excluded.source').bind('usdt', fresh.usdt, nowSeconds, fresh.source),
    ]);
    return crossChecked({ okb: fresh.okb, usdt: fresh.usdt, source: fresh.source, ts: nowSeconds, stale: false });
  } catch (error) {
    // 4. never guess: reuse the last known value and say it is stale.
    if (cached) {
      return crossChecked({
        okb: cached.usd,
        usdt: cachedUsdt ? cachedUsdt.usd : 1,
        source: cached.source + ' (stale: ' + String(error.message || error) + ')',
        ts: cached.ts,
        stale: true,
      });
    }
    return null;
  }
}