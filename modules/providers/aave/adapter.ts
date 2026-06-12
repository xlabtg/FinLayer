/**
 * modules/providers/aave/adapter.ts
 * Aave V3 earn provider adapter.
 *
 * Implements IEarnProviderAdapter against the Aave V3 Pool contract and
 * the Aave API (https://aave-api-v2.aave.com) for APY/strategy metadata.
 *
 * Design note: on-chain calls (deposit/withdraw) are delegated to an
 * injectable RpcClient so the adapter stays unit-testable without an
 * actual Ethereum node. In production the RpcClient is wired to
 * Alchemy/Infura via AAVE_RPC_URL.
 */

import type {
  IEarnProviderAdapter,
  EarnStrategyResult,
  EarnDepositParams,
  EarnDepositResult,
  EarnWithdrawParams,
  EarnWithdrawResult,
  EarnPositionResult,
} from '../../shared/types/index.js';
import { ProviderError, ProviderRateLimitError } from '../../shared/errors/index.js';
import { logger } from '../../shared/utils/logger.js';

const AAVE_API_URL = 'https://aave-api-v2.aave.com/data';
const DEFAULT_NETWORK = 'ethereum';

/**
 * Minimal RPC client contract used by the adapter.
 * Production implementation wraps Alchemy/Infura JSON-RPC.
 */
export interface AaveRpcClient {
  /** Submit an on-chain deposit and return the transaction hash + deposit address. */
  deposit(input: {
    strategyId?: string;
    asset: string;
    amount: string;
    onBehalfOf: string;
    network: string;
  }): Promise<{ txHash: string; depositAddress: string; providerPositionId: string }>;

  /** Withdraw from an aToken position and return the transaction hash. */
  withdraw(input: {
    providerPositionId: string;
    toAddress: string;
    network: string;
  }): Promise<{ txHash: string; withdrawnAmount: string }>;

  /** Read aToken balance + accrued interest for a position. */
  getPosition(providerPositionId: string): Promise<{
    status: 'pending' | 'active' | 'withdrawn';
    depositedAmount: string;
    currentValue: string;
    asset: string;
    network: string;
  }>;

  /** Optional runtime health check for the configured RPC endpoint. */
  isHealthy?(): Promise<boolean>;
}

interface AaveApiReserve {
  symbol: string;
  liquidityRate: string;      // Ray (1e27), per second → normalised on our side
  aTokenAddress: string;
  underlyingAsset: string;
  reserveLiquidationThreshold?: string;
  usageAsCollateralEnabled?: boolean;
}

export interface AaveAdapterConfig {
  network?: string;
  apiUrl?: string;
  rpcClient: AaveRpcClient;
  /** Optional fetch override for testing. */
  fetchFn?: typeof fetch;
}

/**
 * Convert Aave "liquidityRate" (ray, per second) to annual APY percentage string.
 * Formula: rate / 1e27 * SECONDS_PER_YEAR * 100
 */
export function aaveLiquidityRateToApy(liquidityRateRay: string): string {
  try {
    const SECONDS_PER_YEAR = 31_536_000;
    const RAY = 1e27;
    const rate = Number(liquidityRateRay) / RAY;
    const apy = rate * SECONDS_PER_YEAR * 100;
    return apy.toFixed(4);
  } catch {
    return '0';
  }
}

export class AaveV3Adapter implements IEarnProviderAdapter {
  public readonly name = 'AaveV3';
  public readonly domain = 'earn' as const;
  public readonly supportedAssets: string[] = ['USDC', 'USDT', 'DAI', 'ETH', 'WBTC'];

  private readonly network: string;
  private readonly apiUrl: string;
  private readonly rpcClient: AaveRpcClient;
  private readonly fetchFn: typeof fetch;

