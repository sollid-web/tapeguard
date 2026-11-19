# TapeGuard: X Layer Build X, TapeOut Accelerate submission pack

Form: https://forms.gle/EoDNbxQ65dev1wFd9, due **7 Dec 2026, 23:59 UTC** (aim to submit by 6 Dec).
Fill in every `⟨…⟩` from the launch output (`LAUNCH.md` step 2) before submitting.

---

## Project name
TapeGuard

## One-liner
An autonomous trading agent for X Layer that never holds your key: every trade it makes is
judged on-chain by a guard circuit taped out on TapeOut.

## Access link
https://tapeguard.tapeguard.workers.dev (dashboard: Policy tab → "TapeOut guard circuit" → *Run the
live circuit*). Code: https://github.com/sollid-web/tapeguard

## TapeOut usage (required fields)
| | |
|---|---|
| Processor (circuits) contract | `⟨TAPEOUT_CIRCUITS⟩`, the TapeGuard processor (TGRD), created via TapeOut factory `0x1f09DAeFA827f02CBb40967cc91b259763760761` |
| Circuit ID | `⟨TAPEOUT_CIRCUIT_ID⟩`: the guard circuit, 17 NAND gates, 10 inputs, 1 output |
| PolicyCircuit (calls `eval()` on every trade) | `⟨PolicyCircuit⟩` |
| AgentContainer (holds the funds) | `⟨AgentContainer⟩` |
| TapeGuardFactory (one-click agents) | `⟨TapeGuardFactory⟩` |
| TapeOut container owning the agent (optional) | `⟨container⟩` (opener `0x536adD8F30f03b69f6fbF29d425A816A0dC50106`) |

**Which TapeOut features we use**
- **Processor + transistors:** our own processor created with `createCPU`, with NAND transistors
  minted from it.
- **Circuit tape-out:** the guard circuit is compiled to TapeOut's netlist format by
  `tapeout/guard-circuit.mjs` and taped out with `tapeout(netlist, 10, 1)`.
- **`eval()` in production:** `PolicyCircuit.check()` calls `circuits.eval(id, factBits)` inside
  every `AgentContainer.execute()`. The circuit's output is the final verdict on every trade.
- **Circuit container (ERC-6551):** the launch can open the guard circuit's own TapeOut container
  and hand ownership of the agent to it. The dashboard routes owner actions through
  `container.execute(...)` automatically.
- **Reusable on-chain logic:** any TapeOut circuit can `REF` the guard circuit, and any contract can
  `eval()` it. The verdict logic is public and runs on-chain.

## Project description (product, users, revenue, retention)

**Problem.** To let a bot trade for you today, you give it your private key. A key is unlimited,
permanent power: one leaked server variable and the wallet is gone. Afterwards nobody can prove what
the bot was *allowed* to do.

**Product.** TapeGuard is a keyless agent wallet on X Layer. Funds sit in an `AgentContainer`
contract. The always-on agent (a Cloudflare Worker) watches the OKB/USDT allocation and rebalances
on Uniswap V2 when it drifts. It can only *propose* trades: each one is reduced to 10 fact bits
and judged twice in the same transaction.
1. **Solidity safety floor:** per-trade and daily caps (native and per token), router and function
   allowlists, a pause switch, swap output that must go to the container, and a non-zero minimum
   output.
2. **The TapeOut guard circuit:** gives the final verdict through `eval()`. It also enforces a rule
   that exists only in the circuit: once half of the day's budget is spent, large trades are refused.

The design is fail-closed. TapeOut's contracts are upgradeable, so the floor runs first and the
circuit can only *add* refusals: an outage stops trading, it never approves anything. The relayer
key sits in a separate signer Worker that will only sign `AgentContainer.execute()` on chain 196.

**Target users and how we reach them.**
- **OKB/USDT holders on X Layer** who want a target allocation kept without watching charts.
  We reach them through OKX Wallet / X Layer ecosystem channels, the TapeOut community, and
  partner DEXs whose users already hold both assets.
- **Small funds, DAOs and treasuries** that need an automated keeper with provable authorisation.
  The policy commitment hash and a public circuit anyone can `eval()` give them an audit trail.
- **X Layer builders running their own agents.** `TapeGuardFactory` and the guard circuit are an
  execution safety layer they can use instead of building one.

**Revenue model (enforced on-chain).** Agents created by `TapeGuardFactory` carry fixed terms:
- **Subscription:** 0.02 OKB per 30 days of autonomous operation, paid to the TapeGuard
  treasury by `activate()`.
