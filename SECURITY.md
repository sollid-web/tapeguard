# TapeGuardian — security status

Review date: 7 November 2026
Scope: current checked-in source, backend and Foundry regression tests. This is a source review only;
it does not verify production infrastructure, Cloudflare secrets, D1 migrations, or deployed bytecode.

## Current findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| M-01 | Medium | A compromised Worker can request transactions from the relayer signer and execute actions allowed by the on-chain policy. | Worker-side local private-key custody/signing has been removed in source and replaced with an authenticated external-signer protocol. This reduces direct key-extraction risk but does not eliminate the relayer's authority. The external service and its independent transaction restrictions are not implemented or deployed here, so M-01 remains open pending deployment and operational verification. |

## Recently resolved

- **M-02 — Price-impact metric included pool fees. Resolved in source.** For exact-input trades
  through the supported two-token constant-product pool, the daemon computes fee-excluded curve
  impact as `amountIn / (reserveIn + amountIn)`, relative to the pool's infinitesimal mid-price. It
  selects `reserveIn` using the input token's position in the trade path. The ratio is dimensionless,
  so raw token units and decimal scales cancel. The result is converted to basis points and rounded up
  before comparison with `maxPriceImpactBps` (1–150 bps). This measures trade-size impact from the
  current reserve snapshot; it does not include pool/router fees and is not a quote, TWAP, or
  guarantee of realized price. Independently, the daemon checks router output against the feed and
  uses the lower output, reduced by `slippageBps`, as `amountOutMin`. Automated trading requires the
  router quote; the `requireQuote` configuration cannot disable that requirement, and the impact
  check runs before quote resolution. Tests cover no-quote behavior, trade direction, decimal scales,
  trade sizes, and threshold boundaries.

The repo also previously had an off-by-one `eth_getLogs` limit, a tracked Wrangler account cache,
and stale network/security documentation. Those source-hygiene and documentation issues are
addressed in this change: the endpoint now enforces a 5,000-block inclusive maximum, `.wrangler/`
is ignored and its tracked cache is removed, and the documentation identifies network IDs and
historical findings explicitly.

## External signer boundary

The Worker now requires `SIGNER_URL` (HTTPS), `SIGNER_TOKEN`, and `RELAYER_ADDRESS`; it sends the
unsigned transaction to the signer, verifies the returned relayer address and raw-transaction
encoding, then broadcasts it through `RPC_URL`. The Worker's local private-key derivation and
transaction-signing implementation have been removed. The signing service must independently
enforce chain-ID, destination-container, zero outer value, calldata, gas/fee, authentication, and
audit restrictions. A generic signing endpoint would leave the key remotely usable for arbitrary
transactions and is not an acceptable deployment.

This boundary reduces exposure of the private key to Worker runtime compromise, but the Worker can
still invoke the signer and the relayer retains its on-chain policy-approved execution authority.
M-01 is therefore not closed by this source change alone. The external signer implementation,
independent restrictions, key rotation, relayer revocation, and live Cloudflare configuration must be
deployed and verified before claiming operational remediation.

For planned rotation, create a replacement key inside the signing system, authorize its address
through `AgentContainer.setRelayer(newAddress, true)`, update `RELAYER_ADDRESS` and the signer's
identity, verify `/api/health` and `/api/status`, then revoke the old relayer and confirm its on-chain
authorization is false. For suspected compromise, pause the agent and revoke the old relayer
immediately. A Foundry regression test verifies on-chain revocation behavior; it does not verify a
live signer or Cloudflare deployment.

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
