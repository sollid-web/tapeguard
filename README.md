# TapeGuardian — autonomous agentic wallet on X Layer

## In plain words (what it is, and why you would want it)

TapeGuardian is an **autonomous agent** — a program that trades for you without you watching. The
usual way to build one is to hand a bot your private key. That key is unlimited power: one leak drains
the wallet, and afterwards there is no way to prove what the bot was allowed to do.

TapeGuardian replaces that trust with rules enforced on the blockchain. You write the rules once — how
much may move per trade, how much per day, which exchange address is allowed, how far your balance may
drift from your target. The agent's account holds your funds but has no private key: the only way money
leaves is a call the rulebook approves, in the same transaction as the trade. The agent runs on a
server, so it keeps working while you sleep, and you can stop it in the app or freeze it on-chain.

What it will never do: exceed your per-trade or daily limit, touch an exchange or token you did not
allow, spend the fees it collected for you, keep going after you stop it, or widen its own limits.
What it cannot promise: profit. It is a trader, not a savings account — the limits cap the damage, not
the risk.

## The three layers, technically

| Layer | What it is | Where it lives |
|---|---|---|
| **Policy circuit** | Immutable rule engine: per-action limit, daily volume cap, target + function allowlist, pause flag. | `contracts/PolicyCircuit.sol` — a TapeOut circuit, on X Layer |
| **Container** | The agent's account. Holds the funds, is the address that executes, has no private key. | `contracts/AgentContainer.sol` — bound to the user's TapeOut circuit container |
| **Daemon** | Always-on process that watches triggers, asks the circuit, and submits the approved transaction. | `server/` — a Cloudflare Worker with D1, cron-driven |

The page in `index.html` is only the window: the daemon keeps working when the tab is closed.

## Is it really autonomous?

There are two loops and only one of them is autonomous:

- **Browser loop (`Daemon` tab)** — a local simulation. Great for a demo, but it dies with the tab.
  It is *not* autonomy.
- **Server loop (`Autonomy` tab)** — `server/index.js` runs the same rules on Cloudflare:
  - `scheduled()` is called by a cron trigger (add one: Worker → Settings → Triggers → Cron, every
    minute), or any external scheduler can `POST /api/tick` with `x-daemon-secret`.
  - Every cycle reads the chain, values the portfolio, evaluates the rules, asks the on-chain policy
    circuit, and submits the approved call through the container.
  - It writes every decision to D1, so "is it really running?" is answerable from outside
    (`GET /api/status`, `GET /api/log`).

Nobody has to be present for a trade or a rebalance.

## How execution works without a user (the keeper role)

The container's `execute()` accepts **the owner** (the user's TapeOut circuit container) **or an
authorised relayer**. The daemon is that relayer:

- It signs with `RELAYER_KEY`, a keeper key that lives only in the Worker's secrets.
- It can *only* push an action the policy circuit approves **at that moment**, inside the per-action
  and daily limits.
- It **cannot** withdraw, change the policy, unpause the agent, move the activation fee, or authorise
  another relayer. Those are all `onlyOwner`.
- Losing the key stops the agent. It never loses the money. Revoking it is one `setRelayer(x,false)`.

This is the whole point: autonomous execution without custody. Compare with a bot that holds a funded
private key — one leak, treasury gone.

## Rebalancing (the real problem it solves)

The strategy keeps a target portfolio weight and corrects drift automatically:

1. Read `OKB` balance (`eth_getBalance`) and `USDT` balance (`balanceOf`).
2. Value both with the price oracle (`PRICE_URL`, or CoinGecko, or a manual price set from the panel;
   the last known price is cached in D1 so a feed outage does not brick the agent).
3. Compute the current OKB weight. If it leaves `target ± drift`:
   - too much OKB → `swapExactETHForTokens` (sell OKB for USDT),
   - too little OKB → `approve` + `swapExactTokensForETH` (buy OKB with USDT).
4. Every step is an `execute()` call on the container, so the circuit checks it first: is the router
   whitelisted, is the selector allowed, is this inside the per-action and daily caps, is the agent
   paused?

Also bounded by the daemon side: `maxTradesPerDay`, per-rule cooldown, `minTradeWei`, gas reserve, and
a global kill switch (`armed`). Orders carry a deadline (`swapDeadlineS`) and slippage bound
(`slippageBps`), so a stale decision does not execute at a bad price.

