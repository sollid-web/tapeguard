// Minimal Keccak-256 (the Ethereum flavour) in pure JavaScript.
// Cloudflare Workers only ship SHA-2 in WebCrypto, and a server may not import
// npm packages, so the hash that turns a function signature into a 4 byte
// selector (and an event signature into a topic) is implemented here.
//
// The implementation is verified against known vectors in `selfTest()`; the API
// returns a clear error instead of silently using wrong selectors.

const MASK = (1n << 64n) - 1n;
const RATE = 136; // 1088 bit rate for 256 bit output

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets, indexed as x + 5y.
const ROT = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function rotl (value, bits) {
  const b = BigInt(bits);
  return ((value << b) | (value >> (64n - b))) & MASK;
}

function permute (a) {
  for (let round = 0; round < 24; round++) {
    const c = new Array(5);
    for (let x = 0; x < 5; x++) {
      c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    }
    const d = new Array(5);
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) a[x + 5 * y] ^= d[x];
    }

    const b = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x + 5 * y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        a[x + 5 * y] = b[x + 5 * y] ^ ((~b[((x + 1) % 5) + 5 * y] & MASK) & b[((x + 2) % 5) + 5 * y]);
      }
    }
    a[0] ^= RC[round];
  }
  return a;
}

/** @param {Uint8Array} input @returns {Uint8Array} 32 bytes */
export function keccak256 (input) {
  const msg = input instanceof Uint8Array ? input : new Uint8Array(input);
  const padded = new Uint8Array(Math.ceil((msg.length + 1) / RATE) * RATE);
  padded.set(msg);
  padded[msg.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const state = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      state[i] ^= lane;
    }
    permute(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i];
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

const encoder = new TextEncoder();

export function toHex (bytes) {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** keccak256 of a UTF-8 string, as hex without 0x. */
export function keccakHex (text) {
  return toHex(keccak256(encoder.encode(text)));
}

/** 0x + first 4 bytes of the hash of `signature`, e.g. "transfer(address,uint256)". */
export function selector (signature) {
  return '0x' + keccakHex(signature).slice(0, 8);
}

/** 0x + 32 byte event topic for `signature`. */
export function topic (signature) {
  return '0x' + keccakHex(signature);
}

const VECTORS = [
  ['', 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
  ['transfer(address,uint256)', 'a9059cbb'],
  ['balanceOf(address)', '70a08231'],
  ['paused()', '5c975abb'],
  ['owner()', '8da5cb5b'],
];

let testResult = null;

/** Compares the implementation with well known Ethereum values. */
export function selfTest () {
  if (testResult) return testResult;
  const failures = [];
  for (const [input, expected] of VECTORS) {
    const actual = input.includes('(') ? keccakHex(input).slice(0, 8) : keccakHex(input);
    if (actual !== expected) failures.push(`${input || '<empty>'}: ${actual} != ${expected}`);
  }
  testResult = { ok: failures.length === 0, failures };
  return testResult;
}

export function assertKeccak () {
  const result = selfTest();
  if (!result.ok) {
    throw new Error('keccak256 self-test failed: ' + result.failures.join(', '));
  }
}
