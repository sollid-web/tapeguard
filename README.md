# TapeGuard — autonomous agent wallet guarded by a TapeOut circuit on X Layer

TapeGuard lets a trading agent run your X Layer portfolio 24/7 without ever holding your key.
Every action the agent takes is judged on-chain twice, in the same transaction: by a Solidity
safety floor, and by a **guard circuit taped out on TapeOut** whose `eval()` gives the final verdict.

**Dashboard → https://tapeguard.tapeguard.workers.dev** · status: [`/api/status`](https://tapeguard.tapeguard.workers.dev/api/status) · evidence: [`/api/evidence`](https://tapeguard.tapeguard.workers.dev/api/evidence)

| | X Layer mainnet (chain 196) |
|---|---|
| AgentContainer | see [`deployments/196.json`](deployments/196.json) |
| PolicyCircuit | see [`deployments/196.json`](deployments/196.json) |
| TapeOut processor (circuits) + guard circuit id | see [`deployments/196.json`](deployments/196.json) → `tapeout` (filled in by the v2 launch, [`LAUNCH.md`](LAUNCH.md)) |
| TapeOut factory / opener | `0x1f09DAeFA827f02CBb40967cc91b259763760761` / `0x536adD8F30f03b69f6fbF29d425A816A0dC50106` |

---

## The problem

To let a bot trade for you today you hand it a private key: unlimited, permanent power over
everything in the wallet. One leaked server variable and the treasury is gone, and afterwards nobody
can prove what the bot was *allowed* to do.

## How TapeGuard solves it

```
 keeper (Worker)                X Layer mainnet
 ───────────────               ─────────────────────────────────────────────────────────
 decide trade  ──sign──▶  AgentContainer.execute(target, value, data)
 (no key)       signer          │
                Worker          ├─▶ PolicyCircuit.check()   ── Solidity safety floor
                (key,           │        │                     (allowlists, caps, recipient = self,
                 execute()      │        │                      min-out > 0, nonce, pause)
                 only)          │        └─▶ TapeOut circuits.eval(guardId, factBits)
                                │                 17-NAND guard circuit = final verdict
                                ├─▶ PolicyCircuit.recordExecution()   (caps re-checked)
                                └─▶ DEX router (output paid to the container itself)
```

1. **The agent never holds your key.** Funds sit in a keyless `AgentContainer`. The keeper's key
   lives in a separate signer Worker ([`signer/`](signer/)) that will only sign
   `AgentContainer.execute(...)` on chain 196 — nothing else, not even a plain transfer.
2. **The rules are on-chain.** `PolicyCircuit` enforces the safety floor: per-action and daily caps
   (native and per token), target/function allowlists, a pause switch, and — new in v2 — every DEX
   swap must pay its output **to the container** with a **non-zero minimum output**.
3. **The verdict is a TapeOut circuit.** Each action is reduced to 10 fact bits; the taped-out guard
   circuit computes the approval. It also carries a rule that exists *only* in the circuit: once half
   of the day's budget is spent, large trades are refused (small steps only).

### The TapeOut guard circuit

| bit | fact | bit | fact |
|---|---|---|---|
| 0 | not paused | 5 | within per-action cap |
| 1 | agent authorised | 6 | within daily cap |
| 2 | target allowed | 7 | within daily action count |
| 3 | function allowed | 8 | large action (> ½ per-action cap) |
| 4 | recipient safe (swap pays the agent, min-out > 0) | 9 | half of today's budget used |

`APPROVE = bits0..7 all set AND NOT(bit8 AND bit9)` — 17 NAND gates, compiled by
[`tapeout/guard-circuit.mjs`](tapeout/guard-circuit.mjs) into TapeOut's netlist format and verified on
all 1,024 inputs (JS simulator, Solidity evaluator, and — after the launch — the live circuit through
[`foundry/test/TapeOutFork.t.sol`](foundry/test/TapeOutFork.t.sol)).

