/**
 * modules/wallet/crypto.ts
 * Symmetric encryption helpers for at-rest mnemonic storage.
 *
 * Uses AES-256-GCM from Node's built-in crypto module. A single 32-byte key
 * comes from the WALLET_ENCRYPTION_KEY env var (hex or base64 encoded).
 * Ciphertext format: base64(iv) : base64(authTag) : base64(ciphertext)
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { WalletConfigError } from '../shared/errors/index.js';

const ALGO = 'aes-256-gcm' as const;
const IV_LENGTH = 12; // GCM recommended

let cachedKey: Buffer | null = null;

export function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env['WALLET_ENCRYPTION_KEY'];
  if (!raw) {
    throw new WalletConfigError('WALLET_ENCRYPTION_KEY is not set');
  }
  const key = decodeKey(raw);
  if (key.length !== 32) {
    throw new WalletConfigError('WALLET_ENCRYPTION_KEY must decode to 32 bytes');
  }
  cachedKey = key;
  return key;
}

/**
 * Test-only helper: force a specific encryption key. Resets the cache.
 * Not exported from the module index.
 */
export function __setEncryptionKeyForTests(key: Buffer | null): void {
  cachedKey = key;
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decrypt(payload: string): string {
  const key = getEncryptionKey();
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new WalletConfigError('Malformed ciphertext payload');
  }
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

function decodeKey(raw: string): Buffer {
  // Accept 64-char hex, or base64
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return Buffer.from(raw, 'base64');
}
