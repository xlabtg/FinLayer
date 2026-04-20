/**
 * End-to-end tests for the swap service's Phase 5 upgrades:
 *   - multi-provider routing selects the best net-output quote
 *   - quote cache is populated on the first call
 *   - cached quotes are materialized without re-calling providers
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { SwapService } from '../../../../modules/swap/service.js';
import { MockSwapProvider } from './mock-provider.js';
import { createMockSql, createTestUserId } from './setup.js';
import { InMemoryCache, swapQuoteCacheKey } from '../../../../modules/shared/cache/index.js';
import { ProviderReliabilityTracker } from '../../../../modules/shared/routing/index.js';
import type { ISwapProviderAdapter, SwapQuoteResult } from '../../../../modules/shared/types/index.js';
import { futureISO } from '@finlayer/utils';

/**
 * Deterministic provider stub that returns a preconfigured result and
 * counts the number of times `getQuote` was called.
 */
class FixedRateProvider implements ISwapProviderAdapter {
  public readonly domain = 'swap' as const;
  public readonly supportedAssets = ['BTC', 'ETH'];
  public getQuoteCalls = 0;

  constructor(
    public readonly name: string,
    private readonly toAmount: string,
    private readonly durationSeconds: number = 600
  ) {}

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async getQuote(): Promise<SwapQuoteResult> {
    this.getQuoteCalls++;
    return {
      providerQuoteId: `${this.name}_${Date.now()}`,
      fromAsset: 'BTC',
      toAsset: 'ETH',
      fromAmount: '0.1',
      toAmount: this.toAmount,
      rate: (parseFloat(this.toAmount) / 0.1).toFixed(8),
      networkFee: '0.0001',
      feeAsset: 'ETH',
      estimatedDurationSeconds: this.durationSeconds,
      expiresAt: futureISO(300),
      minAmount: '0.001',
      maxAmount: '10000',
    };
  }

  async executeSwap(): Promise<{ providerTxId: string; depositAddress: string; status: 'pending' }> {
    return {
      providerTxId: `${this.name}_tx_${Date.now()}`,
      depositAddress: `deposit_${this.name}`,
      status: 'pending',
    };
  }

  async getTransactionStatus(providerTxId: string): Promise<{ providerTxId: string; status: 'pending' }> {
    return { providerTxId, status: 'pending' };
  }
}

describe('SwapService — smart routing (Phase 5)', () => {
  let userId: string;
  let mockSql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    mockSql = createMockSql();
    userId = createTestUserId();
    // The mock provider table only ships with MockProvider — seed two extra
    // providers so materializeQuote can look up each one by name.
    const providers = mockSql._tables.get('providers')!;
    providers.push({ id: crypto.randomUUID(), name: 'Fast', domain: 'swap', is_active: true });
    providers.push({ id: crypto.randomUUID(), name: 'Cheap', domain: 'swap', is_active: true });
  });

  test('best_quote_id points at the highest net-output provider', async () => {
    const fast = new FixedRateProvider('Fast', '1.5', 60);
    const cheap = new FixedRateProvider('Cheap', '1.7', 3600); // more output, much slower
    const service = new SwapService(
      mockSql as never,
      new Map<string, ISwapProviderAdapter>([
        ['Fast', fast],
        ['Cheap', cheap],
      ])
    );

    const response = await service.getQuote(userId, {
      from_asset: 'BTC',
      to_asset: 'ETH',
      amount: '0.1',
    });

    // With default weights (rate=1.0, speed=0.1, reliability=0.2) the slower
    // provider with ~13% higher output wins — net output dominates.
    const best = response.quotes.find((q) => q.id === response.best_quote_id)!;
    expect(best.provider_name).toBe('Cheap');
  });

  test('speed-weighted routing picks the faster provider', async () => {
    const fast = new FixedRateProvider('Fast', '1.5', 60);
    const cheap = new FixedRateProvider('Cheap', '1.52', 3600);
    const service = new SwapService(
      mockSql as never,
      new Map<string, ISwapProviderAdapter>([
        ['Fast', fast],
        ['Cheap', cheap],
      ]),
      { routingWeights: { rate: 0.5, speed: 2.0, reliability: 0 } }
    );

    const response = await service.getQuote(userId, {
      from_asset: 'BTC',
      to_asset: 'ETH',
      amount: '0.1',
    });
    const best = response.quotes.find((q) => q.id === response.best_quote_id)!;
    expect(best.provider_name).toBe('Fast');
  });

  test('second identical quote call reuses the cache', async () => {
    const provider = new FixedRateProvider('Fast', '1.5', 60);
    const cache = new InMemoryCache();
    const service = new SwapService(
      mockSql as never,
      new Map<string, ISwapProviderAdapter>([['Fast', provider]]),
      { cache }
    );

    await service.getQuote(userId, { from_asset: 'BTC', to_asset: 'ETH', amount: '0.1' });
    await service.getQuote(userId, { from_asset: 'BTC', to_asset: 'ETH', amount: '0.1' });

    expect(provider.getQuoteCalls).toBe(1);

    const key = swapQuoteCacheKey({ fromAsset: 'BTC', toAsset: 'ETH', amount: '0.1' });
    const cached = await cache.get(key);
    expect(cached).not.toBeNull();
  });

  test('reliability tracker records provider success on getQuote', async () => {
    const provider = new FixedRateProvider('Fast', '1.5', 60);
    const reliability = new ProviderReliabilityTracker();
    const service = new SwapService(
      mockSql as never,
      new Map<string, ISwapProviderAdapter>([['Fast', provider]]),
      { reliability }
    );

    await service.getQuote(userId, { from_asset: 'BTC', to_asset: 'ETH', amount: '0.1' });

    const snapshot = reliability.snapshot();
    expect(snapshot['Fast']?.success).toBe(1);
    expect(snapshot['Fast']?.failure).toBe(0);
  });

  test('reliability tracker records provider failures', async () => {
    class FailingProvider extends FixedRateProvider {
      async getQuote(): Promise<SwapQuoteResult> {
        throw new Error('provider outage');
      }
    }
    const good = new FixedRateProvider('Fast', '1.5', 60);
    const bad = new FailingProvider('Cheap', '1.0', 60);
    const reliability = new ProviderReliabilityTracker();
    const service = new SwapService(
      mockSql as never,
      new Map<string, ISwapProviderAdapter>([
        ['Fast', good],
        ['Cheap', bad],
      ]),
      { reliability }
    );

    await service.getQuote(userId, { from_asset: 'BTC', to_asset: 'ETH', amount: '0.1' });

    expect(reliability.score('Fast')).toBe(1);
    expect(reliability.score('Cheap')).toBe(0); // 0 successes / 1 attempt
  });

  test('single-provider fallback: best_quote_id still set', async () => {
    const only = new MockSwapProvider();
    const service = new SwapService(
      mockSql as never,
      new Map<string, ISwapProviderAdapter>([['MockProvider', only]])
    );
    const response = await service.getQuote(userId, {
      from_asset: 'BTC',
      to_asset: 'ETH',
      amount: '0.1',
    });
    expect(response.best_quote_id).toBeDefined();
    expect(response.quotes).toHaveLength(1);
  });
});
