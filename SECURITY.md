# TapeGuardian — security audit

Scope: `contracts/PolicyCircuit.sol`, `contracts/AgentContainer.sol`, `server/` (Worker daemon +
control plane), `index.html` (published page). Method: manual review of every state-changing path,
the keeper/relayer flow, the auth surface and the trust boundaries between them. No test suite was
run; findings are from code reading.

**Trust model audited:** the *user* owns both contracts through their TapeOut circuit container; the
*keeper* (relayer) is a hot key on the server that can only submit actions the on-chain circuit
approves; the *browser page* is untrusted and public; the *server config* is owner-only.

## Summary

| ID | Severity | Area | One line |
|---|---|---|---|
| C1 | **High** | PolicyCircuit | Daily cap counts only native value — ERC-20 exposure is unbounded |
| C2 | **High** | AgentContainer | Activation/subscription is not enforced on chain |
| C3 | Medium | AgentContainer | Agent execution can spend collected service fees |
| C4 | Medium | PolicyCircuit | No on-chain action-rate limit; `maxTradesPerDay` lives only in the DB |
| S1 | Medium | server | Ticks are unauthenticated when no admin/daemon secret is configured |
| S2 | Medium | server | Oracle sets both trade size and min-out — a bad price is not cross-checked |
| S3 | Medium | server | Hot keeper key in Worker secrets (capped + revocable, but still a hot key) |
| C5 | Low | PolicyCircuit | Calls with <4 bytes of calldata skip the selector whitelist |
| C6 | Low | PolicyCircuit | `recordSpend` can be called without a matching execution (self-grief only) |
| S4 | Low | server | Per-cycle nonce fetched from RPC; multi-node RPCs can collide on step 2 |
| P1 | Low | page | Owner session token in `localStorage` |
| C7 | Info | AgentContainer | Owner can `withdraw` outside the policy — by design, must be documented |

Good properties found: `execute` is `nonReentrant` with checks-effects-interactions ordering; the
policy check, spend record and call are atomic in one transaction; custom errors throughout; no
unbounded loops over user-controlled arrays; parameterised SQL only; session tokens stored as
SHA-256 with expiry; constant-time admin password compare; login rate limited per IP; keccak and
signer self-tests gate live behaviour (wrong crypto degrades to queue-only, never to wrong
transactions); no `innerHTML`/`document.write` in the page and no secret in any published byte.

---

## C1 — High — the daily cap does not bound token exposure

`PolicyCircuit.check()` accumulates only `value` (native OKB). A swap call carries `value = 0` and
an arbitrary ERC-20 `amountIn`, so an approved router call can move the container's **entire USDT
balance** while "spending" zero against `maxPerAction` / `dailyLimit`. The whitelist is the only
thing standing between the keeper and the token balance.

Impact: a compromised or buggy keeper (or a wrong strategy parameter) can swap out all tokens in one
action, inside the limits the user believed were protective.

Fix (pick one, in order of strength):
1. Per-token caps: `mapping(address agent => mapping(address token => uint256)) tokenCapToday` and a
   `checkToken(agent, token, amount)` the container calls before token-moving steps, or
2. Decode the amount in the container for whitelisted swap selectors (`amountIn` is word 0 of
   `swapExactTokensForTokens` / `swapExactTokensForETH`) and count it against the daily cap, or
3. Minimum viable: whitelist exactly one router, exactly two selectors, and keep the token balance of
   the container small relative to what you can afford to lose.

## C2 — High — subscription not enforced on chain

`AgentContainer.isActive()` exists and the server gates on it, but `execute()` never checks it. The
owner or an authorised relayer can keep trading after the 30-day activation expires, so the fee model
is advisory rather than enforced.

Fix: `if (!isActive()) revert NotActive();` at the top of `execute`. If an emergency exit is needed,
route it through the existing owner-only `withdraw`, which is already outside the policy.

## C3 — Medium — agent can spend collected service fees