**Fail-closed by design.** TapeOut's contracts are upgradeable and unaudited, so the floor is checked
first and the circuit can only *add* refusals: an outage returns `CIRCUIT_UNAVAILABLE`, a hostile
upgrade that approves everything still cannot pass an action the floor rejected (both tested). The
owner can unlink the circuit as an escape hatch; the link is part of the on-chain policy commitment.

**Owned by a TapeOut container.** Both contracts support two-step ownership handover, and the launch
script can open the guard circuit's own TapeOut container (its ERC-6551 account) and hand ownership
to it — so whoever holds the circuit NFT controls the agent.

## Business model (on-chain)

`TapeGuardFactory` creates a guarded agent in one transaction (policy + container, wired to the
guard circuit, Uniswap V2 and the keeper, activated, funded, handed to the user). Its agents carry
terms fixed at deployment:

- **subscription:** 0.02 OKB per 30 days, paid to the TapeGuard treasury by `activate()`;
- **volume fee:** 0.10% of executed OKB volume (`ProtocolFeePaid`), hard-capped at 0.50% in the
  contract, so a leaked keeper cannot drain the agent through fees.

Self-hosted agents (`treasury = 0`) pay no protocol fee.

## Who it is for

| User | Pain | What TapeGuard gives them |
|---|---|---|
| OKB/USDT holders on X Layer | want a target allocation kept without watching charts or sharing a key | an agent that physically cannot exceed the limits they set |
| Small funds / DAOs | need an autonomous keeper with provable authorisation | on-chain policy + commitment hash + a TapeOut circuit anyone can `eval()` |
| X Layer builders | need a safe execution layer for their own agents | reusable guard circuits on TapeOut (`REF`-able by other circuits) |

## Verify it yourself

```sh
npm test                                   # Worker + guard circuit + frontend encoder (28 tests)
(cd signer && npm ci && npm test)          # signer refuses anything but execute() (7 tests)
cd foundry && forge fmt --check && forge test   # contracts (48 tests)
# after the launch, against the real TapeOut circuit on mainnet:
TAPEOUT_CIRCUITS=0x... TAPEOUT_CIRCUIT_ID=n forge test --match-contract TapeOutForkTest --fork-url https://rpc.xlayer.tech -vv
# the trading venue on real liquidity (full OKB -> USDT -> OKB round trip through TapeGuard):
DEX_FORK=1 forge test --match-contract DexForkTest --fork-url https://rpc.xlayer.tech -vv
```

How to launch v2 on mainnet: **[`LAUNCH.md`](LAUNCH.md)**. Hackathon submission pack and demo
script: **[`SUBMISSION.md`](SUBMISSION.md)**.

## In plain words (what it is, and why you would want it)

TapeGuard is an **autonomous agent** — a program that trades for you without you watching. The
usual way to build one is to hand a bot your private key. That key is unlimited power: one leak drains
the wallet, and afterwards there is no way to prove what the bot was allowed to do.

TapeGuard replaces that trust with rules enforced on the blockchain. You write the rules once — how
much may move per trade, how much per day, which exchange address is allowed, how far your balance may
drift from your target. The agent's account holds your funds but has no private key: the only way money
leaves is a call the rulebook approves, in the same transaction as the trade. The agent runs on a
server, so it keeps working while you sleep, and you can stop it in the app or freeze it on-chain.

What it will never do: exceed your per-trade or daily limit, touch an exchange or token you did not
allow, spend the fees it collected for you, keep going after you stop it, or widen its own limits.
What it cannot promise: profit. It is a trader, not a savings account — the limits cap the damage, not
the risk.

An always-on crypto trading agent with on-chain limits. A compromised keeper or signer may still
execute policy-approved trades and cause losses within the configured limits.

💡 The Problem