## Rule kinds

| Kind | Fires when | Params |
|---|---|---|
| `rebalance` | drift leaves the band | — (uses the global strategy) |
| `price` | `OKB/USD <= or >= threshold` | `op`, `threshold`, `action` (`buy`/`sell`), `amountUsd` |
| `interval` | every `everyS` seconds | `everyS`, `action` (`rebalance`/`buy`/`sell`), `amountUsd` |

## One-time wiring (all `onlyOwner`, routed through your TapeOut circuit container)

1. Deploy `PolicyCircuit` and `AgentContainer` from the app (the app passes your circuit container as
   the first constructor argument — never make the deployer wallet the owner).
2. `AgentContainer.setPolicy(policyAddress)`.
3. `PolicyCircuit.setAgent(containerAddress, true)`.
4. `PolicyCircuit.setLimits(maxPerActionWei, dailyLimitWei)` to fit the strategy.
5. `PolicyCircuit.setTarget(router, true, false)` and
   `PolicyCircuit.setFunction(router, <swap selector>, true)`; repeat `setTarget`/`setFunction` for the
   USDT token (`approve` selector) if you buy back.
6. `AgentContainer.setRelayer(<keeper address>, true)` — the address is shown in the Autonomy tab and
   the panel builds the calldata for you.
7. Fund the container (plain transfer), then `activate()` (permissionless, also from the page) if you
   use the activation-fee model.

## Server secrets (server view → Secrets)

| Secret | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Unlocks the control plane in the Autonomy tab. Never in any file. |
| `RELAYER_KEY` | Keeper key of the address you authorised with `setRelayer`. Holds no funds. |
| `RPC_URL` | X Layer RPC endpoint (a keyed endpoint stays server-side, never in the page). |
| `DAEMON_SECRET` | Shared secret for external cron hits of `POST /api/tick`. |
| `PRICE_URL` | Optional JSON feed `{"okb":42.5,"usdt":1.0}` instead of CoinGecko. |
| `APP_ORIGINS` | **Required for browser access.** Comma-separated list of the origins this dashboard is served from, e.g. `https://your-page.gateway`. Without it the Worker refuses every browser request (403) instead of answering `Access-Control-Allow-Origin: *` to the whole internet. `curl`, cron and the page's server-side callers send no `Origin` and are unaffected. |

The control plane therefore needs one more step after publishing: copy the URL you published to,
paste it into `APP_ORIGINS`, and redeploy. `GET /api/health` reports `cors.locked` and the accepted
origins so you can check it from a browser.

If `RELAYER_KEY` is missing the daemon still decides, checks the circuit and **queues** the approved
calldata — it just cannot submit. Nothing is lost: the next cycle re-validates every queued row against
the circuit on chain and sends it as soon as a keeper is configured (or the kill switch is released),
and a row older than `maxQueueAgeS` expires instead of being sent at a stale price.

## API (all CORS-enabled, JSON)

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | — | keccak + signer self-tests, which secrets are configured |
| `GET /api/status` | — | daemon state, holdings, drift, circuit, agent, relayer, last log |
| `GET /api/log`, `GET /api/queue` | — | audit trail |
| `POST /api/tick` | owner or daemon secret | force one cycle |
| `POST /api/login` | password | exchange `ADMIN_PASSWORD` for a session token |
| `PUT /api/config` | owner | strategy, addresses, limits |
| `POST /api/rules`, `DELETE /api/rules/:id` | owner | manage rules |
| `POST /api/arm` | owner | kill switch |
| `POST /api/oracle` | owner | manual price |
| `GET /api/evidence` | — | full JSON bundle for judges |
| `POST /api/rpc` | — (read-only) | JSON-RPC proxy for page reads without a wallet: allow-listed read methods only, ≤20 calls per batch, `eth_getLogs` limited to 10 000 blocks. Writes never pass. |

Session tokens are random 32 bytes; only their SHA-256 is stored. Login is rate limited per IP, the
session lives 8 hours, and the page keeps it in `sessionStorage` so it dies with the tab. Browser
requests are only served for origins listed in `APP_ORIGINS`; `POST /api/tick` always needs the owner
session or `DAEMON_SECRET` (there is no "unprotected" mode).

