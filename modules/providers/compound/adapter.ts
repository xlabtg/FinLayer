/**
 * modules/providers/compound/adapter.ts
 * Compound V3 earn provider adapter.
 *
 * Implements IEarnProviderAdapter against Compound V3 (Comet) markets.
 * On-chain calls are delegated to an injectable RpcClient so the adapter
 * is testable without a live node. APY/market metadata is pulled from the
 * public Compound v3 markets endpoint.
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

const COMPOUND_API_URL = 'https://v3-api.compound.finance';
const DEFAULT_NETWORK = 'ethereum';

export interface CompoundRpcClient {
  deposit(input: {
    marketAddress: string;
    asset: string;
    amount: string;
    onBehalfOf: string;
    network: string;
  }): Promise<{ txHash: string; depositAddress: string; providerPositionId: string }>;

  withdraw(input: {
    providerPositionId: string;
    toAddress: string;
    network: string;
  }): Promise<{ txHash: string; withdrawnAmount: string }>;

  getPosition(providerPositionId: string): Promise<{
    status: 'pending' | 'active' | 'withdrawn';
    depositedAmount: string;
    currentValue: string;
    asset: string;
    network: string;
  }>;
}

interface CompoundMarket {
  /** Comet contract address (e.g. cUSDCv3). Used as the providerStrategyId. */
  cometAddress: string;
  baseAsset: {
    symbol: string;
    decimals: number;
  };
  /** Supply APR as a decimal string (e.g. "0.0412" = 4.12%). */
  supplyApr: string;
  /** 30-day average supply APR (optional). */
  supplyApr30d?: string;
  chain: string;
  totalSupply?: string;
}

export interface CompoundAdapterConfig {
  network?: string;
  apiUrl?: string;
  rpcClient: CompoundRpcClient;
  fetchFn?: typeof fetch;
}

export class CompoundV3Adapter implements IEarnProviderAdapter {
  public readonly name = 'CompoundV3';
  public readonly domain = 'earn' as const;
  public readonly supportedAssets: string[] = ['USDC', 'USDT', 'ETH', 'WBTC'];

  private readonly network: string;
  private readonly apiUrl: string;
  private readonly rpcClient: CompoundRpcClient;
  private readonly fetchFn: typeof fetch;

  constructor(config: CompoundAdapterConfig) {
    this.network = config.network ?? DEFAULT_NETWORK;
    this.apiUrl = config.apiUrl ?? COMPOUND_API_URL;
    this.rpcClient = config.rpcClient;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.apiUrl}/markets?chain=${this.network}`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async getStrategies(): Promise<EarnStrategyResult[]> {
    const markets = await this.fetchMarkets();
    return markets
      .filter((m) => this.supportedAssets.includes(m.baseAsset.symbol.toUpperCase()))
      .map((m) => this.marketToStrategy(m));
  }

  async getStrategy(providerStrategyId: string): Promise<EarnStrategyResult | null> {
    const markets = await this.fetchMarkets();
    const match = markets.find(
      (m) => m.cometAddress.toLowerCase() === providerStrategyId.toLowerCase()
    );
    return match ? this.marketToStrategy(match) : null;
  }

  async deposit(params: EarnDepositParams): Promise<EarnDepositResult> {
    const strategy = await this.getStrategy(params.strategyId);
    if (!strategy) {
      throw new ProviderError(this.name, `Market ${params.strategyId} not found`, 'earn');
    }

    logger.info('Compound V3 deposit initiated', {
      strategyId: params.strategyId,
      asset: strategy.asset,
      amount: params.amount,
      fromAddress: params.fromAddress,
    });

    const result = await this.rpcClient.deposit({
      marketAddress: params.strategyId,
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
    logger.info('Compound V3 withdraw initiated', {
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

  private marketToStrategy(m: CompoundMarket): EarnStrategyResult {
    const symbol = m.baseAsset.symbol.toUpperCase();
    const aprToApy = (apr: string): string => {
      const n = parseFloat(apr);
      if (!Number.isFinite(n)) return '0';
      return (n * 100).toFixed(4);
    };

    return {
      providerStrategyId: m.cometAddress,
      asset: symbol,
      network: m.chain || this.network,
      apy: aprToApy(m.supplyApr),
      apy30d: aprToApy(m.supplyApr30d ?? m.supplyApr),
      riskLevel: 'low',
      minDeposit: '0.01',
      lockPeriodDays: 0,
      protocol: 'Compound V3',
      description: `Supply ${symbol} to Compound V3 Comet market to earn variable interest`,
    };
  }

  private async fetchMarkets(): Promise<CompoundMarket[]> {
    const res = await this.fetchFn(`${this.apiUrl}/markets?chain=${this.network}`);
    if (res.status === 429) {
      throw new ProviderRateLimitError(this.name);
    }
    if (!res.ok) {
      throw new ProviderError(this.name, `HTTP ${res.status}`, 'earn');
    }
    const body = (await res.json()) as { markets?: CompoundMarket[] } | CompoundMarket[];
    if (Array.isArray(body)) return body;
    return body.markets ?? [];
  }
}
