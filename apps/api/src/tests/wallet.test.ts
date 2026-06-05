/**
 * Unit + integration tests for Phase 4 wallet module.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { randomBytes } from 'crypto';

import {
  newMnemonic,
  isValidMnemonic,
  deriveAddress,
  isSupportedPair,
  SUPPORTED_PAIRS,
} from '../../../../modules/wallet/hd.js';
import {
  encrypt,
  decrypt,
  __setEncryptionKeyForTests,
} from '../../../../modules/wallet/crypto.js';
import { WalletService } from '../../../../modules/wallet/service.js';
import { MockBalanceProvider } from '../../../../modules/providers/mock-balance/adapter.js';
import { UnsupportedAssetError, WalletConfigError } from '../../../../modules/shared/errors/index.js';
import type {
  BalanceQueryParams,
  IWalletBalanceProvider,
  WalletBalanceResult,
} from '../../../../modules/shared/types/index.js';
import { createMockSql, createTestUserId } from './setup.js';

// A reusable BIP39 test vector so derivation is reproducible across runs.
// Source: https://github.com/trezor/python-mnemonic/blob/master/vectors.json (entry 0).
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

class TokenAwareBalanceProvider implements IWalletBalanceProvider {
  public readonly name = 'TokenAwareBalance';
  public readonly supportedNetworks = ['ethereum'];
  public nativeCalls = 0;
  public tokenCalls = 0;
  public lastTokenQuery: BalanceQueryParams | null = null;

  async getNativeBalance(params: BalanceQueryParams): Promise<WalletBalanceResult> {
    this.nativeCalls += 1;
    return {
      network: params.network,
      address: params.address,
      asset: 'ETH',
      balance: '2',
      decimals: 18,
      updatedAt: new Date().toISOString(),
    };
  }

  async getTokenBalances(params: BalanceQueryParams): Promise<WalletBalanceResult[]> {
    this.tokenCalls += 1;
    this.lastTokenQuery = params;
    return [{
      network: params.network,
      address: params.address,
      asset: params.asset ?? 'USDC',
      balance: '42.25',
      decimals: params.tokenDecimals ?? 6,
      updatedAt: new Date().toISOString(),
    }];
  }
}

describe('wallet/hd', () => {
  test('newMnemonic generates 12-word BIP39 phrase', () => {
    const m = newMnemonic();
    expect(m.split(' ').length).toBe(12);
    expect(isValidMnemonic(m)).toBe(true);
  });

  test('deriveAddress returns deterministic ETH address for a known mnemonic', () => {
    const d = deriveAddress(TEST_MNEMONIC, 'ETH', 'ethereum', 0, 0);
    // Ledger / MyEtherWallet standard BIP44 first address for this mnemonic.
    expect(d.address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    expect(d.derivationPath).toBe("m/44'/60'/0'/0/0");
    expect(d.asset).toBe('ETH');
    expect(d.network).toBe('ethereum');
    expect(d.publicKey.length).toBe(66); // 33-byte compressed pubkey → 66 hex chars
  });

  test('deriveAddress returns deterministic BTC P2PKH address', () => {
    const d = deriveAddress(TEST_MNEMONIC, 'BTC', 'bitcoin', 0, 0);
    // Classic BIP44 first receive address for "abandon × 11 about".
    expect(d.address).toBe('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
    expect(d.derivationPath).toBe("m/44'/0'/0'/0/0");
  });

  test('deriveAddress is stable across calls', () => {
    const a = deriveAddress(TEST_MNEMONIC, 'ETH', 'ethereum', 0, 0);
    const b = deriveAddress(TEST_MNEMONIC, 'ETH', 'ethereum', 0, 0);
    expect(a.address).toBe(b.address);
  });

  test('deriveAddress increments address_index', () => {
    const a = deriveAddress(TEST_MNEMONIC, 'ETH', 'ethereum', 0, 0);
    const b = deriveAddress(TEST_MNEMONIC, 'ETH', 'ethereum', 0, 1);
    expect(a.address).not.toBe(b.address);
  });

  test('isSupportedPair covers all default SUPPORTED_PAIRS', () => {
    for (const p of SUPPORTED_PAIRS) {
      expect(isSupportedPair(p.asset, p.network)).toBe(true);
    }
    expect(isSupportedPair('FOO', 'mars')).toBe(false);
  });

  test('deriveAddress throws UnsupportedAssetError for unknown network', () => {
    expect(() => deriveAddress(TEST_MNEMONIC, 'ETH', 'unknown-chain'))
      .toThrow(UnsupportedAssetError);
  });

  test('EVM addresses are EIP-55 checksummed', () => {
    const d = deriveAddress(TEST_MNEMONIC, 'ETH', 'ethereum', 0, 0);
    // Checksummed addresses contain mixed case (unless all digits, which is
    // vanishingly unlikely for random addresses).
    expect(d.address).toMatch(/0x[0-9A-Fa-f]{40}/);
    expect(d.address).not.toBe(d.address.toLowerCase());
  });
});

describe('wallet/crypto', () => {
  beforeEach(() => {
    // Deterministic test key (32 bytes)
    __setEncryptionKeyForTests(randomBytes(32));
  });

  afterEach(() => {
    __setEncryptionKeyForTests(null);
    delete process.env['WALLET_ENCRYPTION_KEY'];
  });

  test('encrypt → decrypt round-trips a mnemonic', () => {
    const pt = TEST_MNEMONIC;
    const ct = encrypt(pt);
    expect(ct).not.toContain(pt);
    expect(ct.split(':')).toHaveLength(3); // iv:tag:ciphertext
    expect(decrypt(ct)).toBe(pt);
  });

  test('encrypt produces distinct ciphertexts for identical plaintext (IV randomness)', () => {
    const a = encrypt('hello');
    const b = encrypt('hello');
    expect(a).not.toBe(b);
  });

  test('decrypt with tampered ciphertext throws', () => {
    const ct = encrypt('secret');
    const [iv, tag, data] = ct.split(':');
    const tampered = `${iv}:${tag}:${Buffer.from('tampered').toString('base64')}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  test('missing WALLET_ENCRYPTION_KEY throws WalletConfigError', () => {
    __setEncryptionKeyForTests(null);
    delete process.env['WALLET_ENCRYPTION_KEY'];
    expect(() => encrypt('x')).toThrow(WalletConfigError);
  });

  test('key accepts 64-char hex and base64 encodings', () => {
    __setEncryptionKeyForTests(null);
    process.env['WALLET_ENCRYPTION_KEY'] = randomBytes(32).toString('hex');
    expect(() => encrypt('x')).not.toThrow();

    __setEncryptionKeyForTests(null);
    process.env['WALLET_ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
    expect(() => encrypt('x')).not.toThrow();
  });
});

describe('WalletService', () => {
  let walletService: WalletService;
  let userId: string;
  let mockBalance: MockBalanceProvider;

  beforeEach(() => {
    __setEncryptionKeyForTests(randomBytes(32));
    mockBalance = new MockBalanceProvider();
    const providers = new Map<string, IWalletBalanceProvider>([['MockBalance', mockBalance]]);
    const mockSql = createMockSql();
    walletService = new WalletService(mockSql as never, providers);
    userId = createTestUserId();
  });

  afterEach(() => {
    __setEncryptionKeyForTests(null);
  });

  test('generateWallet creates mnemonic + default addresses once', async () => {
    const first = await walletService.generateWallet(userId);
    expect(first.created).toBe(true);
    expect(first.mnemonic).toBeDefined();
    expect(first.addresses.length).toBe(SUPPORTED_PAIRS.length);
    expect(first.wallet_id).toBeDefined();

    // The mnemonic is ONLY returned on first creation
    const second = await walletService.generateWallet(userId);
    expect(second.created).toBe(false);
    expect(second.mnemonic).toBeUndefined();
    expect(second.addresses.length).toBe(SUPPORTED_PAIRS.length);
    expect(second.wallet_id).toBe(first.wallet_id);
  });

  test('listAddresses returns all derived addresses', async () => {
    await walletService.generateWallet(userId);
    const addrs = await walletService.listAddresses(userId);
    expect(addrs.length).toBe(SUPPORTED_PAIRS.length);
    expect(addrs.every(a => a.address.length > 0)).toBe(true);
  });

  test('createAddress is idempotent for the same (asset, network)', async () => {
    await walletService.generateWallet(userId);
    const a = await walletService.createAddress(userId, { asset: 'ETH', network: 'ethereum' });
    const b = await walletService.createAddress(userId, { asset: 'ETH', network: 'ethereum' });
    expect(a.id).toBe(b.id);
    expect(a.address).toBe(b.address);
  });

  test('createAddress rejects unsupported pairs', async () => {
    await walletService.generateWallet(userId);
    await expect(
      walletService.createAddress(userId, { asset: 'DOGE', network: 'mars' })
    ).rejects.toBeInstanceOf(UnsupportedAssetError);
  });

  test('getBalance delegates to provider matching the network', async () => {
    const gen = await walletService.generateWallet(userId);
    const eth = gen.addresses.find(a => a.network === 'ethereum')!;
    mockBalance.setBalance('ethereum', eth.address, '1.5');

    const balance = await walletService.getBalance(userId, eth.id);
    expect(balance.asset).toBe('ETH');
    expect(balance.network).toBe('ethereum');
    expect(balance.balance).toBe('1.5');
    expect(balance.address).toBe(eth.address);
  });

  test('getBalance requests token balance for non-native asset addresses', async () => {
    const tokenProvider = new TokenAwareBalanceProvider();
    walletService = new WalletService(
      createMockSql() as never,
      new Map<string, IWalletBalanceProvider>([['TokenAwareBalance', tokenProvider]])
    );

    const gen = await walletService.generateWallet(userId);
    const usdc = gen.addresses.find(a => a.asset === 'USDC' && a.network === 'ethereum')!;

    const balance = await walletService.getBalance(userId, usdc.id);

    expect(balance.asset).toBe('USDC');
    expect(balance.network).toBe('ethereum');
    expect(balance.balance).toBe('42.25');
    expect(balance.address).toBe(usdc.address);
    expect(tokenProvider.nativeCalls).toBe(0);
    expect(tokenProvider.tokenCalls).toBe(1);
    expect(tokenProvider.lastTokenQuery).toMatchObject({
      network: 'ethereum',
      address: usdc.address,
      asset: 'USDC',
      tokenContract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      tokenDecimals: 6,
    });
  });

  test('listSupportedPairs returns all BIP44 default pairs', () => {
    const pairs = walletService.listSupportedPairs();
    expect(pairs.length).toBe(SUPPORTED_PAIRS.length);
    expect(pairs).toContainEqual({ asset: 'ETH', network: 'ethereum' });
    expect(pairs).toContainEqual({ asset: 'BTC', network: 'bitcoin' });
  });
});
