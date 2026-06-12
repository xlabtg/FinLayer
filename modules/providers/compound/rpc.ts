/**
 * JSON-RPC implementation for Compound V3 earn operations.
 */

import type { CompoundRpcClient } from './adapter.js';
import { ValidationError } from '../../shared/errors/index.js';
import {
  EvmJsonRpcClient,
  baseUnitsToDecimal,
  decimalToBaseUnits,
  encodeFunctionData,
  normalizeAddress,
} from '../evm/json-rpc.js';

interface CompoundAssetConfig {
  tokenAddress: string;
  decimals: number;
}

interface CompoundNetworkConfig {
  assets: Record<string, CompoundAssetConfig>;
}

interface CompoundPositionParts {
  network: string;
  asset: string;
  owner: string;
  marketAddress: string;
  decimals: number;
  depositedBaseUnits: bigint;
}

const COMPOUND_V3_NETWORKS: Record<string, CompoundNetworkConfig> = {
  ethereum: {
    assets: {
      USDC: {
        tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        decimals: 6,
      },
      USDT: {
        tokenAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        decimals: 6,
      },
      ETH: {
        tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        decimals: 18,
      },
      WBTC: {
        tokenAddress: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
        decimals: 8,
      },
    },
  },
};

export class CompoundV3JsonRpcClient implements CompoundRpcClient {
  private readonly evm: EvmJsonRpcClient;

  constructor(config: { rpcUrl: string; fetchFn?: typeof fetch }) {
    this.evm = new EvmJsonRpcClient('CompoundV3', config.rpcUrl, config.fetchFn);
  }

  async isHealthy(): Promise<boolean> {
    return this.evm.isHealthy();
  }

  async deposit(input: {
    marketAddress: string;
    asset: string;
    amount: string;
    onBehalfOf: string;
    network: string;
  }): Promise<{ txHash: string; depositAddress: string; providerPositionId: string }> {
    const asset = getAssetConfig(input.network, input.asset);
    const amountBaseUnits = decimalToBaseUnits(input.amount, asset.decimals);
    const owner = normalizeAddress(input.onBehalfOf);
    const marketAddress = normalizeAddress(input.marketAddress);
    const data = encodeFunctionData('supply(address,uint256)', [
      { type: 'address', value: asset.tokenAddress },
      { type: 'uint256', value: amountBaseUnits },
    ]);

    const txHash = await this.evm.sendTransaction({
      from: owner,
      to: marketAddress,
      data,
    });

    return {
      txHash,
      depositAddress: marketAddress,
      providerPositionId: encodePositionId({
        network: input.network,
        asset: input.asset.toUpperCase(),
        owner,
        marketAddress,
        decimals: asset.decimals,
        depositedBaseUnits: amountBaseUnits,
      }),
    };
  }

  async withdraw(input: {
    providerPositionId: string;
    toAddress: string;
    network: string;
  }): Promise<{ txHash: string; withdrawnAmount: string }> {
    const position = decodePositionId(input.providerPositionId);
    const asset = getAssetConfig(position.network, position.asset);
    const currentBaseUnits = await this.readBalance(position);
    const withdrawBaseUnits =
      currentBaseUnits > 0n ? currentBaseUnits : position.depositedBaseUnits;
    const data = encodeFunctionData('withdrawTo(address,address,uint256)', [
      { type: 'address', value: normalizeAddress(input.toAddress) },
      { type: 'address', value: asset.tokenAddress },
      { type: 'uint256', value: withdrawBaseUnits },
    ]);

    const txHash = await this.evm.sendTransaction({
      from: position.owner,
      to: position.marketAddress,
      data,
    });

    return {
      txHash,
      withdrawnAmount: baseUnitsToDecimal(withdrawBaseUnits, position.decimals),
    };
  }

  async getPosition(providerPositionId: string): Promise<{
    status: 'pending' | 'active' | 'withdrawn';
    depositedAmount: string;
    currentValue: string;
    asset: string;
    network: string;
  }> {
    const position = decodePositionId(providerPositionId);
    const currentBaseUnits = await this.readBalance(position);

    return {
      status: currentBaseUnits > 0n ? 'active' : 'pending',
      depositedAmount: baseUnitsToDecimal(position.depositedBaseUnits, position.decimals),
      currentValue: baseUnitsToDecimal(currentBaseUnits, position.decimals),
      asset: position.asset,
      network: position.network,
    };
  }

  private async readBalance(position: CompoundPositionParts): Promise<bigint> {
    const balanceHex = await this.evm.call(
      position.marketAddress,
      encodeFunctionData('balanceOf(address)', [{ type: 'address', value: position.owner }])
    );
    return BigInt(balanceHex);
  }
}

function getAssetConfig(network: string, asset: string): CompoundAssetConfig {
  const networkConfig = COMPOUND_V3_NETWORKS[network.toLowerCase()];
  if (!networkConfig) {
    throw new ValidationError(`Compound V3 network is not supported: ${network}`);
  }
  const config = networkConfig.assets[asset.toUpperCase()];
  if (!config) {
    throw new ValidationError(`Compound V3 asset is not supported on ${network}: ${asset}`);
  }
  return config;
}

function encodePositionId(parts: CompoundPositionParts): string {
  return [
    'compound-v3',
    '1',
    parts.network.toLowerCase(),
    parts.asset.toUpperCase(),
    normalizeAddress(parts.owner),
    normalizeAddress(parts.marketAddress),
    String(parts.decimals),
    parts.depositedBaseUnits.toString(16),
  ].join(':');
}

function decodePositionId(providerPositionId: string): CompoundPositionParts {
  const parts = providerPositionId.split(':');
  if (parts.length !== 8 || parts[0] !== 'compound-v3' || parts[1] !== '1') {
    throw new ValidationError('Unsupported Compound provider_position_id format');
  }
  const decimals = Number(parts[6]);
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new ValidationError('Invalid Compound provider_position_id decimals');
  }
  return {
    network: parts[2]!,
    asset: parts[3]!,
    owner: normalizeAddress(parts[4]!),
    marketAddress: normalizeAddress(parts[5]!),
    decimals,
    depositedBaseUnits: BigInt(`0x${parts[7]}`),
  };
}
