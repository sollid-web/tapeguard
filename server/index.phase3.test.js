import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';

const env = {
  RPC_URL: 'https://rpc.example.test',
  DB: {},
};

async function rpcRequest(body, headers = {}) {
  const request = new Request('https://app.example.test/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  return worker.fetch(request, env, { waitUntil() {} });
}

test('RPC rejects malformed JSON', async () => {
  const response = await rpcRequest('{');
  assert.equal(response.status, 400);
  assert.match(await response.text(), /expected a JSON-RPC body/);
});

test('RPC rejects write methods before contacting upstream', async () => {
  const response = await rpcRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [] }));
  assert.equal(response.status, 403);
  assert.match(await response.text(), /method not allowed/);
});

test('RPC rejects invalid block tags and oversized log ranges', async () => {
  const invalid = await rpcRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0xnope' }] }));
  assert.equal(invalid.status, 400);
  const range = await rpcRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x1390' }] }));
  assert.equal(range.status, 400);
});

test('RPC enforces the inclusive 5000-block log range boundary', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"jsonrpc":"2.0","id":1,"result":[]}', {
    headers: { 'Content-Type': 'application/json' },
  });
  try {
    const requestRange = (toBlock) => rpcRequest(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getLogs',
      params: [{ fromBlock: '0x1', toBlock }],
    }));

    assert.equal((await requestRange('0x1387')).status, 200); // 4,999 inclusive blocks
    assert.equal((await requestRange('0x1388')).status, 200); // 5,000 inclusive blocks
    assert.equal((await requestRange('0x1389')).status, 400); // 5,001 inclusive blocks
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RPC rejects batches larger than the configured limit', async () => {
  const batch = Array.from({ length: 21 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'eth_chainId' }));
  const response = await rpcRequest(JSON.stringify(batch));
  assert.equal(response.status, 413);
});
