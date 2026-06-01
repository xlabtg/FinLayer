/**
 * @finlayer/utils
 * Shared utility functions for FinLayer.
 */

import { randomUUID } from 'crypto';

// ─── UUID ─────────────────────────────────────────────────────────────────────

export function generateUUID(): string {
  return randomUUID();
}

export function isValidUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// ─── Numeric Precision ────────────────────────────────────────────────────────

/**
 * Safe numeric string addition (avoids floating-point issues).
 * Uses BigInt for integer part + string manipulation for decimals.
 */
export function addNumericStrings(a: string, b: string): string {
  const [aInt, aDec = ''] = a.split('.');
  const [bInt, bDec = ''] = b.split('.');
  const maxDec = Math.max(aDec.length, bDec.length);
  const aFull = BigInt((aInt ?? '0') + aDec.padEnd(maxDec, '0'));
  const bFull = BigInt((bInt ?? '0') + bDec.padEnd(maxDec, '0'));
  const sum = aFull + bFull;
  const str = sum.toString().padStart(maxDec + 1, '0');
  if (maxDec === 0) return str;
  const intPart = str.slice(0, -maxDec) || '0';
  const decPart = str.slice(-maxDec).replace(/0+$/, '');
  return decPart ? `${intPart}.${decPart}` : intPart;
}

export function multiplyNumericStrings(a: string, b: string): string {
  const [aInt, aDec = ''] = a.split('.');
  const [bInt, bDec = ''] = b.split('.');
  const totalDec = aDec.length + bDec.length;
  const aFull = BigInt((aInt ?? '0') + aDec);
  const bFull = BigInt((bInt ?? '0') + bDec);
  const product = aFull * bFull;
  const str = product.toString().padStart(totalDec + 1, '0');
  if (totalDec === 0) return str;
  const intPart = str.slice(0, -totalDec) || '0';
  const decPart = str.slice(-totalDec).replace(/0+$/, '');
  return decPart ? `${intPart}.${decPart}` : intPart;
}

// ─── Asset Validation ─────────────────────────────────────────────────────────

const ASSET_REGEX = /^[A-Z0-9]{2,10}$/;
const ADDRESS_MIN_LENGTH = 10;

export function isValidAssetTicker(ticker: string): boolean {
  return ASSET_REGEX.test(ticker);
}

export function isValidCryptoAddress(address: string): boolean {
  return typeof address === 'string' && address.length >= ADDRESS_MIN_LENGTH;
}

export function isValidAmount(amount: string): boolean {
  return /^\d+(\.\d+)?$/.test(amount) && parseFloat(amount) > 0;
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