To trade automatically, a bot normally needs access to your private key. That key represents unlimited power: one leak or server compromise can drain your entire treasury. Furthermore, traditional bots operate in a black box—you can never explicitly prove on-chain what the bot was actually authorized to do versus what it chose to do.

🛡️ Our Solution

TapeGuard separates transaction signing from the Worker and enforces execution rules in the
Policy Circuit on chain. The contract owner is fixed at deployment, but policy settings remain
owner-configurable and are not immutable.
The background Worker requests signatures from a separate signer service and broadcasts approved
transactions. On-chain checks restrict the relayer to configured actions and limits; a compromised
Worker or signer can still execute allowed trades and cause losses within those limits. The
AgentContainer has no private key, but it does hold the assets being managed.

🏗️ Core Architecture & How It Works

   ┌─────────────────┐       Queries       ┌──────────────────┐
   │ Always-On Server│ ──────────────────> │  Policy Circuit  │
   │ (Cloudflare SDK)│                     │ (On-Chain Rules) │
   └────────┬────────┘                     └────────┬─────────┘
            │                                       │
     Submits│Approved                               │Validates Inside
    Proposal│Transaction                            │Same Tx
            ▼                                       ▼
   ┌─────────────────┐                     ┌──────────────────┐
   │   Keeper Key    │ ──────────────────> │ Agent Container  │
   │(Low-power Relay)│                     │(Keyless Account) │
   └─────────────────┘                     └────────┬─────────┘
                                                    │ Executes
                                                    ▼
                                           [Whitelisted DEX Swap]
1. Policy Layer (PolicyCircuit): A non-upgradeable smart-contract rule engine deployed on X Layer. Ownership moves only by a two-step handover (e.g. to a TapeOut container); policy data such as limits, allowlists, and pause state remain owner-configurable. It dictates the maximum allowed size per transaction, a rolling 24-hour volume cap, whitelist expiration, and authorized target/selector addresses (e.g., specific DEX routers). It features a pure check() view function allowing cost-free transaction dry-runs.
2. Execution Layer (AgentContainer): A keyless smart contract account that holds your assets. It contains no private key. It handles requests by calling the Policy Circuit inside the transaction window, ensuring the rule check and the trade succeed or fail together.
3. The Autonomous Daemon: An always-on Cloudflare Worker triggered by a minute-by-minute cron job. It monitors market conditions (e.g., OKB/USD price drift), checks proposed calls against the policy, asks the external signer to sign the transaction, and broadcasts it.

🛠️ X Layer Integration & Tech Stack

• Blockchain Network: X Layer mainnet, chain ID 196. TapeOut has no testnet, so the contracts, the guard circuit and the Worker all run on mainnet (rehearse on an anvil fork first, see LAUNCH.md).
• Smart Contracts: Formulated in Solidity using robust, security-first access control boundaries to prevent unauthorized parameter overrides.
• Off-Chain Automation: Built using Cloudflare Workers for high-availability, low-latency background cron execution and edge-routed state management.
• Front-End & Tools: A highly responsive dashboard featuring a comprehensive Policy Simulator, live activity/decision logs, single-click JSON evidence exporting, and an integrated deployment control plane featuring an on-chain kill switch.

🌟 Key Features & Benefits

• 🌙 24/7 Hands-Free Rebalancing: Keeps your asset weights tightly aligned to target percentages (e.g., 60% OKB / 40% USDT) while you sleep.
• 🛑 Dual-Layer Circuit Breakers: Pause your daemon with one click in the web interface, or engage a permanent on-chain kill switch directly from your owner wallet if your server infrastructure is completely compromised.
• 🧾 Absolute Transparency: Every market tick, execution approval, and contract rejection is logged in plain English, generating clear, cryptographic proof of the agent's behavior.
• 📈 Built-In Commercial Model: Supports configurable activation and performance fees (in basis points) routed automatically back to the container under the user's explicit control.
## The three layers, technically

