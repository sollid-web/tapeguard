 New issues discovered during the recheck
These are important because the remediation introduced improvements but did not close every underlying risk.
Finding A — ERC-20 allowance bypass
File: contracts/AgentContainer.sol
_tokenOutflow() recognizes sensitive ERC-20 calls only when calldata has an exact length:
approve: 68 bytes.
transfer: 68 bytes.
transferFrom: 100 bytes.
The problem is that standard Solidity ERC-20 function dispatch generally accepts valid ABI arguments followed by additional trailing calldata.
An attacker controlling the keeper could append extra bytes to an otherwise valid approval call. The token outflow parser could then return zero, skipping checkToken(), while the token contract may still execute the approval.
Because the router is registered, this could undermine the per-token spending limits.
Required fix: Either reject noncanonical calldata for sensitive selectors or decode the required arguments without relying on exact total calldata length. Add malicious trailing-data tests using a real mock ERC-20 implementation.

Highest priority.
Fix trailing-calldata token-limit bypass.
Fix successful trade ID persistence.
Correct buy-side liquidity calculations.
Implement genuine price-impact measurement.
Correct nonce failure handling and transaction dependencies.
Add regression tests for each issue before proceeding.
Phase 2 — Restore policy and RPC correctness
Fix commitment calculation.
Make simulation enforce the action limit.
Close unbounded eth_getLogs requests.
Strengthen lock renewal and concurrency handling.
Phase 3 — Make verification reproducible
Commit a complete Foundry workspace and dependencies.
Add contract tests for all identified bypasses.
Add integration tests for multi-step trades and D1 accounting.
Add GitHub Actions for Node and Foundry.
Require checks before merging into main.
Phase 4 — Deployment and operational assurance
Deploy the corrected contracts to X Layer testnet.
Verify policy configuration and router authorization.
Apply and verify the D1 schema migration.
Deploy the corrected Worker.
Run small-value end-to-end tests in both buy and sell directions.
Verify failed, reverted, and interrupted transaction recovery.
Only then consider a controlled mainnet rollout.

Deployment caveat
The Solidity changes require deploying the updated PolicyCircuit and AgentContainer, then configuring the new policy and router permissions. The D1 trade_id column also needs verified migration on the actual production database. A source-level fix alone does not protect the deployed system.
	
