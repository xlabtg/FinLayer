/**
 * @finlayer/utils
 * Shared utility functions for FinLayer.
 */

import { randomUUID } from 'crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import bs58check from 'bs58check';

// ─── UUID ─────────────────────────────────────────────────────────────────────

export function generateUUID(): string {
  return randomUUID();
}

export function isValidUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// ─── Numeric Precision ────────────────────────────────────────────────────────

type NumericSign = 1 | -1;

interface ParsedNumeric {
  sign: NumericSign;
  unscaled: bigint;
  scale: number;
}

const NUMERIC_STRING_RE = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i;

function parseNumericString(value: string): ParsedNumeric {
  const match = value.trim().match(NUMERIC_STRING_RE);
  if (!match) {
    throw new Error(`Invalid numeric string: ${value}`);
  }

  const sign: NumericSign = match[1] === '-' ? -1 : 1;
  const intPart = match[2] ?? '0';
  const decPart = match[3] ?? match[4] ?? '';
  const exponent = match[5] ? parseInt(match[5], 10) : 0;
  let scale = decPart.length - exponent;
  let digits = `${intPart}${decPart}`.replace(/^0+/, '') || '0';

  if (scale < 0) {
    digits = digits.padEnd(digits.length - scale, '0');
    scale = 0;
  }

  const unscaled = BigInt(digits);
  return {
    sign: unscaled === 0n ? 1 : sign,
    unscaled,
    scale,
  };
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function signedUnscaled(value: ParsedNumeric, targetScale: number): bigint {
  const scaled = value.unscaled * pow10(targetScale - value.scale);
  return value.sign === 1 ? scaled : -scaled;
}

function decimalToString(value: bigint, scale: number): string {
  if (value === 0n) return '0';

  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  if (scale === 0) return `${sign}${abs.toString()}`;

  const str = abs.toString().padStart(scale + 1, '0');
  const intPart = str.slice(0, -scale) || '0';
  const decPart = str.slice(-scale).replace(/0+$/, '');
  return decPart ? `${sign}${intPart}.${decPart}` : `${sign}${intPart}`;
}

/**
 * Safe numeric string addition (avoids floating-point issues).
 * Uses BigInt fixed-point arithmetic and preserves all decimal precision.
 */
export function addNumericStrings(a: string, b: string): string {
  const left = parseNumericString(a);
  const right = parseNumericString(b);
  const scale = Math.max(left.scale, right.scale);
  return decimalToString(
    signedUnscaled(left, scale) + signedUnscaled(right, scale),
    scale
  );
}

export function subtractNumericStrings(a: string, b: string): string {
  const left = parseNumericString(a);
  const right = parseNumericString(b);
  const scale = Math.max(left.scale, right.scale);
  return decimalToString(
    signedUnscaled(left, scale) - signedUnscaled(right, scale),
    scale
  );
}

export function multiplyNumericStrings(a: string, b: string): string {
  const left = parseNumericString(a);
  const right = parseNumericString(b);
  const sign = left.sign === right.sign ? 1n : -1n;
  return decimalToString(sign * left.unscaled * right.unscaled, left.scale + right.scale);
}

export function compareNumericStrings(a: string, b: string): -1 | 0 | 1 {
  const left = parseNumericString(a);
  const right = parseNumericString(b);
  const scale = Math.max(left.scale, right.scale);
  const leftValue = signedUnscaled(left, scale);
  const rightValue = signedUnscaled(right, scale);
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

export function isPositiveNumericString(value: string): boolean {
  try {
    return compareNumericStrings(value, '0') > 0;
  } catch {
    return false;
  }
}

// ─── Asset Validation ─────────────────────────────────────────────────────────

const ASSET_REGEX = /^[A-Z0-9]{2,10}$/;
const EVM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const EVM_NETWORKS = new Set([
  'ethereum',
  'polygon',
  'bsc',
  'arbitrum',
  'optimism',
  'base',
  'avalanche',
]);
const EVM_ASSETS = new Set(['ETH', 'USDC', 'USDT', 'MATIC', 'BNB', 'AVAX']);
const BITCOIN_IDENTIFIERS = new Set(['bitcoin', 'btc']);
const BITCOIN_MAINNET_BASE58_VERSIONS = new Set([0x00, 0x05]);

export function isValidAssetTicker(ticker: string): boolean {
  return ASSET_REGEX.test(ticker);
}

export function isValidCryptoAddress(address: string, networkOrAsset?: string): boolean {
  if (typeof address !== 'string' || address.length === 0 || address !== address.trim()) {
    return false;
  }

  const normalized = networkOrAsset?.trim();
  if (normalized) {
    if (isBitcoinIdentifier(normalized)) return isValidBitcoinBase58Address(address);
    if (isEvmIdentifier(normalized)) return isValidEvmAddress(address);
    return false;
  }

  return isValidEvmAddress(address) || isValidBitcoinBase58Address(address);
}

export function isValidAmount(amount: string): boolean {
  return /^\d+(\.\d+)?$/.test(amount) && isPositiveNumericString(amount);
}

function isBitcoinIdentifier(value: string): boolean {
  return BITCOIN_IDENTIFIERS.has(value.toLowerCase());
}

function isEvmIdentifier(value: string): boolean {
  return EVM_NETWORKS.has(value.toLowerCase()) || EVM_ASSETS.has(value.toUpperCase());
}

function isValidEvmAddress(address: string): boolean {
  if (!EVM_ADDRESS_REGEX.test(address)) {
    return false;
  }

  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) {
    return true;
  }

  return address === toEip55Checksum(address);
}

function toEip55Checksum(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '');
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let checksum = '0x';

  for (let i = 0; i < lower.length; i++) {
    const char = lower[i]!;
    checksum += parseInt(hash[i]!, 16) >= 8 ? char.toUpperCase() : char;
  }

  return checksum;
}

