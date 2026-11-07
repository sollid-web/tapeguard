-- TapeGuardian daemon schema (Cloudflare D1).
-- Every statement is safe to run again on every deploy.

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Rule table: what the daemon watches and what it does when the condition holds.
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- rebalance | price | interval
  name TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  cooldown_s INTEGER NOT NULL DEFAULT 300,
  last_run INTEGER NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rules_enabled ON rules (enabled, kind);

-- Every decision, approved or not. This is the audit trail.
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- TICK | ORACLE | TRIGGER | POLICY | REJECT | EXEC | QUEUE | CONFIG | ERROR
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  tx_hash TEXT,
  rule_id TEXT
);
CREATE INDEX IF NOT EXISTS log_ts ON log (ts DESC);

-- One row per daemon cycle, so "is it really running?" is answerable from outside.
CREATE TABLE IF NOT EXISTS ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'cron',
  decisions INTEGER NOT NULL DEFAULT 0,
  executions INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ticks_ts ON ticks (ts DESC);

-- Approved actions waiting for an executor (no relayer key configured yet, or the
-- kill switch / activation fee stops automatic submission).
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  rule_id TEXT,
  target TEXT NOT NULL,
  value TEXT NOT NULL,
  data TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed | skipped
  tx_hash TEXT,
  reason TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS queue_status ON queue (status, ts DESC);

-- Owner sessions: only the SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT ''
);

-- Login / unlock attempt counters, per IP and per password.
CREATE TABLE IF NOT EXISTS attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- Last known prices, used when the oracle is unreachable.
CREATE TABLE IF NOT EXISTS prices (
  asset TEXT PRIMARY KEY,
  usd REAL NOT NULL,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'unknown'
);

-- Small key/value state: tick lock and counters.
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL
);