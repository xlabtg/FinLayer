/**
 * modules/wallet/service.ts
 * Non-custodial HD wallet orchestration.
 *
 * Responsibilities:
 *  - Generate + encrypt BIP39 mnemonics (one per user).
 *  - Derive BIP44 addresses per (asset, network) and persist them.
 *  - Fan out balance queries to the appropriate provider adapter.
 */

import type { SQL } from 'postgres';
import type {
  UUID,
  WalletAddress,
  WalletAddressRequest,
  AssetBalance,
} from '@finlayer/types';
import type { IWalletBalanceProvider } from '../shared/types/index.js';
import {
  ValidationError,
  WalletNotFoundError,
  UnsupportedAssetError,
  BalanceProviderError,
} from '../shared/errors/index.js';
import { logger } from '../shared/utils/logger.js';
import { generateUUID, nowISO } from '@finlayer/utils';
import {
  newMnemonic,
  deriveAddress,
  isSupportedPair,
  SUPPORTED_PAIRS,
} from './hd.js';
import { encrypt, decrypt } from './crypto.js';

interface DbUserWallet {
  id: string;
  user_id: string;
  encrypted_mnemonic: string;
  encryption_version: number;
  derivation_scheme: string;
  created_at: Date;
  updated_at: Date;
}

interface DbWalletAddress {
  id: string;
  user_id: string;
  asset: string;
  network: string;
  address: string;
  label: string | null;
  derivation_path: string | null;
  account_index: number | null;
  address_index: number | null;
  public_key: string | null;
  created_at: Date;
}

export interface WalletGenerateResult {
  wallet_id: UUID;
  created: boolean;
  addresses: WalletAddress[];
  /**
   * Mnemonic is returned ONLY on first-time generation so the user can
   * back it up off-server. Subsequent calls return addresses without mnemonic.
   */
  mnemonic?: string;
}

export class WalletService {
  constructor(
    private readonly sql: SQL,
    private readonly balanceProviders: Map<string, IWalletBalanceProvider>
  ) {}

  /**
   * Generate or return the user's HD wallet plus default addresses.
   * First call creates a new mnemonic and seeds one address per supported pair.
   */
  async generateWallet(userId: UUID): Promise<WalletGenerateResult> {
    const [existing] = await this.sql<DbUserWallet[]>`
      SELECT * FROM user_wallets WHERE user_id = ${userId}
    `;

    if (existing) {
      const addresses = await this.listAddresses(userId);
      return { wallet_id: existing.id, created: false, addresses };
    }

    const mnemonic = newMnemonic();
    const encrypted = encrypt(mnemonic);

    const [walletRow] = await this.sql<DbUserWallet[]>`
      INSERT INTO user_wallets (id, user_id, encrypted_mnemonic, encryption_version, derivation_scheme)
      VALUES (${generateUUID()}, ${userId}, ${encrypted}, 1, 'BIP44')
      RETURNING *
    `;
    if (!walletRow) throw new Error('Failed to create wallet');

    // Seed addresses for all default supported pairs
    const addresses: WalletAddress[] = [];
    for (const pair of SUPPORTED_PAIRS) {
      const derived = deriveAddress(mnemonic, pair.asset, pair.network, 0, 0);
      const row = await this.persistAddress(userId, derived);
      addresses.push(this.mapAddress(row));
    }

    logger.info('Wallet generated', { userId, walletId: walletRow.id, addressCount: addresses.length });

    return {
      wallet_id: walletRow.id,
      created: true,
      mnemonic,
      addresses,
    };
  }

  /**
   * Derive + persist a new address for an (asset, network) pair.
   * If one already exists for the user+asset+network, it is returned.
   */
  async createAddress(userId: UUID, request: WalletAddressRequest): Promise<WalletAddress> {
    const asset = request.asset.toUpperCase();
    const network = request.network.toLowerCase();
    if (!isSupportedPair(asset, network)) {
      throw new UnsupportedAssetError(asset, network);
    }

    const [existing] = await this.sql<DbWalletAddress[]>`
      SELECT * FROM wallet_addresses
      WHERE user_id = ${userId} AND asset = ${asset} AND network = ${network}
    `;
    if (existing) return this.mapAddress(existing);

    const mnemonic = await this.loadMnemonic(userId);
    const derived = deriveAddress(mnemonic, asset, network, 0, 0);
    const row = await this.persistAddress(userId, derived, request.label);
    return this.mapAddress(row);
  }

  /** List all wallet addresses for a user. */
  async listAddresses(userId: UUID): Promise<WalletAddress[]> {
    const rows = await this.sql<DbWalletAddress[]>`
      SELECT * FROM wallet_addresses
      WHERE user_id = ${userId}
      ORDER BY created_at ASC
    `;
    return rows.map(r => this.mapAddress(r));
  }

  /**
   * Query the on-chain balance for a user's address.
   * Delegates to the balance provider that supports the network.
   */
  async getBalance(userId: UUID, addressId: UUID): Promise<AssetBalance> {
    const [row] = await this.sql<DbWalletAddress[]>`
      SELECT * FROM wallet_addresses
      WHERE id = ${addressId} AND user_id = ${userId}
    `;
    if (!row) throw new ValidationError(`Address ${addressId} not found for user`);

    const provider = this.providerForNetwork(row.network);
    if (!provider) {
      throw new BalanceProviderError(
        'none',
        `No balance provider configured for network: ${row.network}`
      );
    }

    const result = await provider.getNativeBalance({
      network: row.network,
      address: row.address,
    });

    return {
      asset: result.asset,
      network: result.network,
      address: result.address,
      balance: result.balance,
      balance_usd: result.balanceUsd ?? null,
      updated_at: result.updatedAt,
    };
  }

  /** List supported (asset, network) pairs, advertised at GET /v1/wallet/supported */
  listSupportedPairs(): { asset: string; network: string }[] {
    return SUPPORTED_PAIRS.map(p => ({ asset: p.asset, network: p.network }));
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private async loadMnemonic(userId: UUID): Promise<string> {
    const [row] = await this.sql<DbUserWallet[]>`
      SELECT * FROM user_wallets WHERE user_id = ${userId}
    `;
    if (!row) throw new WalletNotFoundError();
    return decrypt(row.encrypted_mnemonic);
  }

  private async persistAddress(
    userId: UUID,
    derived: { asset: string; network: string; address: string; publicKey: string; derivationPath: string },
    label: string | null = null
  ): Promise<DbWalletAddress> {
    const [row] = await this.sql<DbWalletAddress[]>`
      INSERT INTO wallet_addresses (
        id, user_id, asset, network, address, label,
        derivation_path, account_index, address_index, public_key
      ) VALUES (
        ${generateUUID()}, ${userId}, ${derived.asset}, ${derived.network}, ${derived.address}, ${label},
        ${derived.derivationPath}, 0, 0, ${derived.publicKey}
      )
      RETURNING *
    `;
    if (!row) throw new Error('Failed to insert wallet address');
    return row;
  }

  private providerForNetwork(network: string): IWalletBalanceProvider | null {
    for (const p of this.balanceProviders.values()) {
      if (p.supportedNetworks.includes(network)) return p;
    }
    return null;
  }

  private mapAddress(row: DbWalletAddress): WalletAddress {
    return {
      id: row.id,
      asset: row.asset,
      network: row.network,
      address: row.address,
      label: row.label,
      qr_code_url: null,
      created_at: row.created_at.toISOString(),
    };
  }
}
