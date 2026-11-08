// TapeGuardian daemon engine.
//
// The always-on brain. It runs inside the Worker (cron trigger, external cron hit,
// or the page watchdog calling /api/tick), evaluates the rules, asks the policy
// circuit whether a proposed action is allowed, and - only if the circuit agrees -
// submits the execution through the container as an authorised relayer.
//
// Nothing here keeps state in memory: every decision is a row in D1, so a restart
// in the middle of a tick loses nothing.

import { encodeAddress, encodeUint, encodeCall, strip, formatUnits } from './abi.js';
import { selector, keccakHex } from './keccak.js';
import * as chain from './chain.js';
import { currentPrices } from './oracle.js';
import { addressFromPrivateKey, isPrivateKey, selfTest as signerSelfTest, signTransaction, signDynamicFee } from './wallet.js';

const DAY = 86400;
const LOCK_TTL = 25;

function leaseToken () {
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function ensureTradeColumn (db) {
  try { await db.prepare("ALTER TABLE queue ADD COLUMN trade_id TEXT NOT NULL DEFAULT ''").run(); } catch { /* already migrated */ }
  try { await db.prepare("ALTER TABLE queue ADD COLUMN claim_token TEXT NOT NULL DEFAULT ''").run(); } catch { /* already migrated */ }
  try { await db.prepare('CREATE INDEX IF NOT EXISTS queue_trade ON queue (trade_id, ts DESC)').run(); } catch { /* already present */ }
}

/**
 * Fingerprint of an approved action. Captured when the circuit says yes, re-derived
 * immediately before signing: the keeper can therefore never broadcast calldata that
 * differs from what the policy check approved.
 */
function actionDigest (container, step) {
  return keccakHex([
    String(container || '').toLowerCase(),
    String(step?.target || '').toLowerCase(),
    String(step?.value ?? '0'),
    String(step?.data || '0x').toLowerCase(),
  ].join('|'));
}

export const DEFAULTS = {
  chainId: '196',
  container: '',
  policy: '',
  armed: '1',
  operator: 'local',
  targetOkbBps: '6000',
  driftBps: '500',
  minTradeWei: '10000000000000000',
  maxTradesPerDay: '6',
  cooldownS: '300',
  gasReserveWei: '20000000000000000',
  usdt: '',
  usdtDecimals: '6',
  router: '',
  factory: '',
  wrappedNative: '',
  pathSell: '[]',
  pathBuy: '[]',
  slippageBps: '150',
  swapDeadlineS: '900',
  maxQueueAgeS: '900',
  requireQuote: '1',
  maxFeedDeviationBps: '500',
  minLiquidityUsd: '10000',
  maxPriceImpactBps: '150',
};

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const big = (value, fallback = '0') => {
  try {
    return BigInt(value === '' || value === null || value === undefined ? fallback : value);
  } catch {
    return BigInt(fallback);
  }
};
const lower = (value) => String(value || '').trim().toLowerCase();

export function constantProductCurveImpact(amountIn, reserveIn, maxImpactBps) {
  const denominator = reserveIn + amountIn;
  const numerator = amountIn * 10000n;
  const impactBps = Number((numerator + denominator - 1n) / denominator);
  return { impactBps, exceedsLimit: impactBps > maxImpactBps };
}

export function inputReserveForPath(path, pool) {
  const token0 = pool.token0.toLowerCase();
  if (token0 === path[0].toLowerCase()) return pool.reserve0;
  if (token0 === path[1].toLowerCase()) return pool.reserve1;
  throw new Error('pool tokens do not match the trade path');
}

/* --------------------------------------------------------------------- config */

export async function getConfig(db) {
  const { results } = await db.prepare('SELECT key, value FROM config').all();
  const raw = { ...DEFAULTS };
  for (const row of results || []) raw[row.key] = row.value;
  return raw;
}

export function typed(raw) {
  return {
    raw,
    chainId: num(raw.chainId, 196),
    container: lower(raw.container),
    policy: lower(raw.policy),
    armed: String(raw.armed) === '1',
    targetOkbBps: Math.min(10000, Math.max(0, num(raw.targetOkbBps, 6000))),
    driftBps: Math.min(5000, Math.max(0, num(raw.driftBps, 500))),
    minTrade: big(raw.minTradeWei),
    maxTradesPerDay: Math.max(1, num(raw.maxTradesPerDay, 6)),
    cooldownS: Math.max(30, num(raw.cooldownS, 300)),
    gasReserve: big(raw.gasReserveWei),
    usdt: lower(raw.usdt),
    usdtDecimals: num(raw.usdtDecimals, 6),
    router: lower(raw.router),
    factory: lower(raw.factory),
    wrappedNative: lower(raw.wrappedNative),
    pathSell: safeArray(raw.pathSell).map(lower),
    pathBuy: safeArray(raw.pathBuy).map(lower),
    slippageBps: Math.min(2000, Math.max(0, num(raw.slippageBps, 150))),
    swapDeadlineS: Math.max(60, num(raw.swapDeadlineS, 900)),
    maxQueueAgeS: Math.max(60, num(raw.maxQueueAgeS, 900)),
    requireQuote: true,
    maxFeedDeviationBps: Math.min(5000, Math.max(0, num(raw.maxFeedDeviationBps, 500))),
    minLiquidityUsd: Math.max(10000, num(raw.minLiquidityUsd, 10000)),
    maxPriceImpactBps: Math.min(150, Math.max(1, num(raw.maxPriceImpactBps, 150))),
  };
}

function safeArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function setConfig(db, patch) {
  const ts = Math.floor(Date.now() / 1000);
  const entries = Object.entries(patch || {}).filter(([key]) => key in DEFAULTS);
  const statements = entries.map(([key, value]) =>
    db.prepare('INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .bind(key, String(value), ts),
  );
  if (statements.length) await db.batch(statements);
  return entries.map(([key]) => key);
}

/* ----------------------------------------------------------------------- log */

export async function logRow(db, kind, title, detail = '', extra = {}) {
  const ts = Math.floor(Date.now() / 1000);
  await db.prepare('INSERT INTO log (ts, kind, title, detail, tx_hash, rule_id) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(ts, kind, title, String(detail), extra.txHash || null, extra.ruleId || null)
    .run();
  return { ts, kind, title, detail, ...extra };
}

export async function recentLog(db, limit = 40) {
  const { results } = await db
    .prepare('SELECT ts, kind, title, detail, tx_hash AS txHash, rule_id AS ruleId FROM log ORDER BY id DESC LIMIT ?')
    .bind(Math.min(200, Math.max(1, limit)))
    .all();
  return results || [];
}

/* --------------------------------------------------------------------- store */

export async function acquireTickLock(db) {
  const ts = Math.floor(Date.now() / 1000);
  const token = leaseToken();
  const value = JSON.stringify({ token, expiresAt: ts + LOCK_TTL });
  const result = await db
    .prepare(
      `INSERT INTO state (key, value, ts) VALUES ('tick_lock', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts
       WHERE state.ts < ?`,
    )
    .bind(value, ts, ts - LOCK_TTL)
    .run();
  return (result.meta?.changes ?? 0) === 1 ? { token, expiresAt: ts + LOCK_TTL } : null;
}

export async function renewTickLock(db, lease) {
  if (!lease) return false;
  const ts = Math.floor(Date.now() / 1000);
  if (Number(lease.expiresAt || 0) <= ts) return false;
  const next = { token: lease.token, expiresAt: ts + LOCK_TTL };
  const result = await db.prepare("UPDATE state SET value = ?, ts = ? WHERE key = 'tick_lock' AND value = ? AND ts >= ?")
    .bind(JSON.stringify(next), ts, JSON.stringify(lease), ts - LOCK_TTL).run();
  if ((result.meta?.changes ?? 0) !== 1) return false;
  lease.expiresAt = next.expiresAt;
  return true;
}

export async function releaseTickLock(db, lease) {
  if (!lease) return;
  await db.prepare("UPDATE state SET value = '', ts = 0 WHERE key = 'tick_lock' AND value = ?")
    .bind(JSON.stringify(lease)).run();
}

async function tradesLastDay(db) {
  const since = Math.floor(Date.now() / 1000) - DAY;
  const row = await db
    .prepare("SELECT COUNT(DISTINCT trade_id) AS n FROM queue WHERE ts >= ? AND trade_id <> '' AND status IN ('sent', 'pending', 'confirmed', 'ambiguous')")
    .bind(since)
    .first();
  return Number(row?.n || 0);
}

/** Queued actions the daemon will not send within `maxQueueAgeS` are dead weight:
 *  the price they were sized against has moved, so they are marked expired instead
 *  of being retried forever or silently piling up. */
export function queueOutcome(outcome) {
  return {
    status: outcome === 'sent' ? 'sent' : outcome === 'rejected' ? 'skipped' : 'pending',
    retryable: outcome === 'queued',
    globalBlocked: outcome === 'blocked',
  };
}

export async function expireQueue(db, cfg) {
  const now = Math.floor(Date.now() / 1000);
  const maxAge = Number(cfg?.maxQueueAgeS || 900);
  const cutoff = now - maxAge;
  const res = await db
    .prepare("UPDATE queue SET status = 'expired', claim_token = '', reason = ?, updated_at = ? WHERE status IN ('pending', 'processing') AND ts < ?")
    .bind(`expired: not sent within ${maxAge}s`, now, cutoff)
    .run();
  const changed = Number(res?.meta?.changes || 0);
  if (changed > 0) {
    await logRow(db, 'QUEUE', `${changed} queued action(s) expired`, `older than ${maxAge}s — the next cycle re-plans from a fresh price`);
  }
  return changed;
}

/**
 * Re-checks queued actions and submits the ones the circuit still approves.
 *
 * The queue is not a parking lot: a row written while the keeper was missing, the
 * kill switch was on or the container was inactive is re-validated against the
 * circuit on chain and sent as soon as the gate opens, and it expires (see
 * expireQueue) when it is too old to be trusted. The circuit verdict is re-taken
 * here, so a queued action can never bypass a policy change made in the meantime.
 */
export async function drainQueue(env, cfg, limit = 3, nonceContext = null, lease = null) {
  if (!cfg.armed || !env.RELAYER_KEY) return 0;
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const maxAge = Number(cfg.maxQueueAgeS || 900);
  const { results } = await db
    .prepare("SELECT id, trade_id AS tradeId, rule_id AS ruleId, target, value, data, memo, steps FROM queue WHERE status = 'pending' AND ts >= ? ORDER BY id LIMIT ?")
    .bind(now - maxAge, limit)
    .all();

  let sent = 0;
  for (const row of results || []) {
    if (lease && !(await renewTickLock(db, lease))) break;
    const claimToken = leaseToken();
    const claimed = await db.prepare("UPDATE queue SET status = 'processing', claim_token = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .bind(claimToken, now, row.id).run();
    if ((claimed.meta?.changes ?? 0) !== 1) continue;
    let step = null;
    try { step = (JSON.parse(row.steps || '[]') || [])[0] || null; } catch { step = null; }
    if (!step || typeof step !== 'object') {
      step = { target: row.target, value: row.value, data: row.data, memo: row.memo || '', tradeId: row.tradeId };
    }
    if (!step.tradeId) step.tradeId = row.tradeId;
    step.claimToken = claimToken;
    if (step.dependsOn !== null && step.dependsOn !== undefined) {
      const prior = await db.prepare("SELECT status, steps FROM queue WHERE trade_id = ?").bind(step.tradeId).all();
      let predecessor = null;
      for (const candidate of prior.results || []) {
        try {
          const candidateStep = (JSON.parse(candidate.steps || '[]') || [])[0];
          if (candidateStep && candidateStep.stepIndex === step.dependsOn) predecessor = candidate;
        } catch { /* malformed legacy metadata is handled below */ }
      }
      if (!predecessor || !['sent', 'confirmed'].includes(predecessor.status)) continue;
    }
    const outcome = await submitStep(env, cfg, step, row.ruleId, { queueId: row.id, queueClaim: claimToken, nonceContext });
    if (outcome === 'sent') {
      sent += 1;
      continue;
    }
    if (outcome === 'rejected') continue; // this row is closed, the next one may still pass
    // 'blocked'/'queued' means a global gate (kill switch, gas, keeper not authorised):
    // hammering the remaining rows would only add noise.
    break;
  }
  if (sent > 0) await logRow(db, 'QUEUE', `${sent} queued action(s) sent`, 're-validated against the circuit before submission');
  return sent;
}

async function enqueue(db, cfg, step, reason, ruleId) {
  const ts = Math.floor(Date.now() / 1000);
  const maxAge = Number(cfg?.maxQueueAgeS || 900);
  // Deduplicate: an action already waiting for this window is not queued again, so a
  // failing RPC or a locked price cannot flood the queue with identical rows.
  const dup = await db
    .prepare("SELECT id FROM queue WHERE status = 'pending' AND target = ? AND value = ? AND data = ? AND ts >= ? LIMIT 1")
    .bind(step.target, String(step.value), step.data, ts - maxAge)
    .first();
  if (dup) return false;
  const tradeId = step.tradeId || leaseToken();
  step.tradeId = tradeId;
  await db
    .prepare('INSERT INTO queue (trade_id, ts, rule_id, target, value, data, memo, status, reason, steps, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(tradeId, ts, ruleId || null, step.target, String(step.value), step.data, step.memo || '', 'pending', reason, JSON.stringify([step]), ts)
    .run();
  await logRow(db, 'QUEUE', 'Execution queued', `${step.memo || 'action'} · ${reason}`, { ruleId });
  return true;
}

/* ------------------------------------------------------------ calldata build */

function callWithAddressArray(signature, before, addresses, after) {
  const headCount = before.length + 1 + after.length;
  const offset = encodeUint(headCount * 32);
  const tail = encodeUint(addresses.length) + addresses.map(encodeAddress).join('');
  return selector(signature) + before.join('') + offset + after.join('') + tail;
}

function usdToUnits(usd, price, decimals) {
  if (!price || price <= 0) return 0n;
  const scaled = Math.round((usd / price) * 10 ** decimals);
  return scaled > 0 ? BigInt(scaled) : 0n;
}

function bps(value, bpsPoints) {
  return (value * BigInt(10000 - bpsPoints)) / 10000n;
}

/**
 * Turns "swap this much USD value" into the exact container calldata.
 * sell = OKB -> USDT (native in, token out), buy = USDT -> OKB (token in, native out).
 */
export async function buildTradeSteps(env, cfg, side, amountUsd, prices, now = Math.floor(Date.now() / 1000)) {
  if (!cfg.router) return { steps: [], reason: 'DEX router not configured' };
  const deadline = String(now + cfg.swapDeadlineS);
  const okb = prices?.okb;
  const usdtPrice = prices?.usdt || 1;
  if (!okb || okb <= 0) return { steps: [], reason: 'no OKB price' };

  if (side === 'sell') {
    const path = cfg.pathSell.length >= 2 ? cfg.pathSell : [cfg.wrappedNative, cfg.usdt];
    if (path.filter(Boolean).length < 2) return { steps: [], reason: 'swap path for OKB→USDT not configured' };
    const amountNative = usdToUnits(amountUsd, okb, 18);
    if (amountNative <= 0n) return { steps: [], reason: 'trade too small' };
    const liquidity = await liquidityGuard(env, cfg, path, prices);
    if (liquidity.error) return { steps: [], reason: liquidity.error };
    const priced = await minOutFromPool(env, cfg, amountNative, path, usdToUnits(amountUsd, usdtPrice, cfg.usdtDecimals), cfg.usdtDecimals, liquidity.pool);
    if (priced.error) return { steps: [], reason: priced.error };
    const data = callWithAddressArray(
      'swapExactETHForTokens(uint256,address[],address,uint256)',
      [encodeUint(priced.minOut.toString())],
      path,
      [encodeAddress(cfg.container), encodeUint(deadline)],
    );
    return {
      steps: [{
        target: cfg.router,
        value: amountNative.toString(),
        data,
        memo: `rebalance: sell ${formatUnits(amountNative, 18)} OKB for ~${amountUsd.toFixed(2)} USDT (min out ${formatUnits(priced.minOut, cfg.usdtDecimals)}, ${priced.note})`,
        side,
        amountNative,
      }],
      reason: 'ok',
    };
  }

  const path = cfg.pathBuy.length >= 2 ? cfg.pathBuy : [cfg.usdt, cfg.wrappedNative];
  if (path.filter(Boolean).length < 2) return { steps: [], reason: 'swap path for USDT→OKB not configured' };
  const amountIn = usdToUnits(amountUsd, usdtPrice, cfg.usdtDecimals);
  if (amountIn <= 0n) return { steps: [], reason: 'trade too small' };
  const liquidity = await liquidityGuard(env, cfg, path, prices);
  if (liquidity.error) return { steps: [], reason: liquidity.error };
  const priced = await minOutFromPool(env, cfg, amountIn, path, usdToUnits(amountUsd, okb, 18), 18, liquidity.pool);
  if (priced.error) return { steps: [], reason: priced.error };
  return {
    steps: [
      {
        target: cfg.usdt,
        value: '0',
        // Approve exactly what the swap consumes, so nothing is left standing on the
        // router. A failed swap triggers an approve(0) cleanup (see submitStep).
        data: encodeCall('approve(address,uint256)', [encodeAddress(cfg.router), encodeUint(amountIn.toString())]),
        memo: `rebalance: approve ${formatUnits(amountIn, cfg.usdtDecimals)} USDT (consumed by the swap)`,
        side,
      },
      {
        target: cfg.router,
        value: '0',
        data: callWithAddressArray(
          'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
          [encodeUint(amountIn.toString()), encodeUint(priced.minOut.toString())],
          path,
          [encodeAddress(cfg.container), encodeUint(deadline)],
        ),
        memo: `rebalance: buy OKB with ${formatUnits(amountIn, cfg.usdtDecimals)} USDT (min out ${formatUnits(priced.minOut, 18)}, ${priced.note})`,
        side,
        onFailReset: cfg.usdt,
      },
      {
        target: cfg.usdt,
        value: '0',
        // Belt and braces: an exact-in swap consumes the whole allowance, but the
        // reset makes "no standing allowance on the router" true even if a swap
        // settles partially. An approve of zero is always policy-approved.
        data: encodeCall('approve(address,uint256)', [encodeAddress(cfg.router), encodeUint(0)]),
        memo: 'rebalance: reset the router allowance to 0 after the swap',
        side,
        cleanup: true,
      },
    ],
    reason: 'ok',
  };
}

/**
 * Minimum acceptable output, taken from the pool itself and cross-checked against the
 * off-chain feed. A feed that disagrees with the pool by more than
 * `maxFeedDeviationBps` stops the trade instead of sizing it from a wrong number.
 */
async function liquidityGuard(env, cfg, path, prices) {
  if (!cfg.factory) return { error: 'DEX factory not configured; refusing trade without liquidity validation' };
  if (!Array.isArray(path) || path.length !== 2) return { error: 'only two-token pools have validated reserve depth' };
  const pool = await chain.pairReserves(env, cfg.factory, path[0], path[1]);
  const a = path[0].toLowerCase();
  const b = path[1].toLowerCase();
  const token0 = pool.token0.toLowerCase();
  const reserveA = token0 === a ? pool.reserve0 : pool.reserve1;
  const reserveB = token0 === a ? pool.reserve1 : pool.reserve0;
  if (reserveA <= 0n || reserveB <= 0n) return { error: 'pool has zero liquidity' };
  const usdt = String(cfg.usdt || '').toLowerCase();
  const native = String(cfg.wrappedNative || '').toLowerCase();
  if (![a, b].includes(usdt) || ![a, b].includes(native)) return { error: 'trade path must connect configured USDT and wrapped native assets' };
  const stableReserve = a === usdt ? reserveA : reserveB;
  const nativeReserve = a === native ? reserveA : reserveB;
  const stableUsd = Number(formatUnits(stableReserve, cfg.usdtDecimals)) * Number(prices.usdt || 1);
  const nativeUsd = Number(formatUnits(nativeReserve, 18)) * Number(prices.okb || 0);
  const depthUsd = Math.min(nativeUsd, stableUsd) * 2;
  if (!Number.isFinite(depthUsd) || depthUsd < cfg.minLiquidityUsd) return { error: `pool liquidity $${Number(depthUsd || 0).toFixed(2)} below minimum $${cfg.minLiquidityUsd}` };
  return { pool, depthUsd };
}

export async function minOutFromPool(env, cfg, amountIn, path, feedOut, outDecimals, pool, quoteOut = chain.quoteOut) {
  if (!pool || path.length !== 2) {
    return { error: 'pool reserves are required for price-impact validation' };
  }
  const reserveIn = inputReserveForPath(path, pool);
  if (reserveIn <= 0n) return { error: 'zero-liquidity pool - refusing trade' };
  const impact = constantProductCurveImpact(amountIn, reserveIn, cfg.maxPriceImpactBps);
  const impactBps = impact.impactBps;
  if (impact.exceedsLimit) {
    return { error: `estimated fee-excluded curve price impact ${impactBps} bps exceeds max ${cfg.maxPriceImpactBps} bps` };
  }

  let onchain = null;
  try {
    onchain = await quoteOut(env, cfg.router, amountIn, path);
  } catch (error) {
    return { error: 'no on-chain quote: ' + (error?.message || String(error)) };
  }
  if (!onchain || onchain <= 0n) {
    return { error: 'router returned no quote - refusing to size the trade from the feed alone' };
  }
  const diff = feedOut > onchain ? feedOut - onchain : onchain - feedOut;
  const deviationBps = Number((diff * 10000n) / onchain);
  if (onchain <= 0n) return { error: 'zero-liquidity pool quote - refusing trade' };
  if (deviationBps > cfg.maxFeedDeviationBps) {
    return { error: `feed deviates from the pool by ${deviationBps} bps (max ${cfg.maxFeedDeviationBps}) - refusing to trade` };
  }
  const base = feedOut < onchain ? feedOut : onchain;
  return {
    minOut: bps(base, cfg.slippageBps),
    note: `pool quote ${formatUnits(onchain, outDecimals)}; fee-excluded curve impact ${impactBps} bps`,
  };
}

/* --------------------------------------------------------------- submission */

async function submitStep(env, cfg, step, ruleId, opts = {}) {
  const db = env.DB;
  const key = env.RELAYER_KEY;
  // opts.queueId: the action comes from a queued row (drainQueue), so the row is
  // updated in place instead of a second row being written for the same action.
  const queueId = opts.queueId || null;
  // Every refusal is queued and reported as 'queued' (or 'blocked' when the queue
  // already holds the same action), so the caller never mistakes a queued action for
  // an executed one.
  const skip = async (why) => {
    const stored = await enqueue(db, cfg, step, why, ruleId);
    return stored ? 'queued' : 'blocked';
  };

  // 1. gate: kill switch, signer, authorisation, activation
  if (!cfg.armed) return skip('kill switch is on (armed=0)');
  if (!key || !isPrivateKey(key)) return skip('no relayer key configured (RELAYER_KEY secret)');

  const selfTest = await signerSelfTest();
  if (!selfTest.ok) return skip('signer self-test failed: ' + selfTest.reason);

  const relayer = addressFromPrivateKey(key);
  if (!(await chain.isRelayer(env, cfg.container, relayer))) {
    return skip(`relayer ${relayer} not authorised on the container (owner-only setRelayer)`);
  }

  let info = null;
  try {
    info = await chain.containerInfo(env, cfg.container);
  } catch {
    info = null;
  }
  if (info && !info.active) return skip('agent not active — activation fee required');

  // 2. authoritative policy check, straight from the circuit
  //    The digest of the approved action is captured *before* any further awaits,
  //    so a mutation of step.target/value/data during gas estimation or signing is
  //    detected and refused instead of broadcast.
  const approvedDigest = actionDigest(cfg.container, step);
  const verdict = await chain.containerSimulate(env, cfg.container, step.target, big(step.value), step.data);
  await logRow(db, verdict.approved ? 'POLICY' : 'REJECT',
    verdict.approved ? 'Policy circuit approved' : 'Policy circuit rejected',
    `${step.memo || step.target} · ${verdict.reason}`, { ruleId });
  if (!verdict.approved) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (queueId) {
      await db.prepare("UPDATE queue SET status = 'skipped', reason = ?, claim_token = '', updated_at = ? WHERE id = ? AND status = 'processing' AND claim_token = ?")
        .bind(verdict.reason, nowSec, queueId, opts.queueClaim || '').run();
    } else {
      const tradeId = step.tradeId || leaseToken();
      step.tradeId = tradeId;
      await db.prepare('INSERT INTO queue (trade_id, ts, rule_id, target, value, data, memo, status, reason, steps, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(tradeId, nowSec, ruleId || null, step.target, step.value, step.data, step.memo || '', 'skipped', verdict.reason, JSON.stringify([step]), nowSec)
        .run();
    }
    return 'rejected';
  }

  // 3. balance guard: the container must be able to pay value + gas
  const native = await chain.nativeBalance(env, cfg.container);
  if (native < big(step.value)) return skip('container balance too low for this action');

  // 4. sign and broadcast. EIP-1559 (type 2) first: X Layer accepts it and it can be
  //    fee-bumped if the keeper transaction gets stuck; legacy is the fallback.
  try {
    const data = chain.executeCalldata(step.target, step.value, step.data);
    const tip = await chain.maxPriorityFee(env);
    const baseGas = await chain.gasPrice(env);
    const maxFee = baseGas * 2n > tip * 2n ? baseGas * 2n : tip * 2n;
    let reservedNonce;
    if (opts.nonceContext) {
      if (opts.nonceContext.next === null) {
        opts.nonceContext.address = relayer;
        opts.nonceContext.next = await chain.nonceOf(env, relayer);
      }
      reservedNonce = opts.nonceContext.next;
    } else {
      reservedNonce = await chain.nonceOf(env, relayer);
    }
    const tx = {
      chainId: cfg.chainId,
      nonce: reservedNonce,
      maxPriorityFeePerGas: tip,
      maxFeePerGas: maxFee,
      gasLimit: 0n,
      to: cfg.container,
      value: 0n,
      data,
    };
    const estimate = await chain.estimateGas(env, { from: relayer, to: cfg.container, value: '0x0', data });
    tx.gasLimit = (estimate * 125n) / 100n;

    // What the circuit approved and what gets signed must be the same bytes. The
    // digest captured at approval time is re-derived from the action as it stands
    // now, and the envelope is rebuilt from it; anything that mutated while the
    // awaits ran is refused instead of broadcast.
    if (actionDigest(cfg.container, step) !== approvedDigest
        || chain.executeCalldata(step.target, step.value, step.data) !== data) {
      return skip('approved action changed between simulation and signing');
    }

    const relayerBalance = await chain.nativeBalance(env, relayer);
    if (relayerBalance < tx.gasLimit * maxFee) {
      return skip('relayer has no gas — top up the relayer address with a little OKB');
    }

    let kind = 'eip1559';
    let raw;
    try {
      raw = await signDynamicFee(tx, key);
    } catch {
      kind = 'legacy';
      raw = await signTransaction({ ...tx, gasPrice: maxFee }, key);
    }
    let hash;
    try {
      hash = await chain.sendRaw(env, raw);
    } catch (error) {
      if (kind !== 'eip1559') {
        // The node may have accepted the raw transaction before the response
        // timed out. Never blindly rebroadcast at a new nonce.
        const observed = await chain.nonceOf(env, relayer).catch(() => reservedNonce);
        if (observed > reservedNonce) {
          kind = 'ambiguous';
          hash = `unknown-nonce:${reservedNonce.toString()}`;
        } else throw error;
      } else {
        // node rejected the type-2 envelope: retry once as a legacy transaction
        kind = 'legacy';
        try {
          hash = await chain.sendRaw(env, await signTransaction({ ...tx, gasPrice: maxFee }, key));
        } catch (legacyError) {
          const observed = await chain.nonceOf(env, relayer).catch(() => reservedNonce);
          if (observed > reservedNonce) {
            kind = 'ambiguous';
            hash = `unknown-nonce:${reservedNonce.toString()}`;
          } else throw legacyError;
        }
      }
    }
    if (opts.nonceContext) opts.nonceContext.next = reservedNonce + 1n;

    const ts = Math.floor(Date.now() / 1000);
    if (queueId) {
      await db.prepare('UPDATE queue SET status = ?, tx_hash = ?, claim_token = \'\', reason = ?, updated_at = ? WHERE id = ? AND status = \'processing\' AND claim_token = ?')
        .bind(kind === 'ambiguous' ? 'ambiguous' : 'sent', hash, kind === 'ambiguous' ? `broadcast outcome unknown at nonce ${reservedNonce.toString()} — operator reconciliation required` : `submitted by relayer (${kind}) after re-check`, ts, queueId, opts.queueClaim || '').run();
    } else {
      const tradeId = step.tradeId || leaseToken();
      step.tradeId = tradeId;
      await db.prepare('INSERT INTO queue (trade_id, ts, rule_id, target, value, data, memo, status, tx_hash, reason, steps, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(tradeId, ts, ruleId || null, step.target, step.value, step.data, step.memo || '', kind === 'ambiguous' ? 'ambiguous' : 'sent', hash, kind === 'ambiguous' ? `broadcast outcome unknown at nonce ${reservedNonce.toString()} — operator reconciliation required` : `submitted by relayer (${kind})`, JSON.stringify([step]), ts)
        .run();
    }
    await logRow(db, 'EXEC', 'Executed through the container', `${step.memo || step.target} · tx ${hash} · ${kind}`, { txHash: hash, ruleId });
    return 'sent';
  } catch (error) {
    const stored = await enqueue(db, cfg, step, 'submit failed: ' + (error?.message || String(error)), ruleId);
    // A failed swap must not leave a standing allowance on the router: reset it to 0.
    // The reset is itself a container execution, so it goes through the same policy.
    if (step.onFailReset && !step.cleanup) {
      try {
        await enqueue(db, cfg, {
          target: step.onFailReset,
          value: '0',
          data: encodeCall('approve(address,uint256)', [encodeAddress(cfg.router), encodeUint(0)]),
          memo: 'reset router allowance to 0 after a failed swap',
          tradeId: step.tradeId,
          stepIndex: (step.stepIndex || 0) + 1,
          dependsOn: step.stepIndex || 0,
          cleanup: true,
        }, 'swap failed; cleanup waits in the same trade workflow', ruleId);
      } catch {
        /* the next cycle retries the reset */
      }
    }
    return stored ? 'queued' : 'blocked';
  }
}

/** Confirms transactions still marked "sent" once a receipt exists. */
async function confirmPending(env) {
  const db = env.DB;
  const since = Math.floor(Date.now() / 1000) - 3 * DAY;
  const { results } = await db
    .prepare("SELECT id, tx_hash AS hash FROM queue WHERE status = 'sent' AND ts >= ? ORDER BY id DESC LIMIT 5")
    .bind(since)
    .all();
  for (const row of results || []) {
    if (!row.hash) continue;
    try {
      const rec = await chain.receipt(env, row.hash);
      if (!rec) continue;
      const ok = rec.status === '0x1' || rec.status === 1 || rec.status === '1';
      await db.prepare('UPDATE queue SET status = ?, reason = ?, updated_at = ? WHERE id = ?')
        .bind(ok ? 'confirmed' : 'failed', ok ? 'confirmed on chain' : 'reverted on chain', Math.floor(Date.now() / 1000), row.id)
        .run();
      await logRow(db, ok ? 'EXEC' : 'REJECT', ok ? 'Confirmed on chain' : 'Transaction reverted', row.hash, { txHash: row.hash });
    } catch {
      /* node hiccup - retry next tick */
    }
  }
}

/* ------------------------------------------------------------------ strategies */

async function portfolio(env, cfg, prices) {
  const [native, usdtUnits] = await Promise.all([
    chain.nativeBalance(env, cfg.container),
    cfg.usdt ? chain.erc20Balance(env, cfg.usdt, cfg.container).catch(() => 0n) : Promise.resolve(0n),
  ]);
  const spendable = native > cfg.gasReserve ? native - cfg.gasReserve : 0n;
  const okbUsd = Number(formatUnits(spendable, 18)) * (prices?.okb || 0);
  const usdtUsd = cfg.usdt ? Number(formatUnits(usdtUnits, cfg.usdtDecimals)) * (prices?.usdt || 1) : 0;
  const total = okbUsd + usdtUsd;
  return {
    native,
    spendable,
    usdtUnits,
    okbUsd,
    usdtUsd,
    total,
    okbBps: total > 0 ? Math.round((okbUsd / total) * 10000) : 10000,
  };
}

function capUsd(cfg, price, usd) {
  // never propose more than the policy's per-action ceiling or one trade's worth
  const perActionUsd = Number(formatUnits(cfg.perActionCeiling ?? 0n, 18)) * (price || 0);
  let value = usd;
  if (perActionUsd > 0) value = Math.min(value, perActionUsd);
  const minUsd = Number(formatUnits(cfg.minTrade, 18)) * (price || 0);
  return value < minUsd ? 0 : value;
}

async function buildStepsSafe(env, cfg, side, amountUsd, prices) {
  // Building a trade hits the pool quote and the RPC. A failure there must reject
  // this rule for this cycle instead of aborting the whole tick.
  try {
    return await buildTradeSteps(env, cfg, side, amountUsd, prices);
  } catch (error) {
    return { steps: [], reason: 'trade build failed: ' + (error?.message || String(error)) };
  }
}

async function evaluateRebalance(env, cfg, prices, holdings) {
  if (!cfg.router) return { steps: [], note: 'DEX router not configured — rebalancing idle' };
  if (holdings.total <= 0) return { steps: [], note: 'container holds nothing yet' };

  const target = cfg.targetOkbBps;
  const drift = holdings.okbBps - target;

  if (Math.abs(drift) <= cfg.driftBps) {
    return { steps: [], note: `in band: ${(holdings.okbBps / 100).toFixed(1)}% OKB vs ${(target / 100).toFixed(1)}% target` };
  }

  const side = drift > 0 ? 'sell' : 'buy';
  const deltaUsd = Math.abs((drift / 10000) * holdings.total);
  const amountUsd = capUsd(cfg, prices.okb, deltaUsd);
  if (amountUsd <= 0) return { steps: [], note: 'drift found but trade below the minimum size' };

  if (side === 'sell' && holdings.spendable < cfg.minTrade) {
    return { steps: [], note: 'not enough spendable OKB to sell' };
  }
  if (side === 'buy' && holdings.usdtUsd < amountUsd * 0.99) {
    return { steps: [], note: 'not enough USDT to buy' };
  }

  const plan = await buildStepsSafe(env, cfg, side, amountUsd, prices);
  return {
    steps: plan.steps,
    note: plan.steps.length
      ? `${side} ${amountUsd.toFixed(2)} USD to return to ${(target / 100).toFixed(1)}% OKB (now ${(holdings.okbBps / 100).toFixed(1)}%)`
      : `drift needs a ${side} of ${amountUsd.toFixed(2)} USD: ${plan.reason}`,
  };
}

/* ----------------------------------------------------------------------- tick */

export async function tick(env, source = 'cron') {
  const db = env.DB;
  const started = Date.now();
  const lease = await acquireTickLock(db);
  if (!lease) return { skipped: 'another tick is running' };
  await ensureTradeColumn(db);
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    renewTickLock(db, lease).then((ok) => { if (!ok) leaseLost = true; }).catch(() => { leaseLost = true; });
  }, Math.max(1000, Math.floor((LOCK_TTL * 1000) / 3)));

  let decisions = 0;
  let executions = 0;
  let queued = 0;
  let note = 'ok';

  try {
    const raw = await getConfig(db);
    const cfg = typed(raw);

    if (!cfg.container || !cfg.policy) {
      await logRow(db, 'CONFIG', 'Agent not configured', 'set the container and policy addresses in the Autonomy tab');
      return { skipped: 'not configured' };
    }
    if (!chain.rpcConfigured(env)) {
      await logRow(db, 'ERROR', 'No RPC endpoint', 'add the RPC_URL secret in the server view');
      return { skipped: 'no rpc' };
    }
    const nonceContext = { address: null, next: null };

    const prices = await currentPrices(env, db).catch(() => null);
    if (prices?.okb) {
      await logRow(db, 'ORACLE', 'Price tick', `OKB $${Number(prices.okb).toFixed(3)} · USDT $${Number(prices.usdt || 1).toFixed(3)} · ${prices.source} · ${prices.check || 'not cross-checked'}`);
      if (prices.disagree) {
        // Two independent feeds disagree: the price is not trustworthy, so nothing is
        // sized, approved or queued from it. This is a refusal, not a warning.
        await logRow(db, 'REJECT', 'Price feeds disagree — trading refused', `OKB $${Number(prices.okb).toFixed(3)} vs secondary $${Number(prices.secondary).toFixed(3)} · ${prices.check}`);
      }
    } else {
      await logRow(db, 'ERROR', 'No price available', 'oracle unreachable and no stored price — trading paused');
    }
    if (!prices?.okb || prices.disagree) {
      note = prices?.disagree ? 'price feeds disagree' : 'no price';
      await db.prepare('INSERT INTO ticks (ts, source, decisions, executions, queued, note) VALUES (?, ?, 0, 0, 0, ?)')
        .bind(Math.floor(Date.now() / 1000), String(source).slice(0, 20), note)
        .run();
      return { decisions: 0, executions: 0, queued: 0, note };
    }

    // live view of the circuit, so proposals are checked against reality
    try {
      const view = await chain.policyView(env, cfg.policy, cfg.container);
      cfg.perActionCeiling = view.maxPerAction;
      cfg.onChainPaused = view.paused;
      cfg.remainingToday = view.remainingToday;
      note = `policy ${view.paused ? 'PAUSED' : 'active'} · remaining today ${formatUnits(view.remainingToday, 18)} OKB`;
    } catch {
      note = 'policy unreadable';
    }

    const holdings = await portfolio(env, cfg, prices).catch(() => null);
    const { results: rules } = await db.prepare('SELECT id, kind, name, params, cooldown_s AS cooldownS, last_run AS lastRun, runs FROM rules WHERE enabled = 1 ORDER BY id').all();
    const nowS = Math.floor(Date.now() / 1000);
    await expireQueue(db, cfg).catch(() => {});
    /* Anything queued while the gates were closed is re-validated and sent first. */
    try {
      const drained = await drainQueue(env, cfg, 3, nonceContext, lease);
      executions += drained;
      if (drained > 0) decisions += drained;
    } catch (error) {
      await logRow(db, 'ERROR', 'Queue drain failed', error?.message || String(error));
    }
    let budget = cfg.maxTradesPerDay - (await tradesLastDay(db));

    for (const rule of rules || []) {
      if (nowS - Number(rule.lastRun || 0) < Number(rule.cooldownS || cfg.cooldownS)) continue;
      const params = safeObj(rule.params);
      let plan = null;

      if (rule.kind === 'rebalance') {
        if (!holdings) continue;
        plan = await evaluateRebalance(env, cfg, prices, holdings);
        if (!plan.steps.length) {
          await logRow(db, 'TRIGGER', `${rule.name}: nothing to do`, plan.note, { ruleId: rule.id });
          await touchRule(db, rule, nowS);
          continue;
        }
      } else if (rule.kind === 'price') {
        if (!prices?.okb) continue;
        const threshold = num(params.threshold, 0);
        const price = Number(prices.okb);
        const hit = params.op === '>=' ? price >= threshold : price <= threshold;
        if (!hit) continue;
        const side = params.action === 'buy' ? 'buy' : 'sell';
        const amountUsd = capUsd(cfg, price, num(params.amountUsd, 0));
        if (amountUsd <= 0) {
          await logRow(db, 'TRIGGER', `${rule.name}: below minimum size`, `OKB $${price.toFixed(3)} ${params.op} ${threshold}`, { ruleId: rule.id });
          await touchRule(db, rule, nowS);
          continue;
        }
        const built = await buildStepsSafe(env, cfg, side, amountUsd, prices);
        plan = { steps: built.steps, note: `OKB $${price.toFixed(3)} ${params.op} $${threshold} → ${side} ${amountUsd.toFixed(2)} USD` };
        if (!plan.steps.length) {
          await logRow(db, 'REJECT', `${rule.name}: cannot build trade`, built.reason, { ruleId: rule.id });
          await touchRule(db, rule, nowS);
          continue;
        }
      } else if (rule.kind === 'interval') {
        const every = Math.max(60, num(params.everyS, 3600));
        if (nowS - Number(rule.lastRun || 0) < every) continue;
        if (params.action === 'rebalance') {
          if (!holdings) continue;
          // A forced rebalance: pretend the drift is huge so the same code path runs.
          plan = await evaluateRebalance(env, cfg, prices, { ...holdings, okbBps: holdings.okbBps + (holdings.okbBps >= cfg.targetOkbBps ? 20000 : -20000) });
        } else {
          const side = params.action === 'buy' ? 'buy' : 'sell';
          const amountUsd = capUsd(cfg, prices?.okb || 0, num(params.amountUsd, 0));
          if (amountUsd > 0) {
            const built = await buildStepsSafe(env, cfg, side, amountUsd, prices);
            plan = { steps: built.steps, note: `scheduled ${side} of ${amountUsd.toFixed(2)} USD` };
          }
        }
        if (!plan || !plan.steps.length) {
          await logRow(db, 'TRIGGER', `${rule.name}: nothing to do`, plan?.note || 'no price or size', { ruleId: rule.id });
          await touchRule(db, rule, nowS);
          continue;
        }
      }

      if (!plan || !plan.steps.length) continue;
      await logRow(db, 'TRIGGER', `${rule.name}: firing`, plan.note, { ruleId: rule.id });
      await touchRule(db, rule, nowS);
      const tradeId = leaseToken();
      for (const plannedStep of plan.steps) plannedStep.tradeId = tradeId;

      // The daily budget counts *trades*, not RPC calls: the approve and the swap of
      // one plan are one trade, so a buy no longer eats two of the day's allowance.
      let planSent = 0;
      for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex += 1) {
        const step = plan.steps[stepIndex];
        step.stepIndex = stepIndex;
        step.dependsOn = stepIndex > 0 ? stepIndex - 1 : null;
        decisions += 1;
        if (budget <= 0) {
          if (await enqueue(db, cfg, step, `daily trade budget of ${cfg.maxTradesPerDay} reached`, rule.id)) queued += 1;
          continue;
        }
        if (leaseLost || !(await renewTickLock(db, lease))) return { error: 'tick lease lost before submission' };
        const outcome = await submitStep(env, cfg, step, rule.id, { nonceContext });
        if (outcome === 'sent') {
          executions += 1;
          planSent += 1;
          continue;
        }
        if (outcome === 'queued') queued += 1;
        // A multi-step trade is an ordered workflow. Never submit a dependent
        // swap/reset after its predecessor was queued, rejected, or failed.
        for (let dependentIndex = stepIndex + 1; dependentIndex < plan.steps.length; dependentIndex += 1) {
          const dependent = plan.steps[dependentIndex];
          dependent.tradeId = tradeId;
          dependent.stepIndex = dependentIndex;
          dependent.dependsOn = dependentIndex - 1;
          if (outcome !== 'rejected' && await enqueue(db, cfg, dependent, `waiting for trade step ${stepIndex} to succeed`, rule.id)) queued += 1;
        }
        break;
      }
      if (planSent > 0) budget -= 1;
    }

    await confirmPending(env).catch(() => {});

    const ts = Math.floor(Date.now() / 1000);
    await db.prepare('INSERT INTO ticks (ts, source, decisions, executions, queued, note) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ts, String(source).slice(0, 20), decisions, executions, queued, note)
      .run();

    await logRow(db, 'TICK', 'Daemon cycle complete',
      `${source} · ${decisions} decisions · ${executions} executed · ${queued} queued · ${Date.now() - started}ms`);

    return { decisions, executions, queued, note, ms: Date.now() - started };
  } catch (error) {
    await logRow(db, 'ERROR', 'Daemon cycle failed', error?.message || String(error));
    return { error: error?.message || String(error) };
  } finally {
    clearInterval(heartbeat);
    await releaseTickLock(db, lease);
  }
}

function safeObj(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function touchRule(db, rule, nowS) {
  await db.prepare('UPDATE rules SET last_run = ?, runs = runs + 1 WHERE id = ?').bind(nowS, rule.id).run();
}

/* --------------------------------------------------------------------- status */

/** Everything the dashboard and the public status page need, in one round trip. */
export async function statusSnapshot(env) {
  const db = env.DB;
  const raw = await getConfig(db);
  const cfg = typed(raw);

  const [log, lastTick, pending, counts, prices, signer] = await Promise.all([
    recentLog(db, 24),
    db.prepare('SELECT ts, source, decisions, executions, queued, note FROM ticks ORDER BY id DESC LIMIT 1').first(),
    db.prepare("SELECT COUNT(*) AS n FROM queue WHERE status = 'pending'").first(),
    db.prepare("SELECT status, COUNT(*) AS n FROM queue GROUP BY status").all(),
    currentPrices(env, db).catch(() => null),
    signerSelfTest().catch(() => ({ ok: false, address: null, reason: 'self-test crashed' })),
  ]);

  let holdings = null;
  let circuit = null;
  let agent = null;
  let relayerAuthorised = null;
  if (cfg.container && chain.rpcConfigured(env)) {
    holdings = await portfolio(env, cfg, prices).catch(() => null);
    circuit = cfg.policy ? await chain.policyView(env, cfg.policy, cfg.container).catch(() => null) : null;
    agent = await chain.containerInfo(env, cfg.container).catch(() => null);
    if (env.RELAYER_KEY && isPrivateKey(env.RELAYER_KEY)) {
      relayerAuthorised = await chain.isRelayer(env, cfg.container, addressFromPrivateKey(env.RELAYER_KEY)).catch(() => null);
    }
  }

  return {
    config: cfg,
    prices,
    holdings,
    circuit,
    agent,
    relayer: {
      address: signer.address,
      selfTest: signer.ok,
      reason: signer.reason || '',
      authorised: relayerAuthorised,
      configured: Boolean(env.RELAYER_KEY),
    },
    daemon: {
      lastTick,
      pending: Number(pending?.n || 0),
      counts: Object.fromEntries((counts?.results || []).map((row) => [row.status, Number(row.n)])),
      online: lastTick ? Math.floor(Date.now() / 1000) - Number(lastTick.ts) < 300 : false,
      locked: false,
    },
    log,
  };
}
