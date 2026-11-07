// TapeGuardian — always-on agent daemon + control plane.
// BigInt JSON serialization fix
BigInt.prototype.toJSON = function() { return this.toString(); }
//
// The page is only a window: this Worker is what keeps running when nobody is
// around. Cloudflare calls `scheduled` on a cron trigger (add one in the dashboard:
// Worker -> Settings -> Triggers -> Cron, every minute), or any external scheduler
// can POST /api/tick with the x-daemon-secret header. Either way the daemon
// evaluates the rules, asks the on-chain policy circuit, and - when the circuit
// approves - submits the execution through the container as an authorised relayer.
//
// Secrets (server view -> Secrets):
//   ADMIN_PASSWORD  unlocks the control plane (never in any file)
//   RELAYER_KEY     key of the keeper address authorised with setRelayer() on the
//                   container. It holds no funds and cannot withdraw or reconfigure.
//   RPC_URL         X Layer RPC endpoint (keyed endpoints stay here, never in a page)
//   DAEMON_SECRET   shared secret for external cron hits of /api/tick
//   PRICE_URL       optional JSON feed {"okb":42.5,"usdt":1.0} instead of CoinGecko
//   APP_ORIGINS     comma separated origins allowed to call this API from a browser
//                   (e.g. https://your-page.gateway). Unset = no browser access; the
//                   wildcard CORS that let any site spend owner sessions is gone.

import { isAddress, isData } from './abi.js';
import { selfTest as keccakSelfTest } from './keccak.js';
import { selfTest as signerSelfTest, addressFromPrivateKey, isPrivateKey } from './wallet.js';
import { rpcConfigured } from './chain.js';
import {
  DEFAULTS, getConfig, setConfig, statusSnapshot, tick, logRow, recentLog, typed,
} from './engine.js';
import { setManualPrice } from './oracle.js';

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization, x-daemon-secret';

/** Owner sessions are short lived and never refreshed by a background tab: the page
 *  keeps the token in sessionStorage, so closing the browser ends the session too. */
const SESSION_TTL_S = 8 * 3600;

