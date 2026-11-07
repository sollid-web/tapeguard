# Historical audit findings and current disposition

Review snapshot: 7 November 2026
Repository: `sollid-web/tapeguard`

This file preserves the earlier recheck notes for context. It is not a current, independently verified
defect backlog. Use [`SECURITY.md`](SECURITY.md) for the current source-review status and
[`remaining_bug.txt`](remaining_bug.txt) for the existing engineering roadmap. None of the source
findings below establishes that a fix has been deployed.

## Historical findings

- **ERC-20 trailing calldata:** the current container rejects noncanonical calldata for sensitive
  ERC-20 selectors. Foundry regression tests cover canonical, truncated, and appended calldata for all
  four sensitive selectors through both execution paths.
- **Logical trade IDs, transaction sequencing, nonce recovery, policy commitment and simulation
  limits:** subsequent source changes address these areas. Re-run the checked-in suites before
  relying on them; repository state does not establish production D1 or chain state.
- **RPC log bounds and tick-lock renewal:** source protections and tests exist. The inclusive maximum
  is 5,000 blocks; exact-boundary regression tests are maintained with the Worker tests.
- **Price impact:** the current reserve-marginal-versus-router-quote calculation includes pool fees.
  The metric needs to be separated from fees or described as execution shortfall, with buy/sell and
  decimal coverage. Treat this as outstanding until that work and its tests are complete.
- **Foundry workspace and reproducible verification:** the repository contains a vendored workspace,
  deployment script, and tests. Local test results must be recorded from the current checkout; no
  deployment or production verification is implied.

## Deployment boundary

Contract redeployment, policy/router configuration, production D1 migration, Worker deployment, and
end-to-end transactions remain separate operational steps. A source change alone does not protect
the deployed system.
