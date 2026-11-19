// TapeGuard guard circuit: the policy verdict as a TapeOut NAND netlist.
//
// TapeOut netlist format (X Layer, chain 196):
//   signals 0 and 1 are the constants 0 and 1, inputs start at signal 2,
//   every element appends its output signal(s), the last nOut signals are the outputs.
//   NAND  = 0x00 · a:u24 · b:u24   (new signal = NOT(a AND b))
// Inputs and outputs are bit-packed LSB-first.
//
// The fact bits come from PolicyCircuit (FACT_* constants, same order):
export const FACTS = [
  'NOT_PAUSED',          // 0
  'AGENT_AUTHORISED',    // 1
  'TARGET_ALLOWED',      // 2
  'FUNCTION_ALLOWED',    // 3
  'RECIPIENT_SAFE',      // 4  swap output goes to the agent, min-out > 0
  'WITHIN_PER_ACTION',   // 5
  'WITHIN_DAILY',        // 6
  'WITHIN_ACTION_COUNT', // 7
  'LARGE_ACTION',        // 8  value > maxPerAction / 2
  'BUDGET_HALF_USED',    // 9  spent today >= dailyLimit / 2
];

// APPROVE = all eight safety facts AND NOT(LARGE_ACTION AND BUDGET_HALF_USED)
// The second clause exists only in the circuit: once half of the day's budget is
// spent, the agent may only take small steps.
export function spec(bits) {
  const b = (i) => (bits >> i) & 1;
  let safe = 1;
  for (let i = 0; i < 8; i++) safe &= b(i);
  return safe & (1 - (b(8) & b(9)));
}

export function build() {
  const nIn = FACTS.length;
  const gates = [];
  let next = 2 + nIn;
  const nand = (a, b) => { gates.push([a, b]); return next++; };
  const and = (a, b) => { const n = nand(a, b); return nand(n, n); };
  const input = (i) => 2 + i;

  // balanced AND tree over the eight safety facts
  let level = [0, 1, 2, 3, 4, 5, 6, 7].map(input);
  while (level.length > 1) {
    const up = [];
    for (let i = 0; i < level.length; i += 2) up.push(and(level[i], level[i + 1]));
    level = up;
  }
  const notStretched = nand(input(8), input(9)); // NOT(LARGE AND HALF_USED)
  and(level[0], notStretched);                    // last signal = the output
  return { nIn, nOut: 1, gates };
}

const u24 = (n) => n.toString(16).padStart(6, '0');

export function encode({ gates }) {
  return '0x' + gates.map(([a, b]) => '00' + u24(a) + u24(b)).join('');
}

// Reference evaluator for NAND-only netlists (mirrors TapeOut's eval semantics).
export function evaluate(hex, nIn, nOut, inputBits) {
  const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  const sig = [0, 1];
  for (let i = 0; i < nIn; i++) sig.push((inputBits >> i) & 1);
  for (let off = 0; off < bytes.length; off += 7) {
    if (bytes[off] !== 0) throw new Error('only NAND supported here');
    const a = bytes.readUIntBE(off + 1, 3);
    const b = bytes.readUIntBE(off + 4, 3);
    if (a >= sig.length || b >= sig.length) throw new Error('NAND: future signal');
    sig.push(1 - (sig[a] & sig[b]));
  }
  return sig.slice(sig.length - nOut);
}

export const circuit = build();
export const NETLIST = encode(circuit);