`activate()` adds to `accruedFees`, and `_available()` excludes it from `withdraw`, but `execute()`
sends `value` from `address(this).balance` with no reservation. Consequences: the agent can trade
away fee revenue; `withdrawFees` then reverts on insufficient balance even though `accruedFees`
says the money is there.

Fix: in `execute`, require `address(this).balance - accruedFees >= value`.

## C4 — Medium — no on-chain rate limit

`maxTradesPerDay` is enforced only in D1 by the daemon. On chain, an authorised keeper may submit as
many actions per day as the *volume* cap allows (many small trades, or gas griefing against the
owner's attention). Add to `PolicyCircuit`: `maxActionsPerDay`, `actionsToday[agent]`, reset in the
same `_day()` window, and return `TOO_MANY_ACTIONS` from `check`.

## S1 — Medium — unauthenticated ticks

`mayTick()` returns `{ ok: true, by: 'unprotected' }` when neither `ADMIN_PASSWORD` nor
`DAEMON_SECRET` is set. Anyone can then drive cycles: they cannot exceed the policy, but they can
burn keeper gas and force trades at times the owner did not choose.

Fix: return `{ ok: false }` unless a valid owner session or the daemon secret is presented. Keep the
rate limiter as defence in depth.

## S2 — Medium — oracle is the single source of truth

The price feed (CoinGecko by default, or `PRICE_URL`) determines both the trade size and
`amountOutMin`. Slippage protection computed from the same number does not protect against a wrong or
manipulated feed — it only protects against on-chain price movement between plan and execution.

Fix: compute `amountOutMin` from on-chain reserves (or a TWAP) for the same pair, and/or require two
independent sources to agree within a tolerance before trading. Keep `slippageBps` as the last line.

## S3 — Medium — hot keeper key

`RELAYER_KEY` is a hot key in Worker secrets. Blast radius is bounded by the circuit and revocation
is one `setRelayer(keeper, false)`, but a Worker compromise yields the keeper. Operationally: keep the
keeper's authorised limits tight, keep only gas money on the keeper address, rotate the key, and treat
`setRelayer` revocation as the incident response step.

## C5 — Low — short calldata bypasses the selector whitelist

`check()` only enforces `allowedFunctions` when `data.length >= 4`. A whitelisted target that you
restricted to one selector still accepts plain value transfers (empty calldata). If that is not
intended, add an explicit `allowPlainTransfer[target]` flag and require `data.length == 0` to satisfy
it.

## C6 — Low — `recordSpend` without execution

An authorised agent can call `recordSpend()` with no execution, inflating its own daily spend and
blocking itself. Self-griefing only, but if other agents can ever be authorised by third parties it
becomes a griefing vector — bind it to a nonce or accept and document it.

## S4 — Low — nonce collisions across steps

`nonceOf()` reads `eth_getTransactionCount(…, 'pending')`. Two steps in one cycle normally get
consecutive nonces, but on a load-balanced RPC the second read can return the same value and the
second transaction replaces the first. Track a local nonce for the cycle (read once, increment per
send).

## P1 — Low — owner token in `localStorage`

The control-plane token is valid for 30 days. The page never injects HTML (verified: no `innerHTML`,
no `document.write`, all dynamic text via `textContent`), so the realistic leak path is a browser
extension or a compromised dependency. Consider `sessionStorage` and a shorter TTL, and rotate on
logout (already implemented).

## C7 — Info — owner escape hatch

`withdraw`/`withdrawFees` are owner-only and bypass the circuit by design. State this in the pitch:
"the policy is unbypassable *for the agent*; the owner can always recover their own funds." Judges
will ask.

---

## Pre-deployment checklist

- [ ] Apply C2 and C3 (small, contained diffs) — both are one-line guards.
- [ ] Set the per-token limits with `setTokenLimit(USDT, maxPerAction, dailyLimit)` before funding the
      container with tokens: a token without a rule is rejected outright (C1 is closed, but the caps
      are the thing that bounds it).
- [ ] Add `maxActionsPerDay` (C4) if the strategy will run unattended for weeks.
- [ ] Set `ADMIN_PASSWORD` **and** `DAEMON_SECRET` (closes S1).
- [ ] Whitelist the minimum: one router, `swapExactETHForTokens`, `swapExactTokensForETH`, `0x095ea7b3`
      for the token — and confirm `setTarget(…, true, false)` (not `anyFunction = true`).
- [ ] Authorise the keeper with `setRelayer`, keep the kill switch on for the first cycles, confirm
      two clean cycles, then fund properly.
- [ ] Keep `setPaused` (on chain, owner-only) as the real kill switch; the server-side switch is
      convenience only.
- [ ] Rotate `RELAYER_KEY` and revoke the old keeper if the Worker or its secrets are ever exposed.

---

# Round 2 — review report of 7 Dec 2026: what was fixed

A second review (`C1..I3` numbering below, different from the audit above) was applied to the code.
Dispositions, in severity order. Anything skipped is stated with the reason it does not apply.

## High

- **C1 — unbounded ERC-20 exposure. Fixed.** `PolicyCircuit` now keeps per-token rules
  (`setTokenLimit(token, maxPerAction, dailyLimit)`, `checkToken(agent, token, amount)`,
  `tokenView(agent, token)`) and the container derives the ERC-20 outflow from the calldata for
  `approve` / `increaseAllowance` / `transfer` / `transferFrom` and refuses the call when the token
  rule rejects it. `recordExecution(agentNonce, value, token, tokenAmount)` books both legs, so the
  native *and* the token budget are enforced in the same transaction as the action. A keeper can now
  move at most `dailyLimit` of each whitelisted token per day, and a token that has no rule is
  rejected outright (`TOKEN_NOT_ALLOWED`, fail-closed). The report's alternative — having the
  container itself approve the spend and record `curSpend()` — was not taken: an on-chain approval
  round-trip per action would add a transaction and a second authorisation path, while the token
  outflow check above already bounds what any whitelisted call can move. Residual, documented in
  README: a whitelisted contract can spend an allowance that exists, which is why the daemon approves
  exactly the consumed amount and resets it to zero, and why the wiring should whitelist selectors
  rather than arbitrary contracts.
- **C2 — approve/limit bookkeeping in the daemon. Fixed.** The approve is for exactly `amountIn`,
  i.e. what the swap consumes, so no residual allowance is left behind; a buy plan now ends with an
  explicit `approve(router, 0)` (an allowance of zero is always policy-approved) and a failed swap is
  followed by the same reset; and one plan (approve + swap + reset) costs **one** unit of
  `maxTradesPerDay` instead of three (`planSent` accounting in `tick`).
- **C3 — wildcard CORS + long-lived bearer token. Fixed.** The Worker no longer answers
  `Access-Control-Allow-Origin: *`: browser origins are allow-listed through the `APP_ORIGINS`
  secret, and with no list configured it refuses browser requests with an actionable 403 (an echoed
  refusal so the page can show the message). `POST /api/tick` lost its "unprotected" mode. Sessions
  are 8 hours, expired rows are deleted on sign-in, and the page keeps the token in `sessionStorage`
  and drops it at expiry (a token left in `localStorage` by an older build is removed).

## Medium

- **M1 — activation gate and fee reserve. Fixed.** `AgentContainer.execute()` starts with
  `if (!isActive()) revert NotActive();` and refuses any `value` above `address(this).balance -
  accruedFees`, so the subscription is enforced on chain and `withdrawFees` cannot be bricked.
- **M2 — `anyFunction` / short calldata. Fixed.** `_selector` is only honoured for `data.length >= 4`;
  a plain transfer now needs the explicit `setPlainTransfer(target, true)` flag, and a target is only
  callable through its whitelisted selectors otherwise.
- **M3 — no ownership transfer. Fixed.** `owner` is mutable with a two-step
  `transferOwner(next)` / `acceptOwner()` (both event-logged); `transferOwner` is owner-only,
  `acceptOwner` only answers the pending owner, so control can follow a circuit container without
  risking a typo-induced orphan.
- **M4 — min-out from the same feed that sizes the trade. Fixed.** `minOutFromPool()` asks the router
  (`getAmountsOut`) and uses the *lower* of pool quote and feed; a feed that deviates from the pool by
  more than `maxFeedDeviationBps` (default 500) refuses the trade, and `requireQuote` (default on)
  refuses to size from the feed alone when the router cannot be quoted.
- **M5 — queue flooding and stuck rows. Fixed.** `expireQueue()` drops pending rows older than
  `maxQueueAgeS` (900 s) with a reason, `enqueue()` deduplicates against the live window so a failing
  RPC cannot pile up identical rows, and pending rows count against `tradesLastDay()` so queued work
  consumes the daily budget. `drainQueue()` runs at the start of every cycle: it re-checks each
  pending row against the circuit on chain and submits the ones still approved, so a row queued while
  the keeper was missing or the kill switch was on is not left pending forever — and it can never
  bypass a policy change made in the meantime, because the verdict is re-taken before sending.
- **M6 — "the approved action is not bound to what gets broadcast". Fixed on the daemon side.** The
  circuit cannot authorise an action by digest, because it re-checks every call inside `execute()`
  (see M1): a stale plan simply reverts, so the caps bound the keeper either way. What was genuinely
  missing was the daemon's own consistency: `actionDigest(container, step)` is now captured the
  moment the circuit approves, and re-derived immediately before signing together with a rebuild of
  the container calldata. A mutated `target`/`value`/`data` (bug, prototype pollution, a race in a
  resumed tick) is refused with `approved action changed between simulation and signing` instead of
  being signed. `containerSimulate()` still runs first, so the log records what the chain will decide.

## Low

- **L1 — `recordSpend` could inflate the counter. Fixed.** It is now `recordExecution`, bound to the
  container's incrementing nonce (`lastNonce[agent] + 1`), so a spend cannot be recorded twice,
  out of order, or without the execution that books it.
- **L2 — commitment omitted the whitelists. Fixed.** `commitment` now covers a rolling hash of the
  target/selector whitelist, the plain-transfer set and the agent set, plus the token rules, so it
  changes whenever any rule changes and the page can recompute it.
- **L3 — legacy transactions only. Fixed.** The keeper signs EIP-1559 (`signDynamicFee`, type 2) with
  `eth_maxPriorityFeePerGas` and a 2× base-fee ceiling, and falls back to a legacy signature only if
  the node rejects type 2, so a stuck submission can be replaced.
- **L4 — `/api/evidence` auth mismatch. Skipped, not a defect.** `/api/evidence` is intentionally
  public (judges' bundle) and does not call `requireOwner()`; the README is therefore correct. Thrown
  `Response` objects are already returned unchanged by the `catch`, so the "500 with a terse message"
  path does not exist.
- **L5 — no chain check before sending. Fixed.** `ensureChain()` re-reads `eth_chainId` before every
  `eth_sendTransaction` and asks the wallet to switch, failing with a clear message if it will not.
  The generic ABI panel now shows target, function, selector and value in a confirmation before it
  sends.
- **L6 — unverified config and RPC URL. Fixed.** `APP_CONFIG` entries must be well-formed addresses or
  they are dropped with a logged warning; each address is checked with `eth_getCode` on the configured
  chain and flagged when no code is there; a stored RPC URL is only accepted when it is a plain https
  endpoint (no credentials), otherwise it is deleted.

## Info

- **I1 — owner token in `localStorage`. Fixed** together with C3: `sessionStorage`, 8-hour expiry, and
  the token is discarded when the server's expiry has passed.
- **I2 — README over-claimed. Fixed.** The safety-property section was rewritten to say what the code
  now enforces and a separate "known limits" block states what it does not (a leaked keeper key can
  still move up to the caps; the daemon is only as available as the cron; the owner can always
  withdraw their own funds).
- **I3 — single keyless price feed. Fixed.** A second independent feed (OKX ticker) is fetched and
  compared; a disagreement above 200 bps marks the price untrustworthy and the tick refuses to trade.

Compilation after these changes: `AgentContainer` and `PolicyCircuit` build clean with solc 0.8.24.

