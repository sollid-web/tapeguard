const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const RAW_TRANSACTION_RE = /^0x(?:[0-9a-f]{2})+$/i;
const TIMEOUT_MS = 8000;

function configuredAddress(env) {
  const address = String(env.RELAYER_ADDRESS || '');
  return ADDRESS_RE.test(address) ? address.toLowerCase() : null;
}

function signerUrl(env, path) {
  const base = String(env.SIGNER_URL || '').replace(/\/+$/, '');
  if (!base || !env.SIGNER_TOKEN || !configuredAddress(env)) return null;
  let url;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  return `${base}${path}`;
}

function authHeaders(env) {
  return {
    Authorization: `Bearer ${env.SIGNER_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

export function signerConfigured(env) {
  return signerUrl(env, '/health') !== null;
}

export async function signerStatus(env) {
  const address = configuredAddress(env);
  const url = signerUrl(env, '/health');
  if (!url) {
    return {
      ok: false,
      address,
      reason: 'SIGNER_URL, SIGNER_TOKEN, and a valid RELAYER_ADDRESS are required',
    };
  }
  try {
    const response = await fetch(url, {
      headers: authHeaders(env),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`signer health HTTP ${response.status}`);
    const body = await response.json();
    if (body?.ok !== true || String(body.address || '').toLowerCase() !== address) {
      throw new Error('signer health address does not match RELAYER_ADDRESS');
    }
    return { ok: true, address, reason: '' };
  } catch (error) {
    return { ok: false, address, reason: error?.message || 'signer health check failed' };
  }
}

function quantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

export async function signTransactionRemotely(env, tx, type) {
  const address = configuredAddress(env);
  const url = signerUrl(env, '/sign');
  if (!url) throw new Error('external signer is not configured');
  if (type !== 'eip1559' && type !== 'legacy') throw new Error('unsupported transaction type');

  const transaction = {
    chainId: quantity(tx.chainId),
    nonce: quantity(tx.nonce),
    gasLimit: quantity(tx.gasLimit),
    to: tx.to,
    value: quantity(tx.value),
    data: tx.data,
  };
  if (type === 'eip1559') {
    transaction.maxPriorityFeePerGas = quantity(tx.maxPriorityFeePerGas);
    transaction.maxFeePerGas = quantity(tx.maxFeePerGas);
  } else {
    transaction.gasPrice = quantity(tx.gasPrice);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({ type, transaction }),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`signer request HTTP ${response.status}`);
  const body = await response.json();
  if (String(body?.address || '').toLowerCase() !== address) {
    throw new Error('signer returned a different relayer address');
  }
  if (typeof body.rawTransaction !== 'string' || !RAW_TRANSACTION_RE.test(body.rawTransaction)) {
    throw new Error('signer returned an invalid raw transaction');
  }
  return body.rawTransaction;
}
