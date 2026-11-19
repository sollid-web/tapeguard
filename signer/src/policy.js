// What the signer is willing to sign. Pure functions, unit tested in policy.test.js.
//
// The relayer key can only ever produce one kind of transaction:
//   to      = the configured AgentContainer
//   chainId = the configured chain (196, X Layer mainnet)
//   value   = 0
//   data    = AgentContainer.execute(address,uint256,bytes)
//   gas     = at most MAX_GAS, fees at most MAX_FEE_WEI
// Everything else - including a plain transfer that would drain the relayer's gas
// balance - is refused here, before the key is touched. The container's on-chain
// policy (PolicyCircuit + TapeOut guard circuit) then judges the action itself.

export const EXECUTE_SELECTOR = '0xb61d27f6'; // execute(address,uint256,bytes)
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const HEX_RE = /^0x[0-9a-f]*$/i;
const QTY_RE = /^0x(0|[1-9a-f][0-9a-f]*)$/i;

export function readConfig(env) {
  const container = String(env.CONTAINER || '').toLowerCase();
  if (!ADDRESS_RE.test(container)) throw new Error('CONTAINER is not configured');
  const chainId = BigInt(env.CHAIN_ID || '196');
  const maxGas = BigInt(env.MAX_GAS || '2000000');
  const maxFeeWei = BigInt(env.MAX_FEE_WEI || '5000000000'); // 5 gwei; X Layer is ~0.02 gwei
  return { container, chainId, maxGas, maxFeeWei };
}

function qty(tx, key) {
  const v = tx?.[key];
  if (typeof v !== 'string' || !QTY_RE.test(v)) throw new Error(`${key} must be a hex quantity`);
  return BigInt(v);
}

/** Validates a /sign request body; returns a viem transaction or throws with a reason. */
export function validateRequest(body, cfg) {
  const type = body?.type;
  const tx = body?.transaction;
  if (type !== 'eip1559' && type !== 'legacy') throw new Error('unsupported transaction type');
  if (!tx || typeof tx !== 'object') throw new Error('transaction missing');

  const chainId = qty(tx, 'chainId');
  if (chainId !== cfg.chainId) throw new Error(`chainId ${chainId} is not ${cfg.chainId}`);

  const to = String(tx.to || '').toLowerCase();
  if (!ADDRESS_RE.test(to) || to !== cfg.container) throw new Error('to is not the AgentContainer');

  if (qty(tx, 'value') !== 0n) throw new Error('value must be 0');

  const data = String(tx.data || '');
  if (!HEX_RE.test(data) || data.length % 2 !== 0) throw new Error('data is not hex');
  if (data.slice(0, 10).toLowerCase() !== EXECUTE_SELECTOR) throw new Error('only AgentContainer.execute is signed');
  // execute(address,uint256,bytes): 3 head words + bytes length word at minimum
  if ((data.length - 10) / 2 < 128) throw new Error('execute calldata too short');

  const gas = qty(tx, 'gasLimit');
  if (gas === 0n || gas > cfg.maxGas) throw new Error('gasLimit outside the allowed range');
  const nonce = qty(tx, 'nonce');

  const out = { chainId: Number(chainId), to, value: 0n, data, gas, nonce: Number(nonce) };
  if (type === 'eip1559') {
    const maxFeePerGas = qty(tx, 'maxFeePerGas');
    const maxPriorityFeePerGas = qty(tx, 'maxPriorityFeePerGas');
    if (maxFeePerGas > cfg.maxFeeWei) throw new Error('maxFeePerGas above MAX_FEE_WEI');
    if (maxPriorityFeePerGas > maxFeePerGas) throw new Error('priority fee above max fee');
    return { ...out, type: 'eip1559', maxFeePerGas, maxPriorityFeePerGas };
  }
  const gasPrice = qty(tx, 'gasPrice');
  if (gasPrice > cfg.maxFeeWei) throw new Error('gasPrice above MAX_FEE_WEI');
  return { ...out, type: 'legacy', gasPrice };
}

/** Constant-time comparison of the bearer token. */
export function tokenMatches(header, expected) {
  if (!expected || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const a = new TextEncoder().encode(header.slice(7));
  const b = new TextEncoder().encode(String(expected));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
