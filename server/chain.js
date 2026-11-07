// Chain access for the daemon. Everything is read-only JSON-RPC against the
// endpoint in the secret RPC_URL; the only write path is eth_sendRawTransaction
// with a transaction already signed by the relayer (see ./wallet.js).

import {
  encodeAddress, encodeUint, encodeCall, encodeCallWithBytes, decodeWords,
  wordToBigInt, wordToBool, wordToAddress, wordToBytes32, decodeCheck, strip,
} from './abi.js';

const TIMEOUT_MS = 8000;

export function rpcConfigured (env) {
  return typeof env.RPC_URL === 'string' && env.RPC_URL.startsWith('http');
}

async function rpc (env, method, params) {
  if (!rpcConfigured(env)) throw new Error('RPC_URL secret is not set');
  const response = await fetch(env.RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('rpc http ' + response.status);
  const body = await response.json();
  if (body && body.error) throw new Error(body.error.message || 'rpc error');
  return body ? body.result : null;
}

/* ------------------------------------------------------------------ primitives */

export async function blockNumber (env) {
  return BigInt(await rpc(env, 'eth_blockNumber', []));
}

export function nativeBalance (env, address) {
  return rpc(env, 'eth_getBalance', [address, 'latest']).then((v) => BigInt(v ?? 0));
}

export function callData (env, to, data) {
  return rpc(env, 'eth_call', [{ to, data }, 'latest']);
}

export function gasPrice (env) {
  return rpc(env, 'eth_gasPrice', []).then((v) => BigInt(v ?? 0));
}

/** EIP-1559 tip. Falls back to a fraction of the gas price when the node has no
 *  eth_maxPriorityFeePerGas, so the keeper still works on a legacy-only endpoint. */
export async function maxPriorityFee (env) {
  try {
    const tip = await rpc(env, 'eth_maxPriorityFeePerGas', []);
    if (tip) return BigInt(tip);
  } catch {
    /* endpoint does not support 1559 hints */
  }
  const price = await gasPrice(env);
  const tip = price / 10n;
  return tip > 1000000n ? tip : 1000000n;
}

export function nonceOf (env, address) {
  return rpc(env, 'eth_getTransactionCount', [address, 'pending']).then((v) => BigInt(v ?? 0));
}

export function estimateGas (env, tx) {
  return rpc(env, 'eth_estimateGas', [tx]).then((v) => (v ? BigInt(v) : 0n));
}

export function sendRaw (env, raw) {
  return rpc(env, 'eth_sendRawTransaction', [raw]);
}

export function receipt (env, hash) {
  return rpc(env, 'eth_getTransactionReceipt', [hash]);
}

/* ------------------------------------------------------------- contract reads */

/** Full parameter set of the policy circuit for one agent (7 static returns). */
export async function policyView (env, policy, agent) {
  const words = decodeWords(await callData(env, policy, encodeCall('policyView(address)', [encodeAddress(agent)])));
  return {
    circuitId: wordToBytes32(words[0]),
    commitment: wordToBytes32(words[1]),
    paused: wordToBool(words[2]),
    maxPerAction: wordToBigInt(words[3]),
    dailyLimit: wordToBigInt(words[4]),
    spentToday: wordToBigInt(words[5]),
    remainingToday: wordToBigInt(words[6]),
  };
}

/** PolicyCircuit.check(): the authoritative verdict for one proposed action. */
export async function policyCheck (env, policy, agent, target, value, data) {
  const calldata = encodeCallWithBytes(
    'check(address,address,uint256,bytes)',
    [encodeAddress(agent), encodeAddress(target), encodeUint(value)],
    strip(data),
  );
  return decodeCheck(await callData(env, policy, calldata));
}

/** AgentContainer.info() - state of the agent account (8 static returns). */
export async function containerInfo (env, container) {
  const words = decodeWords(await callData(env, container, encodeCall('info()', [])));
  return {
    policy: wordToAddress(words[0]),
    paused: wordToBool(words[1]),
    active: wordToBool(words[2]),
    activationFee: wordToBigInt(words[3]),
    activeUntil: Number(wordToBigInt(words[4])),
    accruedFees: wordToBigInt(words[5]),
    executions: wordToBigInt(words[6]),
    nonce: wordToBigInt(words[7]),
  };
}

export async function isRelayer (env, container, relayer) {
  const words = decodeWords(await callData(env, container, encodeCall('relayers(address)', [encodeAddress(relayer)])));
  return wordToBool(words[0]);
}

/** The container's own dry run - exactly the check execute() performs. */
export async function containerSimulate (env, container, target, value, data) {
  const calldata = encodeCallWithBytes(
    'simulate(address,uint256,bytes)',
    [encodeAddress(target), encodeUint(value)],
    strip(data),
  );
  return decodeCheck(await callData(env, container, calldata));
}

/** Router quote for an exact-input swap: the last hop of getAmountsOut().
 *  Used to cross-check the off-chain price before a trade is signed. */
export async function quoteOut (env, router, amountIn, path) {
  if (!router || !Array.isArray(path) || path.length < 2) throw new Error('quote needs a router and a path');
  const data =
    '0xd06ca61f' + // getAmountsOut(uint256,address[])
    encodeUint(amountIn) +
    encodeUint(64) +
    encodeUint(path.length) +
    path.map(encodeAddress).join('');
  const words = decodeWords(await callData(env, router, data));
  if (words.length < 3) throw new Error('router returned no quote');
  const length = Number(wordToBigInt(words[1]));
  if (!length || words.length <= 1 + length) throw new Error('router returned an empty path');
  return wordToBigInt(words[1 + length]);
}

export async function erc20Balance (env, token, holder) {
  const words = decodeWords(await callData(env, token, encodeCall('balanceOf(address)', [encodeAddress(holder)])));
  return wordToBigInt(words[0]);
}

export async function erc20Decimals (env, token, fallback = 6) {
  try {
    const words = decodeWords(await callData(env, token, encodeCall('decimals()', [])));
    const value = Number(wordToBigInt(words[0]));
    return value >= 0 && value <= 36 ? value : fallback;
  } catch {
    return fallback;
  }
}

/* ----------------------------------------------------------------- write path */

/** Calldata for AgentContainer.execute(target, value, data). */
export function executeCalldata (target, value, data) {
  return encodeCallWithBytes(
    'execute(address,uint256,bytes)',
    [encodeAddress(target), encodeUint(value)],
    strip(data),
  );
}

export function activationCalldata () {
  return encodeCall('activate()', []);
}