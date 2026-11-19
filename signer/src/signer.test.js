import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransaction, recoverTransactionAddress, encodeFunctionData, parseAbi } from 'viem';
import worker from './index.js';
import { validateRequest, readConfig, tokenMatches, EXECUTE_SELECTOR } from './policy.js';

// Anvil's well-known test key #0 - never holds real funds.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const CONTAINER = '0x23a28fcdfa235116e39c38d32b2e597676d03240';
const env = { RELAYER_PRIVATE_KEY: KEY, SIGNER_TOKEN: 'secret-token', CONTAINER, CHAIN_ID: '196' };

const executeData = encodeFunctionData({
  abi: parseAbi(['function execute(address,uint256,bytes)']),
  functionName: 'execute',
  args: ['0x000000000000000000000000000000000000dEaD', 10n ** 16n, '0x7ff36ab5'],
});

const goodTx = (over = {}) => ({
  chainId: '0xc4',
  nonce: '0x7',
  gasLimit: '0x30d40',
  to: CONTAINER,
  value: '0x0',
  data: executeData,
  maxPriorityFeePerGas: '0x1',
  maxFeePerGas: '0x5f5e100',
  ...over,
});

const call = (method, path, body, token = 'secret-token') =>
  worker.fetch(
    new Request(`https://signer.example${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
  );

test('selector constant matches execute(address,uint256,bytes)', () => {
  assert.equal(executeData.slice(0, 10), EXECUTE_SELECTOR);
});

test('health reports the relayer address the server expects', async () => {
  const res = await call('GET', '/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.address, ADDRESS);
});

test('rejects a wrong or missing token', async () => {
  assert.equal((await call('GET', '/health', null, 'nope')).status, 401);
  assert.equal(tokenMatches(undefined, 'x'), false);
  assert.equal(tokenMatches('Bearer x', ''), false);
});

test('signs a valid execute() and the signature recovers to the relayer', async () => {
  const res = await call('POST', '/sign', { type: 'eip1559', transaction: goodTx() });
  assert.equal(res.status, 200);
  const { rawTransaction, address } = await res.json();
  assert.equal(address, ADDRESS);
  const parsed = parseTransaction(rawTransaction);
  assert.equal(parsed.chainId, 196);
  assert.equal(parsed.to.toLowerCase(), CONTAINER);
  assert.equal(parsed.nonce, 7);
  const signer = await recoverTransactionAddress({ serializedTransaction: rawTransaction });
  assert.equal(signer.toLowerCase(), ADDRESS);
});

test('signs legacy transactions too', async () => {
  const tx = goodTx({ gasPrice: '0x5f5e100' });
  delete tx.maxFeePerGas;
  delete tx.maxPriorityFeePerGas;
  const res = await call('POST', '/sign', { type: 'legacy', transaction: tx });
  assert.equal(res.status, 200);
});

test('refuses everything that is not execute() on the container', async () => {
  const cfg = readConfig(env);
  const bad = {
    'other chain': goodTx({ chainId: '0x7a0' }),
    'other target': goodTx({ to: '0x000000000000000000000000000000000000beef' }),
    'value transfer': goodTx({ value: '0x1' }),
    'plain transfer': goodTx({ data: '0x' }),
    'other function': goodTx({ data: '0xa9059cbb' + executeData.slice(10) }),
    'short calldata': goodTx({ data: EXECUTE_SELECTOR }),
    'huge gas': goodTx({ gasLimit: '0x5f5e100' }),
    'fee spike': goodTx({ maxFeePerGas: '0xe8d4a51000' }),
    'priority above max': goodTx({ maxPriorityFeePerGas: '0x5f5e101' }),
    'non-hex quantity': goodTx({ nonce: '7' }),
  };
  for (const [name, transaction] of Object.entries(bad)) {
    assert.throws(() => validateRequest({ type: 'eip1559', transaction }, cfg), undefined, name);
    const res = await call('POST', '/sign', { type: 'eip1559', transaction });
    assert.equal(res.status, 400, name);
  }
  assert.throws(() => validateRequest({ type: 'eip2930', transaction: goodTx() }, cfg));
});

test('a misconfigured signer refuses instead of signing', async () => {
  const res = await worker.fetch(
    new Request('https://signer.example/health', { headers: { authorization: 'Bearer secret-token' } }),
    { ...env, CONTAINER: '' },
  );
  assert.equal(res.status, 500);
});
