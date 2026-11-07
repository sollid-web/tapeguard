// Tiny ABI encoder / decoder. Enough for the read and write calls this server
// makes to the PolicyCircuit and AgentContainer contracts - no npm dependency.

import { selector, topic } from './keccak.js';

export { selector, topic };

export function strip (hex) {
  return String(hex ?? '').replace(/^0x/i, '').toLowerCase();
}

export function isAddress (value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value ?? ''));
}

export function isData (value) {
  return /^0x([0-9a-fA-F]{2})*$/.test(String(value ?? ''));
}

export function isHash (value) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(value ?? ''));
}

export function encodeAddress (address) {
  if (!isAddress(address)) throw new Error('invalid address: ' + address);
  return strip(address).padStart(64, '0');
}

export function encodeUint (value) {
  const big = BigInt(value);
  if (big < 0n) throw new Error('negative uint');
  return big.toString(16).padStart(64, '0');
}

export function encodeBool (value) {
  return (value ? '1' : '0').padStart(64, '0');
}

export function encodeBytes4 (value) {
  const hex = strip(value);
  if (hex.length !== 8) throw new Error('invalid bytes4: ' + value);
  return hex.padEnd(64, '0');
}

function encodeBytesTail (dataHex) {
  const body = strip(dataHex);
  if (body.length % 2 !== 0) throw new Error('odd length data');
  const length = body.length / 2;
  const padded = body.padEnd(Math.ceil(length / 32) * 64, '0');
  return { lengthWord: encodeUint(length), body: padded };
}

/** Call data for a function whose last argument is `bytes`. */
export function encodeCallWithBytes (signature, staticWords, dataHex) {
  const { lengthWord, body } = encodeBytesTail(dataHex);
  const offset = encodeUint((staticWords.length + 1) * 32);
  return selector(signature) + [...staticWords, offset, lengthWord].join('') + body;
}

/** Call data for a function with only static arguments. */
export function encodeCall (signature, words) {
  return selector(signature) + words.join('');
}

export function decodeWords (resultHex, count = null) {
  const hex = strip(resultHex);
  const words = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) words.push(hex.slice(i, i + 64));
  return count === null ? words : words.slice(0, count);
}

export function wordToBigInt (word) {
  return word ? BigInt('0x' + word) : 0n;
}

export function wordToBool (word) {
  return wordToBigInt(word) !== 0n;
}

export function wordToAddress (word) {
  return '0x' + String(word ?? '').slice(24).toLowerCase();
}

export function wordToBytes4 (word) {
  return '0x' + String(word ?? '').slice(0, 8).toLowerCase();
}

export function wordToBytes32 (word) {
  return '0x' + String(word ?? '').slice(0, 64).toLowerCase();
}

function hexToBytes (hex) {
  const clean = strip(hex);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function decodeString (resultHex, wordIndex) {
  const words = decodeWords(resultHex);
  if (words.length <= wordIndex) return '';
  const offsetWords = Number(wordToBigInt(words[wordIndex]) / 32n);
  if (words.length <= offsetWords) return '';
  const length = Number(wordToBigInt(words[offsetWords]));
  const hex = strip(resultHex);
  const start = (offsetWords + 1) * 64;
  const slice = hex.slice(start, start + length * 2);
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(hexToBytes(slice));
  } catch {
    return '';
  }
}

/** Decodes `(bool approved, string reason)` as returned by PolicyCircuit.check. */
export function decodeCheck (resultHex) {
  const words = decodeWords(resultHex);
  return {
    approved: fromBoolWord(words[0]),
    reason: decodeString(resultHex, 1),
  };
}

/** All state-changing calls on this project are `bool`/`uint` getters; this is
 *  the reverse of encodeBool for decoding a bool return value. */
export function fromBoolWord (word) {
  return wordToBool(word);
}

const NATIVE_DECIMALS = 18;

export function formatUnits (value, decimals = NATIVE_DECIMALS) {
  const big = BigInt(value ?? 0);
  const base = 10n ** BigInt(decimals);
  const whole = big / base;
  const frac = (big % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function parseUnits (value, decimals = NATIVE_DECIMALS) {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error('invalid number: ' + text);
  const [whole, frac = ''] = text.split('.');
  if (frac.length > decimals) throw new Error('too many decimals');
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')).toString();
}