function isValidBitcoinBase58Address(address: string): boolean {
  try {
    const decoded = bs58check.decode(address);
    return decoded.length === 21 && BITCOIN_MAINNET_BASE58_VERSIONS.has(decoded[0]!);
  } catch {
    return false;
  }
}

// ─── API Key Helpers ──────────────────────────────────────────────────────────

/**
 * Generate a new API key.
 *
 * Format: `<prefix>_<keyId>_<secret>` (e.g. `fl_live_<keyId>_<secret>`).
 * The `keyId` is a public, unique, indexable identifier embedded in the key so a
 * single key can be located with one indexed lookup — and verified with exactly
 * one `bcrypt.compare`. Returns the full key (for the user), the keyId and the
 * prefix (both for DB storage).
 */
export function generateApiKey(
  prefix: string = 'fl_live'
): { key: string; keyId: string; keyPrefix: string } {
  const keyId = randomUUID().replace(/-/g, '');
  const secret = randomUUID().replace(/-/g, '');
  const key = `${prefix}_${keyId}_${secret}`;
  return { key, keyId, keyPrefix: prefix };
}

/**
 * Parse an API key into its public components (prefix + keyId).
 * Returns null when the key is malformed.
 *
 * The prefix is the first two underscore-separated segments (e.g. `fl_live`),
 * the keyId is the third segment, and the remaining segment(s) are the secret.
 */
export function parseApiKey(rawKey: string): { prefix: string; keyId: string } | null {
  if (typeof rawKey !== 'string') return null;
  const parts = rawKey.split('_');
  // Expected: <p0>_<p1>_<keyId>_<secret>
  if (parts.length < 4) return null;
  const [p0, p1, keyId] = parts;
  if (!p0 || !p1 || !keyId) return null;
  return { prefix: `${p0}_${p1}`, keyId };
}

// ─── Idempotency ──────────────────────────────────────────────────────────────

export function isValidIdempotencyKey(key: string): boolean {
  return typeof key === 'string' && key.length >= 8 && key.length <= 128;
}

// ─── Error Formatting ─────────────────────────────────────────────────────────

import type { ApiError, ErrorDomain } from '@finlayer/types';

export function makeError(
  code: string,
  message: string,
  domain: ErrorDomain,
  options: Partial<Omit<ApiError, 'code' | 'message' | 'domain'>> = {}
): ApiError {
  return {
    code,
    message,
    domain,
    retryable: options.retryable ?? false,
    ...options,
  };
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export function parsePagination(query: Record<string, unknown>): { page: number; limit: number; offset: number } {
  const page = Math.max(1, parseInt(String(query['page'] ?? '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(query['limit'] ?? '20'), 10)));
  return { page, limit, offset: (page - 1) * limit };
}

// ─── Date Helpers ─────────────────────────────────────────────────────────────

export function nowISO(): string {
  return new Date().toISOString();
}

export function futureISO(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}
