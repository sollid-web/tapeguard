import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { circuit, NETLIST, FACTS, spec, evaluate } from './guard-circuit.mjs';

test('guard netlist matches the spec on all 1024 fact vectors', () => {
  assert.equal(circuit.nIn, FACTS.length);
  for (let bits = 0; bits < 1 << circuit.nIn; bits++) {
    const [out] = evaluate(NETLIST, circuit.nIn, circuit.nOut, bits);
    assert.equal(out, spec(bits), `facts=${bits.toString(2).padStart(10, '0')}`);
  }
});

test('the circuit adds a rule the Solidity floor does not have', () => {
  const allSafe = 0xff;
  assert.equal(spec(allSafe), 1);
  assert.equal(spec(allSafe | (1 << 8)), 1);              // large, budget fresh
  assert.equal(spec(allSafe | (1 << 9)), 1);              // small, budget half used
  assert.equal(spec(allSafe | (1 << 8) | (1 << 9)), 0);   // large and half used
});

test('every NAND reads only earlier signals', () => {
  circuit.gates.forEach(([a, b], i) => {
    const self = 2 + circuit.nIn + i;
    assert.ok(a < self && b < self);
  });
});

test('generated files are in sync with the compiler', () => {
  const hex = readFileSync(new URL('guard.netlist.hex', import.meta.url), 'utf8').trim();
  assert.equal(hex, NETLIST);
  const sol = readFileSync(new URL('../foundry/contracts/GuardNetlist.sol', import.meta.url), 'utf8');
  assert.ok(sol.includes(`hex"${NETLIST.slice(2)}"`), 'run node tapeout/generate.mjs');
});
