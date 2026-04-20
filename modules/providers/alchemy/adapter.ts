/**
 * modules/providers/alchemy/adapter.ts
 * Alchemy balance provider — queries native EVM balances via JSON-RPC.
 *
 * Alchemy API docs: https://docs.alchemy.com/reference/eth-getbalance
 * Configure via ALCHEMY_API_KEY env var.
 */

import type { IWalletBalanceProvider, BalanceQueryParams, WalletBalanceResult } from '../../shared/types/index.js';
import { BalanceProviderError } from '../../shared/errors/index.js';
import { nowISO } from '@finlayer/utils';

const ENDPOINTS: Record<string, string> = {
  ethereum: 'https://eth-mainnet.g.alchemy.com/v2',
  polygon: 'https://polygon-mainnet.g.alchemy.com/v2',
  arbitrum: 'https://arb-mainnet.g.alchemy.com/v2',
  optimism: 'https://opt-mainnet.g.alchemy.com/v2',
  base: 'https://base-mainnet.g.alchemy.com/v2',
};

const NATIVE_ASSET: Record<string, string> = {
  ethereum: 'ETH',
  polygon: 'MATIC',
  arbitrum: 'ETH',
  optimism: 'ETH',
  base: 'ETH',
};

export class AlchemyBalanceProvider implements IWalletBalanceProvider {
  public readonly name = 'Alchemy';
  public readonly supportedNetworks = Object.keys(ENDPOINTS);

  constructor(private readonly apiKey: string) {}

  async getNativeBalance(params: BalanceQueryParams): Promise<WalletBalanceResult> {
    const base = ENDPOINTS[params.network.toLowerCase()];
    if (!base) {
      throw new BalanceProviderError(this.name, `Unsupported network: ${params.network}`);
    }
    const url = `${base}/${this.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [params.address, 'latest'],
      }),
    });

    if (!res.ok) {
      throw new BalanceProviderError(this.name, `HTTP ${res.status}`);
    }
    const json = await res.json() as { result?: string; error?: { message?: string } };
    if (json.error) {
      throw new BalanceProviderError(this.name, json.error.message ?? 'rpc error');
    }
    const hex = json.result ?? '0x0';
    const wei = BigInt(hex);
    // Format wei → ETH string with 18 decimals, trim trailing zeros
    const balance = formatUnits(wei, 18);

    return {
      network: params.network.toLowerCase(),
      address: params.address,
      asset: NATIVE_ASSET[params.network.toLowerCase()] ?? 'ETH',
      balance,
      decimals: 18,
      updatedAt: nowISO(),
    };
  }
}

function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const str = abs.toString().padStart(decimals + 1, '0');
  const intPart = str.slice(0, -decimals);
  const decPart = str.slice(-decimals).replace(/0+$/, '');
  const result = decPart ? `${intPart}.${decPart}` : intPart;
  return negative ? `-${result}` : result;
}
