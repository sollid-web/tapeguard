import test from 'node:test';
import assert from 'node:assert/strict';
import { signerConfigured, signerStatus, signTransactionRemotely } from './signer.js';

const address = '0x1234567890123456789012345678901234567890';
const env = {
  SIGNER_URL: 'https://signer.example.test',
  SIGNER_TOKEN: 'test-token',
  RELAYER_ADDRESS: address,
};
const tx = {
  chainId: 196,
  nonce: 3n,
  gasLimit: 100000n,
  to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  value: 0n,
  data: '0x1234',
  maxPriorityFeePerGas: 100n,
  maxFeePerGas: 200n,
};

test('external signer requires HTTPS, credentials, and a valid configured address', () => {
  assert.equal(signerConfigured(env), true);
  assert.equal(signerConfigured({ ...env, SIGNER_URL: 'http://signer.example.test' }), false);
  assert.equal(signerConfigured({ ...env, RELAYER_ADDRESS: 'invalid' }), false);
  assert.equal(signerConfigured({ ...env, SIGNER_TOKEN: '' }), false);
});

test('external signer health must match the configured relayer address', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://signer.example.test/health');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return Response.json({ ok: true, address });
  };
  try {
    assert.deepEqual(await signerStatus(env), { ok: true, address, reason: '' });
    globalThis.fetch = async () => Response.json({ ok: true, address: '0x0000000000000000000000000000000000000001' });
    assert.equal((await signerStatus(env)).ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('external signer receives transaction fields and must return the expected signer', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://signer.example.test/sign');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    const request = JSON.parse(options.body);
    assert.equal(request.type, 'eip1559');
    assert.deepEqual(request.transaction, {
      chainId: '0xc4',
      nonce: '0x3',
      gasLimit: '0x186a0',
      to: tx.to,
      value: '0x0',
      data: '0x1234',
      maxPriorityFeePerGas: '0x64',
      maxFeePerGas: '0xc8',
    });
    return Response.json({ address, rawTransaction: '0x' + 'ab'.repeat(65) });
  };
  try {
    assert.match(await signTransactionRemotely(env, tx, 'eip1559'), /^0x(?:[0-9a-f]{2})+$/i);
    globalThis.fetch = async () => Response.json({ address: '0x0000000000000000000000000000000000000001', rawTransaction: '0xab' });
    await assert.rejects(signTransactionRemotely(env, tx, 'eip1559'), /different relayer address/);
    globalThis.fetch = async () => Response.json({ address, rawTransaction: 'not-hex' });
    await assert.rejects(signTransactionRemotely(env, tx, 'eip1559'), /invalid raw transaction/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
