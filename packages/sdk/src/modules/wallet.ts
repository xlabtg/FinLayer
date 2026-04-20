/**
 * FinLayer SDK — Wallet Module
 * Non-custodial HD wallet management.
 */

import type {
  WalletAddress,
  WalletAddressRequest,
  AssetBalance,
  UUID,
} from '@finlayer/types';
import type { FinLayerClient } from '../client.js';

export interface WalletGenerateResponse {
  wallet_id: UUID;
  created: boolean;
  addresses: WalletAddress[];
  /**
   * Returned ONLY on first-time generation. Back this up off-server — it is
   * the only way to recover your keys outside FinLayer.
   */
  mnemonic?: string;
}

export interface SupportedWalletPair {
  asset: string;
  network: string;
}

export class WalletModule {
  constructor(private readonly client: FinLayerClient) {}

  /**
   * Generate (or return existing) HD wallet. First call returns the BIP39
   * mnemonic — store it securely, it is never returned again.
   *
   * @example
   * const wallet = await finlayer.wallet.generate();
   * if (wallet.mnemonic) {
   *   // First-time generation; persist `wallet.mnemonic` somewhere safe
   * }
   */
  async generate(): Promise<WalletGenerateResponse> {
    return this.client.request<WalletGenerateResponse>('POST', '/v1/wallet/generate');
  }

  /** List all derived addresses for the authenticated user. */
  async addresses(): Promise<{ addresses: WalletAddress[] }> {
    return this.client.request<{ addresses: WalletAddress[] }>('GET', '/v1/wallet/addresses');
  }

  /** Derive a new address for an (asset, network) pair. */
  async createAddress(params: WalletAddressRequest): Promise<{ address: WalletAddress }> {
    return this.client.request<{ address: WalletAddress }>('POST', '/v1/wallet/addresses', params);
  }

  /** Query the on-chain native balance of a wallet address. */
  async balance(addressId: UUID): Promise<{ balance: AssetBalance }> {
    return this.client.request<{ balance: AssetBalance }>(
      'GET',
      `/v1/wallet/addresses/${addressId}/balance`
    );
  }

  /** List asset/network pairs the platform can derive addresses for. */
  async supported(): Promise<{ pairs: SupportedWalletPair[] }> {
    return this.client.request<{ pairs: SupportedWalletPair[] }>('GET', '/v1/wallet/supported');
  }
}