  constructor(config: AaveAdapterConfig) {
    this.network = config.network ?? DEFAULT_NETWORK;
    this.apiUrl = config.apiUrl ?? AAVE_API_URL;
    this.rpcClient = config.rpcClient;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.apiUrl}/liquidity/v3?poolId=${this.network}`);
      if (!res.ok) return false;
      return this.rpcClient.isHealthy ? this.rpcClient.isHealthy() : true;
    } catch {
      return false;
    }
  }

  async getStrategies(): Promise<EarnStrategyResult[]> {
    const reserves = await this.fetchReserves();
    return reserves
      .filter((r) => this.supportedAssets.includes(r.symbol.toUpperCase()))
      .map((r) => this.reserveToStrategy(r));
  }

  async getStrategy(providerStrategyId: string): Promise<EarnStrategyResult | null> {
    const reserves = await this.fetchReserves();
    const match = reserves.find(
      (r) => r.aTokenAddress.toLowerCase() === providerStrategyId.toLowerCase()
    );
    return match ? this.reserveToStrategy(match) : null;
  }

  async deposit(params: EarnDepositParams): Promise<EarnDepositResult> {
    const strategy = await this.getStrategy(params.strategyId);
    if (!strategy) {
      throw new ProviderError(this.name, `Strategy ${params.strategyId} not found`, 'earn');
    }

    logger.info('Aave V3 deposit initiated', {
      strategyId: params.strategyId,
      asset: strategy.asset,
      amount: params.amount,
      fromAddress: params.fromAddress,
    });

    const result = await this.rpcClient.deposit({
      strategyId: params.strategyId,
      asset: strategy.asset,
      amount: params.amount,
      onBehalfOf: params.fromAddress,
      network: strategy.network,
    });

    return {
      providerPositionId: result.providerPositionId,
      depositAddress: result.depositAddress,
      status: 'processing',
    };
  }

  async withdraw(params: EarnWithdrawParams): Promise<EarnWithdrawResult> {
    logger.info('Aave V3 withdraw initiated', {
      providerPositionId: params.providerPositionId,
      toAddress: params.toAddress,
    });

    const result = await this.rpcClient.withdraw({
      providerPositionId: params.providerPositionId,
      toAddress: params.toAddress,
      network: this.network,
    });

    return {
      txHash: result.txHash,
      status: 'processing',
      withdrawnAmount: result.withdrawnAmount,
    };
  }

  async getPosition(providerPositionId: string): Promise<EarnPositionResult> {
    const pos = await this.rpcClient.getPosition(providerPositionId);
    const deposited = parseFloat(pos.depositedAmount);
    const current = parseFloat(pos.currentValue);
    const earned = Math.max(0, current - deposited).toFixed(8);

    return {
      providerPositionId,
      status: pos.status,
      depositedAmount: pos.depositedAmount,
      currentValue: pos.currentValue,
      earnedYield: earned,
      asset: pos.asset,
      network: pos.network,
    };
  }

  private reserveToStrategy(r: AaveApiReserve): EarnStrategyResult {
    const symbol = r.symbol.toUpperCase();
    return {
      providerStrategyId: r.aTokenAddress,
      asset: symbol,
      network: this.network,
      apy: aaveLiquidityRateToApy(r.liquidityRate),
      apy30d: aaveLiquidityRateToApy(r.liquidityRate),
      riskLevel: 'low',
      minDeposit: '0.01',
      lockPeriodDays: 0,
      protocol: 'Aave V3',
      description: `Supply ${symbol} to Aave V3 to earn variable interest`,
    };
  }

  private async fetchReserves(): Promise<AaveApiReserve[]> {
    const res = await this.fetchFn(`${this.apiUrl}/liquidity/v3?poolId=${this.network}`);
    if (res.status === 429) {
      throw new ProviderRateLimitError(this.name);
    }
    if (!res.ok) {
      throw new ProviderError(this.name, `HTTP ${res.status}`, 'earn');
    }
    const body = (await res.json()) as { reserves?: AaveApiReserve[] } | AaveApiReserve[];
    if (Array.isArray(body)) return body;
    return body.reserves ?? [];
  }
}
