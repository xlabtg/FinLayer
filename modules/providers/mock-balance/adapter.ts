/**
 * modules/providers/mock-balance/adapter.ts
 * Deterministic mock balance provider for development / tests.
 */

import type { IWalletBalanceProvider, BalanceQueryParams, WalletBalanceResult } from '../../shared/types/index.js';
import { nowISO } from '@finlayer/utils';

const DECIMALS: Record<string, number> = {
  bitcoin: 8,
  ethereum: 18,
  polygon: 18,
  bsc: 18,
  arbitrum: 18,
  optimism: 18,
  base: 18,
};

const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6,
  USDT: 6,
};

const NATIVE: Record<string, string> = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  polygon: 'MATIC',
  bsc: 'BNB',
  arbitrum: 'ETH',
  optimism: 'ETH',
  base: 'ETH',
};

export class MockBalanceProvider implements IWalletBalanceProvider {
  public readonly name = 'MockBalance';
  public readonly supportedNetworks = Object.keys(DECIMALS);

  private fixtures = new Map<string, string>();
  private tokenFixtures = new Map<string, string>();

  /** Test helper: preset balances for (network:address) pairs. */
  setBalance(network: string, address: string, balance: string): void {
    this.fixtures.set(`${network.toLowerCase()}:${address.toLowerCase()}`, balance);
  }

  /** Test helper: preset token balances for (network:address:asset) tuples. */
  setTokenBalance(network: string, address: string, asset: string, balance: string): void {
    this.tokenFixtures.set(
      `${network.toLowerCase()}:${address.toLowerCase()}:${asset.toUpperCase()}`,
      balance
    );
  }

  async getNativeBalance(params: BalanceQueryParams): Promise<WalletBalanceResult> {
    const net = params.network.toLowerCase();
    const key = `${net}:${params.address.toLowerCase()}`;
    const balance = this.fixtures.get(key) ?? '0';
    return {
      network: net,
      address: params.address,
      asset: NATIVE[net] ?? 'UNKNOWN',
      balance,
      decimals: DECIMALS[net] ?? 18,
      updatedAt: nowISO(),
    };
  }

  async getTokenBalances(params: BalanceQueryParams): Promise<WalletBalanceResult[]> {
    const asset = params.asset?.toUpperCase();
    if (!asset) return [];

    const net = params.network.toLowerCase();
    const address = params.address.toLowerCase();
    const tokenKey = `${net}:${address}:${asset}`;
    const nativeKey = `${net}:${address}`;
    const balance = this.tokenFixtures.get(tokenKey) ?? this.fixtures.get(nativeKey) ?? '0';

    return [{
      network: net,
      address: params.address,
      asset,
      balance,
      decimals: params.tokenDecimals ?? TOKEN_DECIMALS[asset] ?? 18,
      updatedAt: nowISO(),
    }];
  }
}
