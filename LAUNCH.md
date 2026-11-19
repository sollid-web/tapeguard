# Launching TapeGuard v2 on X Layer mainnet

TapeOut has no testnet, so v2 lives on X Layer mainnet (chain 196). Rehearse every step on a local
fork first: it runs against the real TapeOut contracts and costs nothing.

## What it costs (TapeOut fees, read live by the script)

| Step | Fee (OKB) |
|---|---|
| `createCPU` — the TapeGuard processor | 0.0066 |
| mint 17 NAND transistors (unit price is yours, paid back to you as creator) | 17 × 0.00001 + 0.00066 ≈ 0.00083 |
| `tapeout` the guard circuit | 0.0013 |
| *optional* open the circuit's TapeOut container | 0.08 |
| *optional* two `execute` calls to accept ownership | 2 × 0.0013 |
| activation fee (paid into your own container) | 0.02 |
| gas for everything (X Layer ≈ 0.02 gwei) | < 0.001 |

Without the container handover: about **0.03 OKB** plus whatever you fund the agent with.
With it: about **0.11 OKB**.

## 0. Prepare

- Foundry installed (`forge`, `cast`, `anvil`).
- **Deployer wallet** with the OKB above. Put its key in `foundry/.env` as `PRIVATE_KEY=0x...`
  (git-ignored, and never served by the Worker; see `.assetsignore`).
- **Relayer wallet**: a fresh key used only by the signer Worker. Fund it with ~0.01 OKB for gas.
- Trading venue (UniswapV2 ABI, which the daemon speaks): Uniswap V2 on X Layer.

  | | address |
  |---|---|
  | Router02 | `0x182a927119D56008d921126764bF884221b10f59` |
  | Factory | `0xDf38F24fE153761634Be942F9d859f3DBA857E95` |
  | WOKB | `0xe538905cf8410324e03A5A23c1c177a474D59b2b` |
  | USDT / USDT0 | `0x1E4a5963aBFD975d8c9021ce480b42188849D41d` / `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` |

  **Before anything else, prove the venue on real liquidity** (free, read-only fork):

  ```sh
  cd foundry
  DEX_FORK=1 forge test --match-contract DexForkTest --fork-url https://rpc.xlayer.tech -vv
  ```

  It prints both pools' depth and runs a full OKB → USDT → OKB round trip through PolicyCircuit
  and the guard circuit. Use the USDT token it says it traded against. If it reports
  "pool too thin", rerun with `ROUTER=<another UniswapV2-compatible router>` (e.g. PotatoSwap's,
  which holds the deepest WOKB/USDT pool, `0xc71f9e1de80eb505c0cb3bbf90ae6593130e5d25`; take the
  router address from a swap transaction on that pool in OKLink).

```sh
cd foundry
set -a; source .env; set +a      # PRIVATE_KEY for this shell (forge also reads .env itself)
export RELAYER_ADDRESS=0x...        # relayer wallet address
export ROUTER=0x182a927119D56008d921126764bF884221b10f59   # Uniswap V2 Router02
export USDT=0x1E4a5963aBFD975d8c9021ce480b42188849D41d     # or USDT0, per DexForkTest
export ACTIVATE=true FUND_WEI=200000000000000000   # 0.2 OKB for the agent to trade with
export TREASURY=0x...               # a separate wallet you control: receives subscriptions + volume fees
export DEPLOY_FACTORY=true          # also deploy TapeGuardFactory (one-click agents, same terms)
```

## 1. Rehearse on a fork (free)

```sh
anvil --fork-url https://rpc.xlayer.tech --chain-id 196 &
# give the deployer fork-OKB:
cast rpc anvil_setBalance $(cast wallet address --private-key $PRIVATE_KEY) 0x8AC7230489E80000 --rpc-url http://127.0.0.1:8545
forge script script/LaunchTapeGuard.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
# check the freshly taped-out circuit on the fork against the spec (all 1,024 inputs):
TAPEOUT_CIRCUITS=<printed circuits> TAPEOUT_CIRCUIT_ID=<printed id> \
  forge test --match-contract TapeOutForkTest --fork-url http://127.0.0.1:8545 -vv
```

Both fork tests must report real checks (`eval verified on fact vectors: 1024`), not an early return.

## 2. Launch for real

```sh
forge script script/LaunchTapeGuard.s.sol --rpc-url https://rpc.xlayer.tech --broadcast --slow
```

It prints the processor (circuits) address, the guard circuit id, `PolicyCircuit`, `AgentContainer`,
the treasury and fee, `TapeGuardFactory`, and the policy commitment. Copy them into [`deployments/196.json`](deployments/196.json)
(`AgentContainer`, `PolicyCircuit`, `tapeout.circuits`, `tapeout.circuitId`), then:

```sh
cd .. && npm run sync-config        # updates index.html and signer/wrangler.toml
cd foundry && TAPEOUT_CIRCUITS=... TAPEOUT_CIRCUIT_ID=... \
  forge test --match-contract TapeOutForkTest --fork-url https://rpc.xlayer.tech -vv   # live check
```

Already taped out and only redeploying the contracts? Set `TAPEOUT_CIRCUITS` and
`TAPEOUT_CIRCUIT_ID` before step 2 and the script reuses the circuit.

## 3. Deploy the signer Worker

```sh
cd signer && npm ci
npx wrangler secret put RELAYER_PRIVATE_KEY     # relayer key
npx wrangler secret put SIGNER_TOKEN            # long random string, e.g. openssl rand -hex 32
npx wrangler deploy                             # note the https://tapeguard-signer.<you>.workers.dev URL
```

`CONTAINER` in `signer/wrangler.toml` must be the new AgentContainer (`npm run sync-config` sets it).

## 4. Point the main Worker at it

```sh
cd ..
npx wrangler secret put SIGNER_URL          # https://tapeguard-signer.<you>.workers.dev
npx wrangler secret put SIGNER_TOKEN        # same value as the signer's
npx wrangler secret put RELAYER_ADDRESS     # relayer wallet address
npx wrangler deploy
```

Then in the dashboard's Autonomy tab (admin login) set:

| key | value |
|---|---|
| `container`, `policy` | from the launch output |
| `router` | `0x182a927119D56008d921126764bF884221b10f59` |
| `factory` | `0xDf38F24fE153761634Be942F9d859f3DBA857E95` |
| `wrappedNative` | `0xe538905cf8410324e03A5A23C1c177a474D59b2b` |
| `usdt` | the USDT token DexForkTest traded against |
| `pathSell` | `["<wrappedNative>","<usdt>"]` |
| `pathBuy` | `["<usdt>","<wrappedNative>"]` |

## 5. Check

- `GET /api/health` → `signer.ok: true` with the relayer address.
- `GET /api/status` → `relayer.authorised: true`, `circuit` populated, `daemon.online: true`.
- OKLink: the processor, the `TapedOut` event, and the first `Executed` events of the container.

## Optional: hand ownership to the TapeOut container

`HANDOVER_TO_TAPEOUT_CONTAINER=true` in step 2 opens the guard circuit's TapeOut container
(ERC-6551 account) and makes it the owner of both contracts. After that, every owner action costs
TapeOut's 0.0013 OKB `EXEC_FEE` and must be sent as `container.execute(target, 0, data, 0)` from the
wallet holding the circuit NFT, so do this only once the dashboard routes owner calls through the
container.
