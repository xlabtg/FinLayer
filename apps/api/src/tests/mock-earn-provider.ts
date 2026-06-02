/**
 * Mock earn provider for testing.
 * Simulates Aave/Compound adapters without real API or RPC calls.
 */

import type {
  IEarnProviderAdapter,
  EarnStrategyResult,
  EarnDepositParams,
  EarnDepositResult,
  EarnWithdrawParams,
  EarnWithdrawResult,
  EarnPositionResult,
} from '../../../../modules/shared/types/index.js';

export class MockEarnProvider implements IEarnProviderAdapter {
  public readonly name = 'MockEarnProvider';
  public readonly domain = 'earn' as const;
  public readonly supportedAssets = ['USDC', 'USDT', 'ETH', 'DAI'];

  private readonly strategies: EarnStrategyResult[] = [
    {
      providerStrategyId: 'mock-usdc-strategy',
      asset: 'USDC',
      network: 'ethereum',
      apy: '4.25',
      apy30d: '4.10',
      riskLevel: 'low',
      minDeposit: '1',
      lockPeriodDays: 0,
      protocol: 'MockProtocol',
      description: 'Mock USDC lending strategy',
    },
    {
      providerStrategyId: 'mock-eth-strategy',
      asset: 'ETH',
      network: 'ethereum',
      apy: '3.10',
      apy30d: '3.00',
      riskLevel: 'low',
      minDeposit: '0.01',
      lockPeriodDays: 0,
      protocol: 'MockProtocol',
      description: 'Mock ETH lending strategy',
    },
    {
      providerStrategyId: 'mock-locked-strategy',
      asset: 'DAI',
      network: 'ethereum',
      apy: '6.50',
      apy30d: '6.25',
      riskLevel: 'medium',
      minDeposit: '10',
      lockPeriodDays: 30,
      protocol: 'MockProtocol',
      description: 'Mock DAI locked strategy (30d)',
    },
  ];

  private positions = new Map<string, EarnPositionResult>();

  /** Number of times deposit/withdraw have been invoked (idempotency tests). */
  public depositCalls = 0;
  public withdrawCalls = 0;

  /** Optional artificial delay (ms) before deposit/withdraw resolve, to widen the concurrency race window. */
  public depositDelayMs = 0;
  public withdrawDelayMs = 0;

  /** Toggles to force deposit/withdraw to throw, to test reservation rollback. */
  public forceDepositError = false;
  public forceWithdrawError = false;

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async getStrategies(): Promise<EarnStrategyResult[]> {
    return this.strategies;
  }

  async getStrategy(providerStrategyId: string): Promise<EarnStrategyResult | null> {
    return this.strategies.find((s) => s.providerStrategyId === providerStrategyId) ?? null;
  }

  async deposit(params: EarnDepositParams): Promise<EarnDepositResult> {
    this.depositCalls += 1;
    if (this.depositDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.depositDelayMs));
    }
    if (this.forceDepositError) {
      throw new Error('provider deposit failure');
    }
    const strategy = await this.getStrategy(params.strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${params.strategyId} not found`);
    }
    const providerPositionId = `mock_pos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.positions.set(providerPositionId, {
      providerPositionId,
      status: 'active',
      depositedAmount: params.amount,
      currentValue: params.amount,
      earnedYield: '0',
      asset: strategy.asset,
      network: strategy.network,
    });

    return {
      providerPositionId,
      depositAddress: `mock_deposit_${providerPositionId}`,
      status: 'processing',
    };
  }

  async withdraw(params: EarnWithdrawParams): Promise<EarnWithdrawResult> {
    this.withdrawCalls += 1;
    if (this.withdrawDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.withdrawDelayMs));
    }
    if (this.forceWithdrawError) {
      throw new Error('provider withdraw failure');
    }
    const pos = this.positions.get(params.providerPositionId);
    if (!pos) {
      throw new Error(`Position ${params.providerPositionId} not found`);
    }
    pos.status = 'withdrawn';
    return {
      txHash: `0xmock_withdraw_${Date.now()}`,
      status: 'processing',
      withdrawnAmount: pos.currentValue,
    };
  }

  async getPosition(providerPositionId: string): Promise<EarnPositionResult> {
    const pos = this.positions.get(providerPositionId);
    if (!pos) {
      throw new Error(`Position ${providerPositionId} not found`);
    }
    return pos;
  }

  /** Test helper: simulate yield accrual. */
  simulateYield(providerPositionId: string, additional: string): void {
    const pos = this.positions.get(providerPositionId);
    if (!pos) return;
    const newValue = (parseFloat(pos.currentValue) + parseFloat(additional)).toFixed(8);
    pos.currentValue = newValue;
    pos.earnedYield = (parseFloat(newValue) - parseFloat(pos.depositedAmount)).toFixed(8);
  }
}