- **Volume fee:** 0.10% of every executed OKB amount (`ProtocolFeePaid` event), hard-capped at
  0.50% in the contract, so even a leaked keeper key cannot drain the agent through fees.
Neither the owner nor the keeper can change these terms after deployment, and every payment is
visible on-chain. Self-hosted agents (no treasury) run fee-free.

**Why users pay and keep using it.** The alternative is giving a bot your key, or watching the
chart yourself. TapeGuard keeps working while you sleep, and its limits are code on X Layer rather
than a promise. Each month of safe operation builds a public execution record, and the fee is
small relative to the time saved. The subscription extends with one `activate()` call.

## New development during the event (event start: 16 Oct 2026)
All TapeGuard code was written during the event (first commit 7 Nov 2026). The TapeOut work in
the v2 branch:
- the TapeOut guard circuit: netlist compiler, simulator, verified on all 1,024 inputs, `eval()`
  gate in PolicyCircuit, fork test against the live circuit;
- a fix for a keeper-theft issue found in our own audit (swap recipient and min-out enforcement);
- the restricted signer Worker, the protocol fee model, `TapeGuardFactory`, two-step ownership,
  TapeOut container routing in the dashboard, and a one-command mainnet launch script;
- 83 automated tests (48 contract, 28 Worker/circuit/frontend, 7 signer), plus fork tests that run
  against real X Layer state.

---

## Demo video: 3:00 script

Record at 1080p. Have three tabs open: the dashboard, OKLink on the PolicyCircuit, and the repo.
Keep the cursor slow. Every on-screen number must come from chain or the Worker.

| time | on screen | say |
|---|---|---|
| 0:00–0:20 | Title card, then the dashboard Overview | "To let a bot trade for you today, you hand it your private key: unlimited power. One leak and the wallet is gone. TapeGuard is an agent that trades for you on X Layer and never holds your key." |
| 0:20–0:45 | Overview: live OKB price, allocation, daemon ONLINE | "Your funds sit in a keyless container. An always-on agent watches your OKB/USDT allocation and rebalances on Uniswap when it drifts. It can only propose trades." |
| 0:45–1:25 | Policy tab → **TapeOut guard circuit** → click *Run the live circuit* | "Every trade becomes ten yes-or-no facts. Solidity enforces the safety floor, and a circuit we taped out on TapeOut, 17 NAND gates, gives the final verdict through eval(). Normal rebalance: approved. Large trade after half the day's budget is spent: rejected, and that rule lives only in the circuit. A keeper trying to take the swap output: rejected." |
| 1:25–1:50 | OKLink: PolicyCircuit `tapeoutCircuits`, the processor, the circuit id; a recent `Executed` tx | "This is on mainnet: our TapeGuard processor, the guard circuit, and a real trade the agent made on its own. If TapeOut were down, trading would stop. It can never approve something the floor rejects." |
| 1:50–2:15 | Autonomy tab: server log with timestamps from before the tab was opened; kill switch on/off | "It runs while you're away. The log shows decisions made before I opened this page. One click pauses everything on-chain." |
| 2:15–2:40 | Revenue tab: subscription, 0.10% volume fee, treasury, fees paid | "The business model is on-chain: a 30-day subscription plus 0.1% of executed volume, capped at 0.5% in the contract and fixed at deployment. The factory gives any X Layer user a guarded agent in one transaction." |
| 2:40–3:00 | README test badge or terminal running `forge test` | "83 tests, fork tests against real X Layer liquidity, and every address is in the repo. TapeGuard: autonomous, and it can't touch more than you allow." |

**Before recording:** make sure the agent has made at least one real trade (fund it with ~0.2 OKB
and let one drift cycle run, or lower the drift band temporarily). Copy that tx hash for 1:25.

## Final checklist
- [ ] Launch done; every `⟨…⟩` above filled in; `deployments/196.json` updated; `npm run sync-config`
- [ ] `TapeOutForkTest` and `DexForkTest` pass against mainnet
- [ ] Signer Worker deployed; `/api/health` shows the signer OK; Worker config points at the new contracts
- [ ] At least one real autonomous trade, and its tx hash noted
- [ ] Video ≤ 3:00, uploaded (YouTube unlisted or Drive, viewable by link)
- [ ] `tapeout-integration` merged into `main` and redeployed with `npx wrangler deploy`
- [ ] Form submitted; confirmation saved