| Layer | What it is | Where it lives |
|---|---|---|
| **Policy circuit** | Non-upgradeable owner-controlled rule engine: per-action limit, daily volume cap, target + function allowlist, pause flag. | `contracts/PolicyCircuit.sol` — a TapeOut circuit, on X Layer |
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

- It asks a separate HTTPS signer service to sign transactions. The private key is not stored in
  the Worker; the Worker broadcasts the returned signed transaction through its configured RPC.
- It can *only* push an action the policy circuit approves **at that moment**, inside the per-action
  and daily limits.
- It **cannot** withdraw, change the policy, unpause the agent, move the activation fee, or authorise
  another relayer. Those are all `onlyOwner`.
- Since policy v2 it also **cannot redirect swap output**: every router swap must name the container
  as recipient and carry a non-zero minimum output (`RECIPIENT_NOT_AGENT`, `NO_MIN_OUT`). v1 allowed a
  leaked keeper to swap the daily budget to itself; the regression test is
  `testKeeperCannotRedirectSwapOutput`.
- The signer Worker refuses to sign anything except `AgentContainer.execute(...)` on chain 196.
- The relayer has no owner privileges, but a compromised signer can still execute actions allowed by
  the on-chain policy. Revocation remains owner-controlled through `setRelayer(x,false)`.

This separates transaction-key custody from the Worker; it does not remove the need to secure the
signer or the on-chain execution policy.

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

The daemon's `maxPriceImpactBps` guard reports **fee-excluded constant-product curve impact**, not
total execution shortfall. For an exact-input trade it compares the fee-free constant-product output
at the trade size with the infinitesimal mid-price output from the same input and current input-side
reserve: `impact = amountIn / (reserveIn + amountIn)`. The reported basis points are rounded up to
avoid understating impact near the configured threshold. This is computed in the input token's raw units,
so token decimals cancel; the reserve is selected according to trade direction. Pool/router fees are
intentionally excluded from this metric. Separately, `amountOutMin` is based on the lower of the
router quote and feed-derived output, then reduced by `slippageBps`; the feed/pool deviation guard
also applies. Automated trading always requires a successful router quote: `requireQuote` cannot be
disabled, and a missing/zero quote rejects the trade. The impact guard runs before quote handling, so
no quote configuration or failure path skips it. This is a reserve snapshot estimate for the
supported two-token constant-product pool, not a guarantee of realized execution price or a TWAP.
The guard threshold is 1–150 bps.

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

## Server configuration (server view → Variables and Secrets)

| Name | Type | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Secret | Unlocks the control plane in the Autonomy tab. Never in any file. |
| `SIGNER_URL` | Variable | Base HTTPS URL for the external transaction-signing service. |
| `SIGNER_TOKEN` | Secret | Bearer credential for the external signer. |
| `RELAYER_ADDRESS` | Variable | Public address authorized with `setRelayer` on the container. |
| `RPC_URL` | Secret | X Layer RPC endpoint (a keyed endpoint stays server-side, never in the page). |
| `DAEMON_SECRET` | Secret | Shared secret for external cron hits of `POST /api/tick`. |
| `PRICE_URL` | Secret | Optional JSON feed `{"okb":42.5,"usdt":1.0}` instead of CoinGecko. |
| `APP_ORIGINS` | Variable | **Required for browser access.** Comma-separated list of the origins this dashboard is served from, e.g. `https://your-page.gateway`. Without it the Worker refuses every browser request (403) instead of answering `Access-Control-Allow-Origin: *` to the whole internet. `curl`, cron and the page's server-side callers send no `Origin` and are unaffected. |

The signer service must implement authenticated `GET /health` (returning
`{"ok":true,"address":"0x..."}`) and `POST /sign`. The signing request body is
`{"type":"eip1559"|"legacy","transaction":{...}}`, with transaction quantities encoded as hex strings;
the response is `{"address":"0x...","rawTransaction":"0x..."}`. The Worker verifies the signer's
reported address and raw-transaction encoding, then broadcasts the signed bytes. The signer must
independently restrict chain IDs, destination container addresses, outer transaction value, allowed
calldata, gas and fee bounds, and access to the signing operation. A generic unrestricted signing
oracle would only relocate the hot key, not fix the security risk.

