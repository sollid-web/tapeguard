// Minimal secp256k1 signer + legacy (EIP-155) transaction serialiser.
//
// Why it exists: a Cloudflare Worker has no secp256k1 in WebCrypto and may not
// import npm packages, but the always-on daemon has to be able to submit the
// transaction that an already-approved action needs while the owner is asleep.
// The key used here is a *relayer* key: it can only push actions the policy
// circuit approved, it cannot withdraw or reconfigure anything, so a leak
// degrades to "the agent stops working", never "the funds are gone".
//
// `selfTest()` proves the implementation against the well known address of
// private key 1 and a sign/recover round trip. If it fails, the engine refuses
// to broadcast and falls back to queueing, so a wrong signature can never be
// mistaken for a working daemon.

import { keccak256, toHex } from './keccak.js';

const P = BigInt('0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f');
const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const HALF_N = N >> 1n;
const G = {
  x: BigInt('0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'),
  y: BigInt('0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8'),
};

const PRIV_VECTOR = '0x0000000000000000000000000000000000000000000000000000000000000001';
const ADDRESS_VECTOR = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';

/* ----------------------------------------------------------------- linear algebra */

function mod (a, m) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function modInv (a, m) {
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error('not invertible');
  return mod(oldS, m);
}

function powmod (base, exp, m) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function pointAdd (a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.x === b.x && mod(a.y + b.y, P) === 0n) return null;
  let lambda;
  if (a.x === b.x && a.y === b.y) {
    lambda = mod(3n * a.x * a.x * modInv(2n * a.y, P), P);
  } else {
    lambda = mod((b.y - a.y) * modInv(b.x - a.x, P), P);
  }
  const x = mod(lambda * lambda - a.x - b.x, P);
  const y = mod(lambda * (a.x - x) - a.y, P);
  return { x, y };
}