## Page tabs

- **Start here** — the plain-language landing: what this is, why you would use it, how it works in four
  steps, what it will never do, a glossary, and honest expectations. Written for non-technical readers.
- **Overview** — balance, 24h volume against the cap, prices, activity feed, evidence export.
- **Policy circuit** — circuit ID, commitment, limits, allowlist, pause, and a rule-by-rule simulator.
- **Daemon** — the *browser* loop: triggers, decision log, demo buttons. Clearly a simulation.
- **Autonomy** — the real thing: server status, kill switch, owner login, strategy form, rules,
  keeper address + `setRelayer` calldata, and the server decision log.
- **Container / Revenue / Contract / Docs** — account view, fee model, live ABI panel, runbook.

## Demo script (≤ 3 minutes)

- **0:00–0:30 Problem.** "An agent that trades for you needs a key. A key is unlimited power. One leak
  and the treasury is gone — and if it needs you to press go, it is not an agent."
- **0:30–1:10 Policy circuit.** Show limits, allowlist, pause. Evaluate a normal action and a rogue one.
- **1:10–1:40 Container.** The account that holds funds; no key; every action policy-checked.
- **1:40–2:20 Autonomy.** Open the Autonomy tab: daemon ONLINE from cron, keeper authorised, drift band
  and target weight. Engage the kill switch, release it. Show the server log with timestamps from
  before the tab was opened — proof it ran without you.
- **2:20–2:45 Rebalance.** Show current weight outside the band, the built swap, the circuit check, the
  execution hash on the explorer.
- **2:45–3:00 TapeOut.** Circuit ID + processor address visible; keeper cannot withdraw; fees flow to
  the container you control.

## Safety properties

What holds **today**, on chain, and is what the page shows:

- No key, password or keyed RPC URL in the published page; secrets live in the Worker.
- `AgentContainer.execute()` re-checks everything atomically: kill switch, activation window, native
  per-action/daily limits, **per-token per-action/daily limits** (so a `value = 0` swap or `approve`
  cannot move the whole ERC-20 balance), plain-transfer switch, target and selector whitelist.
- Service fees (`accruedFees`) are reserved: an execution can never spend fee revenue, and
  `withdrawFees` cannot be bricked by a trade.
- Every execution is recorded against the container's own incrementing nonce, so a leaked keeper key
  cannot replay, inflate or back-date a spend, and is revoked with one `setRelayer(keeper, false)`.
- The daemon fingerprints the approved action and re-derives it immediately before signing, so the
  envelope it broadcasts is byte-identical to the call the circuit approved.
- Control of the container is handover-able in two steps (`transferOwner`, then `acceptOwner` from the
  new circuit container); `acceptOwner` answers only the pending owner, so a typo cannot orphan it.
- The circuit pause stops trading on chain even if the server is fully compromised; the kill switch
  stops the daemon and keeps it observing.
- The circuit commitment is a fingerprint over limits **and** both whitelists plus the token rules, so
  any rule swap changes the value the page displays.
- The owner token is a random 32-byte value stored only as a SHA-256 hash on the server, kept in
  `sessionStorage` (not `localStorage`), expires in 8 hours, and is only answered to an allow-listed
  origin (`APP_ORIGINS`).
- The daemon's `amountOutMin` comes from the pool quote, not from the price feed, and a feed that
  disagrees with the pool or with a second independent source stops trading instead of sizing it.
- Trades are submitted as EIP-1559 transactions, so a stuck keeper transaction can be replaced
  instead of blocking the queue.
- All dynamic text is rendered with `textContent`; `localStorage`/`sessionStorage` access is wrapped in try/catch.

Known limits, stated instead of implied:

- A whitelisted contract can spend any ERC-20 allowance that exists, so the daemon approves exactly
  the amount the swap consumes and resets the allowance to zero afterwards; whitelist the router's
  swap selectors rather than arbitrary contracts, and never turn on `anyFunction` for a target.
- A leaked keeper key can still move up to the circuit's caps each day — that is the point of the caps,
  not a bug. Revoke it with `setRelayer(keeper, false)`.
- The keeper holds gas only; top it up, it cannot withdraw or reconfigure anything.
- The daemon is only as available as Cloudflare's cron; a missed cycle costs time, never funds.