The control plane therefore needs one more step after publishing: copy the URL you published to,
paste it into `APP_ORIGINS`, and redeploy. `GET /api/health` reports `cors.locked` and the accepted
origins so you can check it from a browser.

If the signer is missing or unavailable the daemon still decides, checks the circuit and **queues** the approved
calldata — it just cannot submit. Nothing is lost: the next cycle re-validates every queued row against
the circuit on chain and sends it as soon as the signer is available (or the kill switch is released),
and a row older than `maxQueueAgeS` expires instead of being sent at a stale price.

### Signer key rotation and incident response

The relayer private key must remain in the external signing system, never in Worker variables,
secrets, source control, `.env` files, logs, or this runbook. Restrict signing-service access, fund the
relayer only with gas, monitor container activity, and retain owner-controlled on-chain revocation.
For planned rotation, create the replacement key in the signing system, authorize its address with
`AgentContainer.setRelayer(newAddress, true)`, update `RELAYER_ADDRESS` and the signer's configured
identity, verify `/api/health` and `/api/status` report the expected authorized address, then revoke
the old address with `setRelayer(oldAddress, false)`. For suspected compromise, pause the agent and
revoke the old relayer immediately; configure and verify the replacement before unpausing. The
repository contains the Worker-side signer protocol only; no signer service, key rotation, or live
Cloudflare configuration has been deployed or verified.

## API (all CORS-enabled, JSON)

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | — | keccak self-test, external signer availability, and configured bindings |
| `GET /api/status` | — | daemon state, holdings, drift, circuit, agent, relayer, last log |
| `GET /api/log`, `GET /api/queue` | — | audit trail |
| `POST /api/tick` | owner or daemon secret | force one cycle |
| `POST /api/login` | password | exchange `ADMIN_PASSWORD` for a session token |
| `PUT /api/config` | owner | strategy, addresses, limits |
| `POST /api/rules`, `DELETE /api/rules/:id` | owner | manage rules |
| `POST /api/arm` | owner | kill switch |
| `POST /api/oracle` | owner | manual price |
| `GET /api/evidence` | — | full JSON bundle for judges |
| `POST /api/rpc` | — (read-only) | JSON-RPC proxy for page reads without a wallet: allow-listed read methods only, ≤20 calls per batch, `eth_getLogs` limited to 5,000 inclusive blocks. Writes never pass. |

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
- **2:45–3:00 TapeOut.** Processor address + guard circuit id; call `eval()` on the live circuit with a
  "large trade, budget half spent" fact vector and watch it refuse what the Solidity floor allowed.

## Safety properties

What holds **today**, on chain, and is what the page shows:

- No key, password or keyed RPC URL in the published page; secrets live in the Worker.
- `AgentContainer.execute()` re-checks everything atomically: kill switch, activation window, native
  per-action/daily limits, **per-token per-action/daily limits** (so a `value = 0` swap or `approve`
  cannot move the whole ERC-20 balance), plain-transfer switch, target and selector whitelist.
- Service fees (`accruedFees`) are reserved: an execution can never spend fee revenue, and
  `withdrawFees` cannot be bricked by a trade.
- Every execution is recorded against the container's own incrementing nonce, limiting replay and
  back-dating; the relayer is revoked with `setRelayer(keeper, false)`.
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
- A compromised Worker or signer can still execute actions within the circuit's caps and whitelists.
  Revoke the relayer with `setRelayer(keeper, false)`.
- The relayer wallet needs gas to submit transactions; it cannot call owner-only withdrawal or
  reconfiguration functions.
- The daemon is only as available as Cloudflare's cron; a missed cycle costs time, never funds.
