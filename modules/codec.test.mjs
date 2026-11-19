import test from 'node:test';
import assert from 'node:assert/strict';
// codec.js is browser code (window.TextEncoder); give it a window under Node.
globalThis.window ??= globalThis;
const { encodeCall } = await import('./codec.js');

// Reference: cast calldata "execute(address,uint256,bytes,uint8)" <container> 12345 <setPaused(true)> 0
const EXPECTED =
  '0x51945447' +
  '00000000000000000000000023a28fcdfa235116e39c38d32b2e597676d03240' +
  '0000000000000000000000000000000000000000000000000000000000003039' +
  '0000000000000000000000000000000000000000000000000000000000000080' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000024' +
  '16c38b3c00000000000000000000000000000000000000000000000000000000' +
  '0000000100000000000000000000000000000000000000000000000000000000';

test('TapeOut container execute() is encoded exactly like Solidity', () => {
  const item = { name: 'execute', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' }] };
  const inner = '0x16c38b3c0000000000000000000000000000000000000000000000000000000000000001';
  const { data } = encodeCall(item, ['0x23a28fcdfa235116e39c38d32b2e597676d03240', '12345', inner, 0]);
  assert.equal(data, EXPECTED);
});
