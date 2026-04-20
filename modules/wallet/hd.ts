/**
 * modules/wallet/hd.ts
 * BIP39 mnemonic + BIP44 HD derivation for multi-chain addresses.
 *
 * Security posture (Phase 4, development only):
 *  - Mnemonics are encrypted at rest with AES-256-GCM using WALLET_ENCRYPTION_KEY.
 *  - Plaintext mnemonics exist only transiently inside process memory during
 *    generation and derivation.
 *  - This module is a functional placeholder for the MPC / HSM migration called
 *    out in IMPLEMENTATION_PLAN.md. Do NOT treat server-side key custody as
 *    production-ready.
 */

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bytesToHex } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import bs58check from 'bs58check';

import { UnsupportedAssetError } from '../shared/errors/index.js';

// BIP44 coin types — https://github.com/satoshilabs/slips/blob/master/slip-0044.md
const COIN_TYPE: Record<string, number> = {
  bitcoin: 0,
  ethereum: 60,
  polygon: 60,   // EVM-compatible chains share the ETH path by convention
  bsc: 60,
  arbitrum: 60,
  optimism: 60,
  base: 60,
  avalanche: 60,
};

export interface DerivedAddress {
  network: string;
  asset: string;
  address: string;
  publicKey: string;
  derivationPath: string;
}

export interface SupportedPair {
  asset: string;
  network: string;
  coinType: number;
}

export const SUPPORTED_PAIRS: SupportedPair[] = [
  { asset: 'BTC', network: 'bitcoin', coinType: 0 },
  { asset: 'ETH', network: 'ethereum', coinType: 60 },
  { asset: 'USDC', network: 'ethereum', coinType: 60 },
  { asset: 'USDT', network: 'ethereum', coinType: 60 },
  { asset: 'MATIC', network: 'polygon', coinType: 60 },
  { asset: 'BNB', network: 'bsc', coinType: 60 },
];

export function isSupportedPair(asset: string, network: string): boolean {
  return SUPPORTED_PAIRS.some(p => p.asset === asset.toUpperCase() && p.network === network.toLowerCase());
}

/**
 * Generate a new BIP39 mnemonic.
 * 128 bits of entropy = 12 words (industry standard).
 */
export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}

/**
 * Derive an address for a given (asset, network, account, index) from a mnemonic.
 * Path convention: m/44'/<coinType>'/<account>'/0/<index>
 */
export function deriveAddress(
  mnemonic: string,
  asset: string,
  network: string,
  accountIndex = 0,
  addressIndex = 0
): DerivedAddress {
  const coinType = COIN_TYPE[network.toLowerCase()];
  if (coinType === undefined) {
    throw new UnsupportedAssetError(asset, network);
  }

  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const path = bip44Path(coinType, accountIndex, addressIndex);
  const child = root.derive(path);
  if (!child.publicKey) {
    throw new Error('Failed to derive public key');
  }

  const address = addressFromPublicKey(network, child.publicKey);

  return {
    network: network.toLowerCase(),
    asset: asset.toUpperCase(),
    address,
    publicKey: bytesToHex(child.publicKey),
    derivationPath: path,
  };
}

/**
 * Derive an EVM address (Ethereum + compatible chains).
 * EIP-55 checksum is applied.
 */
function evmAddress(publicKey: Uint8Array): string {
  const point = secp256k1.ProjectivePoint.fromHex(publicKey);
  const uncompressed = point.toRawBytes(false); // 65 bytes, leading 0x04
  const hash = keccak_256(uncompressed.slice(1));
  const lower = '0x' + bytesToHex(hash.slice(-20));
  return toChecksumAddress(lower);
}

/** EIP-55 checksum — https://eips.ethereum.org/EIPS/eip-55 */
function toChecksumAddress(lower: string): string {
  const addrLower = lower.toLowerCase().replace(/^0x/, '');
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(addrLower)));
  let out = '0x';
  for (let i = 0; i < addrLower.length; i++) {
    const ch = addrLower[i]!;
    const hex = hash[i]!;
    out += parseInt(hex, 16) >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

/** P2PKH Bitcoin address — legacy (1...) format. */
function btcAddress(publicKey: Uint8Array): string {
  const h160 = ripemd160(sha256(publicKey));
  const prefixed = new Uint8Array(21);
  prefixed[0] = 0x00; // mainnet version
  prefixed.set(h160, 1);
  return bs58check.encode(prefixed);
}

function addressFromPublicKey(network: string, publicKey: Uint8Array): string {
  const net = network.toLowerCase();
  if (net === 'bitcoin') return btcAddress(publicKey);
  const ct = COIN_TYPE[net];
  if (ct === 60) return evmAddress(publicKey);
  throw new UnsupportedAssetError('?', network);
}

function bip44Path(coinType: number, account: number, addressIndex: number): string {
  // Hardened indices use '. Written as string.fromCharCode(39) to keep
  // source-code-friendly without escaping nested template literals.
  const h = String.fromCharCode(39);
  return `m/44${h}/${coinType}${h}/${account}${h}/0/${addressIndex}`;
}