function pointMul (k, p) {
  let result = null;
  let addend = p;
  let scalar = k;
  while (scalar > 0n) {
    if (scalar & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    scalar >>= 1n;
  }
  return result;
}

/* ----------------------------------------------------------------------- bytes */

function hexToBytes (hex) {
  const clean = String(hex ?? '').replace(/^0x/i, '');
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error('bad hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bigToBytes (value, size = null) {
  let hex = mod(BigInt(value), 1n << 256n).toString(16);
  if (hex === '0') hex = '';
  if (hex.length % 2 === 1) hex = '0' + hex;
  const bytes = hexToBytes(hex);
  if (size === null) return bytes;
  if (bytes.length > size) throw new Error('number too large');
  const out = new Uint8Array(size);
  out.set(bytes, size - bytes.length);
  return out;
}

function concat (parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function isPrivateKey (value) {
  try {
    const d = BigInt(String(value ?? '').startsWith('0x') ? String(value) : '0x' + String(value));
    return d > 0n && d < N;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- keys & signature */

export function publicKey (privHex) {
  const d = BigInt(privHex);
  if (d <= 0n || d >= N) throw new Error('private key out of range');
  const point = pointMul(d, G);
  if (!point) throw new Error('invalid private key');
  return point;
}

export function addressFromPublicKey (point) {
  const hash = keccak256(concat([bigToBytes(point.x, 32), bigToBytes(point.y, 32)]));
  return '0x' + toHex(hash.slice(12));
}

export function addressFromPrivateKey (privHex) {
  return addressFromPublicKey(publicKey(privHex));
}

async function hmacSha256 (key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data));
}

/** RFC 6979 deterministic nonce (HMAC-SHA256 variant), as every Ethereum signer uses. */
async function deterministicK (privBytes, digestBytes) {
  const zBytes = bigToBytes(BigInt('0x' + toHex(digestBytes)) % N, 32);
  let k = new Uint8Array(32);
  let v = new Uint8Array(32).fill(1);

  k = await hmacSha256(k, concat([v, new Uint8Array([0]), privBytes, zBytes]));
  v = await hmacSha256(k, v);
  k = await hmacSha256(k, concat([v, new Uint8Array([1]), privBytes, zBytes]));
  v = await hmacSha256(k, v);

  for (let i = 0; i < 1024; i++) {
    v = await hmacSha256(k, v);
    const candidate = BigInt('0x' + toHex(v));
    if (candidate > 0n && candidate < N) return candidate;
    k = await hmacSha256(k, concat([v, new Uint8Array([0])]));
    v = await hmacSha256(k, v);
  }
  throw new Error('could not derive a nonce');
}

/** ECDSA over secp256k1 with low-s normalisation. @returns {{r:bigint,s:bigint,v:number}} */
export async function signDigest (privHex, digestBytes) {
  const d = BigInt(privHex);
  const privBytes = bigToBytes(d, 32);
  const z = BigInt('0x' + toHex(digestBytes));
  let nonce = await deterministicK(privBytes, digestBytes);

  for (let attempt = 0; attempt < 32; attempt++) {
    const point = pointMul(nonce, G);
    if (point) {
      const r = mod(point.x, N);
      if (r !== 0n) {
        let s = mod(modInv(nonce, N) * (z + r * d), N);
        if (s !== 0n) {
          let recovery = point.y % 2n === 0n ? 0 : 1;
          if (s > HALF_N) {
            s = N - s;
            recovery ^= 1;
          }
          return { r, s, v: recovery };
        }
      }
    }
    nonce = nonce + 1n < N ? nonce + 1n : nonce - 1n;
  }
  throw new Error('signing failed');
}

/** Public-key recovery, used by the self-test to prove a signature is valid. */
export function recoverAddress (digestBytes, r, s, recovery) {
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw new Error('signature out of range');
  const x = r;
  const ySquared = mod(x * x * x + 7n, P);
  let y = powmod(ySquared, (P + 1n) / 4n, P);
  if (mod(y * y, P) !== ySquared) throw new Error('not a point');
  if (mod(y, 2n) !== BigInt(recovery % 2)) y = P - y;

  const z = BigInt('0x' + toHex(digestBytes));
  const rInv = modInv(r, N);
  const u1 = mod(-z * rInv, N);
  const u2 = mod(s * rInv, N);
  const point = pointAdd(pointMul(u1, G), pointMul(u2, { x, y }));
  if (!point) throw new Error('recovery failed');
  return addressFromPublicKey(point);
}

/* ------------------------------------------------------------------- RLP + tx */

function rlpLength (length, offset) {
  if (length < 56) return new Uint8Array([offset + length]);
  let hex = length.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  const bytes = hexToBytes(hex);
  return concat([new Uint8Array([offset + 55 + bytes.length]), bytes]);
}

function rlp (item) {
  if (Array.isArray(item)) {
    const body = concat(item.map(rlp));
    return concat([rlpLength(body.length, 0xc0), body]);
  }
  const bytes = item instanceof Uint8Array ? item : bigToBytes(item);
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return concat([rlpLength(bytes.length, 0x80), bytes]);
}

/**
 * Builds a signed legacy (EIP-155) transaction.
 * @param {object} tx { chainId, nonce, gasPrice, gasLimit, to, value, data } - BigInts, `to`/`data` hex
 * @param {string} privHex relayer private key
 * @returns {Promise<string>} raw transaction, ready for eth_sendRawTransaction
 */
export async function signTransaction (tx, privHex) {
  const to = hexToBytes(tx.to);
  const data = hexToBytes(tx.data ?? '0x');
  const chainId = BigInt(tx.chainId);
  const base = [BigInt(tx.nonce), BigInt(tx.gasPrice), BigInt(tx.gasLimit), to, BigInt(tx.value), data];
  const digest = keccak256(rlp([...base, chainId, 0n, 0n]));
  const sig = await signDigest(privHex, digest);
  const v = BigInt(sig.v) + 35n + 2n * chainId;
  const signed = rlp([...base, v, bigToBytes(sig.r, 32), bigToBytes(sig.s, 32)]);
  return '0x' + toHex(signed);
}

/**
 * Builds a signed EIP-1559 (type 2) transaction, which is what X Layer expects and
 * what lets a stuck keeper transaction be replaced with a higher fee.
 * @param {object} tx { chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data }
 * @param {string} privHex relayer private key
 * @returns {Promise<string>} raw transaction, ready for eth_sendRawTransaction
 */
export async function signDynamicFee (tx, privHex) {
  const fields = [
    BigInt(tx.chainId),
    BigInt(tx.nonce),
    BigInt(tx.maxPriorityFeePerGas),
    BigInt(tx.maxFeePerGas),
    BigInt(tx.gasLimit),
    hexToBytes(tx.to),
    BigInt(tx.value),
    hexToBytes(tx.data ?? '0x'),
    [],
  ];
  const unsigned = concat([new Uint8Array([0x02]), rlp(fields)]);
  const digest = keccak256(unsigned);
  const sig = await signDigest(privHex, digest);
  const signed = rlp([...fields, BigInt(sig.v), bigToBytes(sig.r, 32), bigToBytes(sig.s, 32)]);
  return '0x02' + toHex(signed);
}

/* ------------------------------------------------------------------- self-test */

let cached = null;

/** Proves key derivation, signing and recovery agree with Ethereum. */
export async function selfTest () {
  if (cached) return cached;
  const result = { ok: false, address: null, reason: '' };
  try {
    const address = addressFromPrivateKey(PRIV_VECTOR);
    result.address = address;
    if (address !== ADDRESS_VECTOR) {
      result.reason = `key derivation mismatch: ${address} != ${ADDRESS_VECTOR}`;
      cached = result;
      return result;
    }
    const digest = keccak256(new TextEncoder().encode('tapeguardian.signer.selftest'));
    const sig = await signDigest(PRIV_VECTOR, digest);
    const recovered = recoverAddress(digest, sig.r, sig.s, sig.v);
    if (recovered !== address) {
      result.reason = `signature recovery mismatch: ${recovered} != ${address}`;
      cached = result;
      return result;
    }
    const raw = await signTransaction({
      chainId: 196, nonce: 0n, gasPrice: 1000000000n, gasLimit: 21000n,
      to: '0x0000000000000000000000000000000000000000', value: 0n, data: '0x',
    }, PRIV_VECTOR);
    if (!/^0x[0-9a-f]{100,}$/.test(raw)) {
      result.reason = 'transaction serialisation produced unexpected output';
      cached = result;
      return result;
    }
    const dynamic = await signDynamicFee({
      chainId: 196, nonce: 0n, maxPriorityFeePerGas: 1000000n, maxFeePerGas: 2000000000n,
      gasLimit: 21000n, to: '0x0000000000000000000000000000000000000000', value: 0n, data: '0x',
    }, PRIV_VECTOR);
    if (!/^0x02[0-9a-f]{100,}$/.test(dynamic)) {
      result.reason = 'type-2 serialisation produced unexpected output';
      cached = result;
      return result;
    }
    result.ok = true;
    cached = result;
    return result;
  } catch (error) {
    result.reason = String(error && error.message ? error.message : error);
    cached = result;
    return result;
  }
}