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

  /** Test helper: preset balances for (network:address) pairs. */
  setBalance(network: string, address: string, balance: string): void {
    this.fixtures.set(`${network.toLowerCase()}:${address.toLowerCase()}`, balance);
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
}
