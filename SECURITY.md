# TapeGuardian — security status

Review date: 7 November 2026
Scope: current checked-in source, backend and Foundry regression tests. This is a source review only;
it does not verify production infrastructure, Cloudflare secrets, D1 migrations, or deployed bytecode.

## Current findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| M-01 | Medium | The Worker uses a hot `RELAYER_KEY`; compromise permits policy-approved actions within the on-chain limits. | Residual operational risk. Key separation, least privilege, monitoring, rotation and revocation are documented below. Live secret rotation is not verified by this repository. |
| M-02 | Medium | `liquidityGuard()` compares a reserve-based marginal output with a router quote, so its shortfall includes pool fees. | Outstanding metric-definition and regression-test issue; do not describe the combined shortfall as pure price impact. |
The repo also previously had an off-by-one `eth_getLogs` limit, a tracked Wrangler account cache,
and stale network/security documentation. Those source-hygiene and documentation issues are
addressed in this change: the endpoint now enforces a 5,000-block inclusive maximum, `.wrangler/`
is ignored and its tracked cache is removed, and the documentation identifies network IDs and
historical findings explicitly.

## Keeper key management

Treat `RELAYER_KEY` as a hot key. Keep it separate from owner keys, fund it only with gas, restrict
access to Worker secrets, and monitor container activity. For planned rotation:

1. Generate a replacement key in a secure environment; never put its private key in source control,
   an ordinary `.env` file, logs, or this document.
2. Authorize the replacement address through the owner-controlled
   `AgentContainer.setRelayer(newAddress, true)`.
3. Update the Cloudflare Worker `RELAYER_KEY` secret using Cloudflare's secret-management interface.
4. Verify the Worker is using the replacement and can submit a harmless policy-approved action.
5. Revoke the old address with `AgentContainer.setRelayer(oldAddress, false)` and verify its on-chain
   `relayers(oldAddress)` value is false.

For suspected compromise, pause the agent and revoke the old relayer immediately; rotate the Worker
secret, authorize and verify the replacement, and only then unpause. A Foundry regression test verifies
that a revoked relayer cannot execute. This documents and tests on-chain revocation behavior, but does
not claim a live Cloudflare secret rotation or deployment has been performed.

## Previously reported issues

These are historical source-review findings, not claims about the current code. The current checked-in
implementation has regression coverage for token limits and canonical, truncated, and trailing ERC-20
calldata for all four sensitive selectors through both `execute()` and `simulate()`, as well as on-chain
action limits, nonce handling, tick-lock ownership/renewal, bounded RPC ranges, and logical trade IDs.
The source-level tests do not establish that deployed contracts or production infrastructure use that
code.

## Deployment boundary

The Foundry sample configuration targets X Layer testnet (chain ID 1952). X Layer mainnet is chain
ID 196. The Worker and dashboard fallback chain ID is 196; explicitly configure the testnet chain ID
when using the testnet workspace. Configuration and test results are not evidence of deployment.
Validate deployed addresses, bytecode, policy settings, relayer authorization, and D1 schema against
the intended environment before enabling automated execution.
