/**
 * JSON-RPC implementation for Aave V3 earn operations.
 */

import type { AaveRpcClient } from './adapter.js';
import { ValidationError } from '../../shared/errors/index.js';
import {
  EvmJsonRpcClient,
  MAX_UINT256,
  baseUnitsToDecimal,
  decimalToBaseUnits,
  encodeFunctionData,
  isHexAddress,
  normalizeAddress,
} from '../evm/json-rpc.js';

interface AaveAssetConfig {
  underlyingAddress: string;
  aTokenAddress: string;
  decimals: number;
}

interface AaveNetworkConfig {
  poolAddress: string;
  assets: Record<string, AaveAssetConfig>;
}

interface AavePositionParts {
  network: string;
  asset: string;
  owner: string;
  aTokenAddress: string;
  decimals: number;
  depositedBaseUnits: bigint;
}

const AAVE_V3_NETWORKS: Record<string, AaveNetworkConfig> = {
  ethereum: {
    poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    assets: {
      USDC: {
        underlyingAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        aTokenAddress: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
        decimals: 6,
      },
      USDT: {
        underlyingAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        aTokenAddress: '0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a',
        decimals: 6,
      },
      DAI: {
        underlyingAddress: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
        aTokenAddress: '0x018008bfb33d285247A21d44E50697654f754e63',
        decimals: 18,
      },
      ETH: {
        underlyingAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        aTokenAddress: '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8',
        decimals: 18,
      },
      WBTC: {
        underlyingAddress: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
        aTokenAddress: '0x5Ee5bf7ae06D1Be5997A1A72006FE6C607eC6DE8',
        decimals: 8,
      },
    },
  },
};

export class AaveV3JsonRpcClient implements AaveRpcClient {
  private readonly evm: EvmJsonRpcClient;

  constructor(config: { rpcUrl: string; fetchFn?: typeof fetch }) {
    this.evm = new EvmJsonRpcClient('AaveV3', config.rpcUrl, config.fetchFn);
  }

  async isHealthy(): Promise<boolean> {
    return this.evm.isHealthy();
  }

  async deposit(input: {
    asset: string;
    amount: string;
    onBehalfOf: string;
    network: string;
    strategyId?: string;
  }): Promise<{ txHash: string; depositAddress: string; providerPositionId: string }> {
    const network = getNetworkConfig(input.network);
    const asset = getAssetConfig(input.network, input.asset, input.strategyId);
    const amountBaseUnits = decimalToBaseUnits(input.amount, asset.decimals);
    const owner = normalizeAddress(input.onBehalfOf);
    const data = encodeFunctionData('supply(address,uint256,address,uint16)', [
      { type: 'address', value: asset.underlyingAddress },
      { type: 'uint256', value: amountBaseUnits },
      { type: 'address', value: owner },
      { type: 'uint16', value: 0 },
    ]);

    const txHash = await this.evm.sendTransaction({
      from: owner,
      to: network.poolAddress,
      data,
    });

    return {
      txHash,
      depositAddress: network.poolAddress,
      providerPositionId: encodePositionId({
        network: input.network,
        asset: input.asset.toUpperCase(),
        owner,
        aTokenAddress: asset.aTokenAddress,
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
    const network = getNetworkConfig(position.network);
    const asset = getAssetConfig(position.network, position.asset, position.aTokenAddress);
    const data = encodeFunctionData('withdraw(address,uint256,address)', [
      { type: 'address', value: asset.underlyingAddress },
      { type: 'uint256', value: MAX_UINT256 },
      { type: 'address', value: normalizeAddress(input.toAddress) },
    ]);

    const txHash = await this.evm.sendTransaction({
      from: position.owner,
      to: network.poolAddress,
      data,
    });

    return {
      txHash,
      withdrawnAmount: baseUnitsToDecimal(position.depositedBaseUnits, position.decimals),
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
    const balanceHex = await this.evm.call(
      position.aTokenAddress,
      encodeFunctionData('balanceOf(address)', [{ type: 'address', value: position.owner }])
    );
    const currentBaseUnits = BigInt(balanceHex);

    return {
      status: currentBaseUnits > 0n ? 'active' : 'pending',
      depositedAmount: baseUnitsToDecimal(position.depositedBaseUnits, position.decimals),
      currentValue: baseUnitsToDecimal(currentBaseUnits, position.decimals),
      asset: position.asset,
      network: position.network,
    };
  }
}

function getNetworkConfig(network: string): AaveNetworkConfig {
  const config = AAVE_V3_NETWORKS[network.toLowerCase()];
  if (!config) {
    throw new ValidationError(`Aave V3 network is not supported: ${network}`);
  }
  return config;
}

function getAssetConfig(network: string, asset: string, strategyId?: string): AaveAssetConfig {
  const config = getNetworkConfig(network).assets[asset.toUpperCase()];
  if (!config) {
    throw new ValidationError(`Aave V3 asset is not supported on ${network}: ${asset}`);
  }
  return {
    ...config,
    aTokenAddress: strategyId && isHexAddress(strategyId) ? strategyId : config.aTokenAddress,
  };
}

function encodePositionId(parts: AavePositionParts): string {
  return [
    'aave-v3',
    '1',
    parts.network.toLowerCase(),
    parts.asset.toUpperCase(),
    normalizeAddress(parts.owner),
    normalizeAddress(parts.aTokenAddress),
    String(parts.decimals),
    parts.depositedBaseUnits.toString(16),
  ].join(':');
}

function decodePositionId(providerPositionId: string): AavePositionParts {
  const parts = providerPositionId.split(':');
  if (parts.length !== 8 || parts[0] !== 'aave-v3' || parts[1] !== '1') {
    throw new ValidationError('Unsupported Aave provider_position_id format');
  }
  const decimals = Number(parts[6]);
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new ValidationError('Invalid Aave provider_position_id decimals');
  }
  return {
    network: parts[2]!,
    asset: parts[3]!,
    owner: normalizeAddress(parts[4]!),
    aTokenAddress: normalizeAddress(parts[5]!),
    decimals,
    depositedBaseUnits: BigInt(`0x${parts[7]}`),
  };
}