/** Origins the owner trusts, from the APP_ORIGINS secret (comma separated). */
function allowList(env) {
  return String(env.APP_ORIGINS || '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Per-request CORS. The old wildcard let any page on the internet call this API with
 * a stolen bearer token and read the answer, so browser origins are now allow-listed
 * and the API refuses to serve a browser until APP_ORIGINS is set. Server-to-server
 * callers (cron, curl, the page's own build step) send no Origin and always pass.
 * Refusals still echo the origin, so the dashboard can read the error text.
 */
function corsFor(request, env) {
  const headers = {
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  const origin = (request.headers.get('Origin') || '').replace(/\/+$/, '');
  if (!origin) {
    headers['Access-Control-Allow-Origin'] = '*';
    return { headers, allowed: true, reason: '' };
  }
  const list = allowList(env);
  headers['Access-Control-Allow-Origin'] = origin;
  if (!list.length) {
    return {
      headers,
      allowed: false,
      reason: 'browser access is locked: set the APP_ORIGINS secret to the URL this dashboard is served from (e.g. https://your-page.gateway), then reload',
    };
  }
  if (list.includes(origin)) return { headers, allowed: true, reason: '' };
  return { headers, allowed: false, reason: `${origin} is not in APP_ORIGINS` };
}

/** Last-resort response for a crash outside a request's CORS scope. */
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const nowS = () => Math.floor(Date.now() / 1000);

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant time compare for the admin password. */
async function passwordMatches(env, provided) {
  if (!env.ADMIN_PASSWORD) return false;
  const [a, b] = await Promise.all([sha256Hex(String(provided ?? '')), sha256Hex(String(env.ADMIN_PASSWORD))]);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function bumpAttempt(db, key, limit, windowS) {
  const ts = nowS();
  const row = await db.prepare('SELECT count, window_start AS windowStart FROM attempts WHERE key = ?').bind(key).first();
  if (!row || ts - Number(row.windowStart) > windowS) {
    await db.prepare('INSERT INTO attempts (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start')
      .bind(key, ts).run();
    return { count: 1, blocked: false };
  }
  const count = Number(row.count) + 1;
  await db.prepare('UPDATE attempts SET count = ? WHERE key = ?').bind(count, key).run();
  return { count, blocked: count > limit };
}

async function ownerFrom(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB
    .prepare('SELECT token_hash AS hash, expires_at AS expiresAt FROM sessions WHERE token_hash = ?')
    .bind(hash)
    .first();
  if (!row || Number(row.expiresAt) < nowS()) return null;
  return { token, hash };
}

async function createSession(request, env) {
  const token = randomToken();
  const hash = await sha256Hex(token);
  const expires = nowS() + SESSION_TTL_S;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  // Housekeeping: expired rows are useless and only widen the window a stolen
  // token could be replayed in, so they go on every sign-in.
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowS()).run();
  await env.DB.prepare('INSERT INTO sessions (token_hash, created_at, expires_at, ip) VALUES (?, ?, ?, ?)')
    .bind(hash, nowS(), expires, ip).run();
  return { token, expiresAt: expires, ttl: SESSION_TTL_S };
}

/** A tick needs the owner session or the daemon secret. There is no "open" mode:
 *  an unauthenticated endpoint that spends money is not a feature. */
async function mayTick(request, env) {
  const owner = await ownerFrom(request, env);
  if (owner) return { ok: true, by: 'owner' };
  const secret = request.headers.get('x-daemon-secret') || '';
  if (env.DAEMON_SECRET && secret && secret === env.DAEMON_SECRET) return { ok: true, by: 'external-cron' };
  return { ok: false, by: 'anonymous' };
}

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/* --------------------------------------------------------------------- routes */

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  const cors = corsFor(request, env);
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors.headers } });
  const bad = (message, status = 400) => json({ error: message }, status);

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors.headers });
  if (!cors.allowed) return bad(cors.reason, 403);
  if (!path.startsWith('/api/')) return bad('not found', 404);

  const db = env.DB;
  if (!db) return bad('no database bound (env.DB)', 500);

  /* ---------------------------------------------------------------- health */
  if (path === '/api/health' && method === 'GET') {
    const keccak = keccakSelfTest();
    const signer = await signerSelfTest().catch(() => ({ ok: false, reason: 'crash' }));
    return json({
      ok: true,
      service: 'tapeguardian-daemon',
      keccak: keccak.ok,
      signer: { ok: signer.ok, address: signer.address, reason: signer.reason || '' },
      rpc: rpcConfigured(env),
      cors: {
        origins: allowList(env).map((item) => item.replace(/^https?:\/\//, '')),
        locked: allowList(env).length === 0,
      },
      sessionTtl: SESSION_TTL_S,
      secrets: {
        adminPassword: Boolean(env.ADMIN_PASSWORD),
        relayerKey: Boolean(env.RELAYER_KEY),
        daemonSecret: Boolean(env.DAEMON_SECRET),
        priceUrl: Boolean(env.PRICE_URL),
      },
      now: nowS(),
    });
  }

  /* ------------------------------------------------------------------- rpc */
  // Read-only JSON-RPC proxy so the published page can read chain state without a
  // wallet. It never spends the keeper key: methods are allow-listed, batches are
  // capped, and eth_getLogs is limited to a small block range. Writes cannot pass.
  if (path === '/api/rpc' && method === 'POST') {
    if (!env.RPC_URL) return bad('no RPC_URL configured on the server', 503);

    const contentLength = Number(request.headers.get('Content-Length') || 0);
    if (contentLength > 256 * 1024) return bad('JSON-RPC body exceeds 256 KiB', 413);
    let rawBody;
    try { rawBody = await request.text(); } catch { return bad('expected a JSON-RPC body'); }
    if (new TextEncoder().encode(rawBody).byteLength > 256 * 1024) return bad('JSON-RPC body exceeds 256 KiB', 413);
    let payload;
    try { payload = JSON.parse(rawBody); } catch { return bad('expected a JSON-RPC body'); }
    const isBatch = Array.isArray(payload);
    const calls = isBatch ? payload : [payload];
    if (!calls.length) return bad('empty JSON-RPC request');
    if (calls.length > 20) return bad('at most 20 calls per batch', 413);

    const ALLOWED = new Set([
      'eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getBalance', 'eth_getCode',
      'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs',
      'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_getBlockByNumber',
      'net_version',
    ]);

    const clean = [];
    for (const call of calls) {
      if (!call || typeof call !== 'object' || Array.isArray(call) || call.jsonrpc !== '2.0' || typeof call.method !== 'string') return bad('malformed JSON-RPC call');
      if (!ALLOWED.has(call.method)) return bad('method not allowed: ' + call.method, 403);
      const params = Array.isArray(call.params) ? call.params : [];
      if (call.method === 'eth_getLogs') {
        const filter = params[0] || {};
        if (typeof filter !== 'object' || Array.isArray(filter)) return bad('eth_getLogs filter must be an object');
        if (filter.blockHash !== undefined && (typeof filter.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(filter.blockHash))) return bad('invalid blockHash');
        const parseBlock = (value) => {
          if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) return null;
          try { return BigInt(value); } catch { return null; }
        };
        const hasHash = filter.blockHash !== undefined;
        if (hasHash && (filter.fromBlock !== undefined || filter.toBlock !== undefined)) return bad('blockHash cannot be combined with block range');
        if (!hasHash && (filter.fromBlock === undefined || filter.toBlock === undefined)) return bad('eth_getLogs requires blockHash or both bounded block numbers');
        if (!hasHash) {
          const from = parseBlock(filter.fromBlock);
          const to = parseBlock(filter.toBlock);
          if (from === null || to === null) return bad('eth_getLogs requires canonical hex block numbers, not symbolic tags');
          if (to < from || to - from + 1n > 5000n) return bad('eth_getLogs is limited to 5000 inclusive blocks', 400);
        }
      }
      clean.push({ jsonrpc: '2.0', id: call.id ?? 1, method: call.method, params });
    }

    const upstream = await fetch(env.RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isBatch ? clean : clean[0]),
      signal: AbortSignal.timeout(10000),
    });
    if (!upstream.ok) return bad('rpc upstream error ' + upstream.status, 502);
    const text = await upstream.text();
    if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) return bad('rpc upstream response exceeds 2 MiB', 502);
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors.headers } });
  }

  /* ---------------------------------------------------------------- status */
  if (path === '/api/status' && method === 'GET') {
    const snapshot = await statusSnapshot(env);
    return json(snapshot);
  }

  if (path === '/api/log' && method === 'GET') {
    return json({ log: await recentLog(db, clampInt(url.searchParams.get('limit'), 1, 200, 40)) });
  }

  if (path === '/api/rules' && method === 'GET') {
    const { results } = await db.prepare('SELECT id, kind, name, params, enabled, cooldown_s AS cooldownS, last_run AS lastRun, runs FROM rules ORDER BY id').all();
    return json({ rules: results || [] });
  }

  if (path === '/api/queue' && method === 'GET') {
    const status = url.searchParams.get('status');
    const statement = status
      ? db.prepare('SELECT id, trade_id AS tradeId, ts, target, value, memo, status, tx_hash AS txHash, reason FROM queue WHERE status = ? ORDER BY id DESC LIMIT 40').bind(status)
      : db.prepare('SELECT id, trade_id AS tradeId, ts, target, value, memo, status, tx_hash AS txHash, reason FROM queue ORDER BY id DESC LIMIT 40');
    const { results } = await statement.all();
    return json({ queue: results || [] });
  }

  /* ------------------------------------------------------------------ tick */
  if (path === '/api/tick' && (method === 'POST' || method === 'GET')) {
    const gate = await mayTick(request, env);
    if (!gate.ok) return bad('tick requires the owner session or the daemon secret', 401);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (gate.by !== 'owner') {
      const attempt = await bumpAttempt(db, 'tick:' + ip, 30, 60);
      if (attempt.blocked) return bad('too many ticks from this address', 429);
    }
    const result = await tick(env, gate.by === 'external-cron' ? 'cron' : gate.by);
    return json({ ticked: true, by: gate.by, result });
  }

  /* ------------------------------------------------------------------ auth */
  if (path === '/api/login' && method === 'POST') {
    if (!env.ADMIN_PASSWORD) return bad('ADMIN_PASSWORD is not set in the server secrets, so the control plane stays locked', 503);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const attempt = await bumpAttempt(db, 'login:' + ip, 10, 900);
    if (attempt.blocked) return bad('too many attempts, try again in 15 minutes', 429);
    const body = await request.json().catch(() => ({}));
    if (!(await passwordMatches(env, body.password))) return bad('wrong password', 401);
    const session = await createSession(request, env);
    await logRow(db, 'CONFIG', 'Owner signed in', ip);
    return json(session);
  }

  if (path === '/api/logout' && method === 'POST') {
    const owner = await ownerFrom(request, env);
    if (owner) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(owner.hash).run();
    return json({ ok: true });
  }

  if (path === '/api/me' && method === 'GET') {
    const owner = await ownerFrom(request, env);
    return json({ owner: Boolean(owner) });
  }

  /* ------------------------------------------------------------ owner only */
  const owner = await ownerFrom(request, env);
  const requireOwner = () => {
    if (!owner) throw new Response(JSON.stringify({ error: 'owner session required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...cors.headers },
    });
  };

  try {
    if (path === '/api/config' && method === 'GET') {
      requireOwner();
      return json({ config: await getConfig(db), defaults: DEFAULTS });
    }

    if (path === '/api/config' && (method === 'PUT' || method === 'POST')) {
      requireOwner();
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') return bad('expected a JSON object');
      const patch = {};

      for (const key of ['container', 'policy', 'usdt', 'router', 'factory', 'wrappedNative']) {
        if (body[key] !== undefined) {
          const value = String(body[key] || '').trim().toLowerCase();
          if (value && !isAddress(value)) return bad(`${key} is not a valid address`);
          patch[key] = value;
        }
      }
      if (body.chainId !== undefined) patch.chainId = String(clampInt(body.chainId, 1, 1e9, 196));
      if (body.armed !== undefined) patch.armed = body.armed ? '1' : '0';
      if (body.targetOkbBps !== undefined) patch.targetOkbBps = String(clampInt(body.targetOkbBps, 0, 10000, 6000));
      if (body.driftBps !== undefined) patch.driftBps = String(clampInt(body.driftBps, 0, 5000, 500));
      if (body.maxTradesPerDay !== undefined) patch.maxTradesPerDay = String(clampInt(body.maxTradesPerDay, 1, 100, 6));
      if (body.cooldownS !== undefined) patch.cooldownS = String(clampInt(body.cooldownS, 30, 86400, 300));
      if (body.slippageBps !== undefined) patch.slippageBps = String(clampInt(body.slippageBps, 0, 2000, 150));
      if (body.usdtDecimals !== undefined) patch.usdtDecimals = String(clampInt(body.usdtDecimals, 0, 36, 6));
      if (body.swapDeadlineS !== undefined) patch.swapDeadlineS = String(clampInt(body.swapDeadlineS, 60, 3600, 900));
      if (body.maxQueueAgeS !== undefined) patch.maxQueueAgeS = String(clampInt(body.maxQueueAgeS, 60, 86400, 900));
      if (body.maxFeedDeviationBps !== undefined) patch.maxFeedDeviationBps = String(clampInt(body.maxFeedDeviationBps, 0, 5000, 500));
      if (body.minLiquidityUsd !== undefined) patch.minLiquidityUsd = String(Math.max(10000, Number(body.minLiquidityUsd) || 10000));
      if (body.maxPriceImpactBps !== undefined) patch.maxPriceImpactBps = String(clampInt(body.maxPriceImpactBps, 1, 150, 150));
      if (body.requireQuote !== undefined) patch.requireQuote = body.requireQuote ? '1' : '0';
      if (body.minTradeWei !== undefined) {
        try { patch.minTradeWei = BigInt(String(body.minTradeWei)).toString(); } catch { return bad('minTradeWei must be an integer string in wei'); }
      }
      if (body.gasReserveWei !== undefined) {
        try { patch.gasReserveWei = BigInt(String(body.gasReserveWei)).toString(); } catch { return bad('gasReserveWei must be an integer string in wei'); }
      }
      for (const key of ['pathSell', 'pathBuy']) {
        if (body[key] !== undefined) {
          if (!Array.isArray(body[key]) || body[key].some((item) => !isAddress(item))) return bad(`${key} must be an array of addresses`);
          patch[key] = JSON.stringify(body[key].map((item) => String(item).toLowerCase()));
        }
      }

      const keys = await setConfig(db, patch);
      await logRow(db, 'CONFIG', 'Configuration updated', keys.join(', ') || 'no change');
      return json({ ok: true, updated: keys, config: await getConfig(db) });
    }

    if (path === '/api/rules' && method === 'POST') {
      requireOwner();
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') return bad('expected a JSON object');
      const kind = String(body.kind || '').toLowerCase();
      if (!['rebalance', 'price', 'interval'].includes(kind)) return bad('kind must be rebalance, price or interval');
      const name = String(body.name || kind).slice(0, 80);
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      if (kind === 'price') {
        const threshold = Number(params.threshold);
        if (!Number.isFinite(threshold) || threshold <= 0) return bad('price rules need a positive threshold');
        if (!['<=', '>='].includes(params.op)) return bad("price rules need op '<=' or '>='");
        if (!['buy', 'sell'].includes(params.action)) return bad("price rules need action 'buy' or 'sell'");
        if (!Number.isFinite(Number(params.amountUsd)) || Number(params.amountUsd) <= 0) return bad('price rules need a positive amountUsd');
      }
      if (kind === 'interval') {
        if (!Number.isFinite(Number(params.everyS)) || Number(params.everyS) < 60) return bad('interval rules need everyS >= 60');
        if (!['rebalance', 'buy', 'sell'].includes(params.action)) return bad("interval action must be 'rebalance', 'buy' or 'sell'");
        if (params.action !== 'rebalance' && !(Number(params.amountUsd) > 0)) return bad('buy/sell intervals need amountUsd');
      }
      const id = body.id ? String(body.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) : crypto.randomUUID();
      const cooldown = clampInt(body.cooldownS, 30, 86400, 300);
      const enabled = body.enabled === false ? 0 : 1;
      await db.prepare(
        `INSERT INTO rules (id, kind, name, params, enabled, cooldown_s, last_run, runs, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, params = excluded.params, enabled = excluded.enabled, cooldown_s = excluded.cooldown_s`,
      ).bind(id, kind, name, JSON.stringify(params), enabled, cooldown, nowS()).run();
      await logRow(db, 'CONFIG', 'Rule saved', `${name} (${kind})`, { ruleId: id });
      return json({ ok: true, id });
    }

    const ruleMatch = path.match(/^\/api\/rules\/([^/]+)$/);
    if (ruleMatch && method === 'DELETE') {
      requireOwner();
      await db.prepare('DELETE FROM rules WHERE id = ?').bind(ruleMatch[1]).run();
      await logRow(db, 'CONFIG', 'Rule deleted', ruleMatch[1], { ruleId: ruleMatch[1] });
      return json({ ok: true });
    }

    const toggleMatch = path.match(/^\/api\/rules\/([^/]+)\/toggle$/);
    if (toggleMatch && method === 'POST') {
      requireOwner();
      await db.prepare('UPDATE rules SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id = ?').bind(toggleMatch[1]).run();
      const row = await db.prepare('SELECT enabled FROM rules WHERE id = ?').bind(toggleMatch[1]).first();
      return json({ ok: true, enabled: Boolean(row?.enabled) });
    }

    if (path === '/api/arm' && method === 'POST') {
      requireOwner();
      const body = await request.json().catch(() => ({}));
      const armed = body.armed === undefined ? true : Boolean(body.armed);
      await setConfig(db, { armed: armed ? '1' : '0' });
      await logRow(db, 'CONFIG', armed ? 'Kill switch released — daemon may execute' : 'Kill switch engaged — queue only', '');
      return json({ ok: true, armed });
    }

    if (path === '/api/oracle' && method === 'POST') {
      requireOwner();
      const body = await request.json().catch(() => ({}));
      const okb = Number(body.okb);
      if (!Number.isFinite(okb) || okb <= 0) return bad('okb price must be a positive number');
      const usdt = body.usdt === undefined ? 1 : Number(body.usdt);
      await setManualPrice(db, 'okb', okb);
      await setManualPrice(db, 'usdt', Number.isFinite(usdt) && usdt > 0 ? usdt : 1);
      await logRow(db, 'ORACLE', 'Manual price set', `OKB $${okb} · USDT $${usdt}`);
      return json({ ok: true });
    }

    const skipMatch = path.match(/^\/api\/queue\/(\d+)\/skip$/);
    if (skipMatch && method === 'POST') {
      requireOwner();
      await db.prepare("UPDATE queue SET status = 'skipped', reason = 'skipped by owner', updated_at = ? WHERE id = ?")
        .bind(nowS(), Number(skipMatch[1])).run();
      return json({ ok: true });
    }

    if (path === '/api/evidence' && method === 'GET') {
      const snapshot = await statusSnapshot(env);
      const { results: rules } = await db.prepare('SELECT * FROM rules ORDER BY id').all();
      const { results: ticks } = await db.prepare('SELECT * FROM ticks ORDER BY id DESC LIMIT 60').all();
      const { results: queue } = await db.prepare('SELECT id, trade_id AS tradeId, ts, target, value, memo, status, tx_hash AS txHash, reason FROM queue ORDER BY id DESC LIMIT 60').all();
      const { results: log } = await db.prepare('SELECT * FROM log ORDER BY id DESC LIMIT 200').all();
      return json({ product: 'TapeGuardian', generatedAt: new Date().toISOString(), snapshot, rules: rules || [], ticks: ticks || [], queue: queue || [], log: log || [] });
    }
  } catch (error) {
    if (error instanceof Response) return error;
    return bad(error?.message || 'server error', 500);
  }

  return bad('not found', 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      const cors = corsFor(request, env);
      return new Response(JSON.stringify({ error: error?.message || 'unexpected error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors.headers },
      });
    }
  },

  /** Cloudflare cron trigger: this is what makes the agent autonomous. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, 'cron').catch(async (error) => {
      await logRow(env.DB, 'ERROR', 'Cron tick failed', error?.message || String(error)).catch(() => {});
    }));
  },
};
