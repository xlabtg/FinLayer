/**
 * Unit tests for the smart routing module and the in-memory cache.
 * No external dependencies — exercises the scoring logic against a
 * deterministic fixture set.
 */

import { describe, test, expect } from 'bun:test';
import {
  ProviderReliabilityTracker,
  rankCandidates,
  netOutput,
  DEFAULT_WEIGHTS,
} from '../../../../modules/shared/routing/index.js';
import { InMemoryCache, RedisCache, swapQuoteCacheKey } from '../../../../modules/shared/cache/index.js';

describe('routing.netOutput', () => {
  test('subtracts platform + network fees from to_amount', () => {
    const out = netOutput({
      providerName: 'X',
      toAmount: '1.00000000',
      platformFee: '0.01000000',
      networkFee: '0.00100000',
      estimatedDurationSeconds: 100,
    });
    expect(parseFloat(out)).toBeCloseTo(0.989, 5);
  });
});

describe('rankCandidates', () => {
  test('prefers the highest net output when reliability is equal', () => {
    const reliability = new ProviderReliabilityTracker();
    const ranked = rankCandidates(
      [
        { providerName: 'A', toAmount: '10', platformFee: '0', networkFee: '0', estimatedDurationSeconds: 60 },
        { providerName: 'B', toAmount: '11', platformFee: '0', networkFee: '0', estimatedDurationSeconds: 60 },
        { providerName: 'C', toAmount: '9', platformFee: '0', networkFee: '0', estimatedDurationSeconds: 60 },
      ],
      reliability
    );
    expect(ranked.best.providerName).toBe('B');
    expect(ranked.ranked.map(r => r.providerName)).toEqual(['B', 'A', 'C']);
  });

  test('penalizes unreliable providers', () => {
    const reliability = new ProviderReliabilityTracker();
    // A succeeded 10/10, B has 0/10 successes.
    for (let i = 0; i < 10; i++) reliability.recordSuccess('A');
    for (let i = 0; i < 10; i++) reliability.recordFailure('B');

    // B has slightly higher raw to_amount but far worse reliability.
    const ranked = rankCandidates(
      [
        { providerName: 'A', toAmount: '10', platformFee: '0', networkFee: '0', estimatedDurationSeconds: 60 },
        { providerName: 'B', toAmount: '10.1', platformFee: '0', networkFee: '0', estimatedDurationSeconds: 60 },
      ],
      reliability,
      { ...DEFAULT_WEIGHTS, reliability: 0.5 }
    );
    expect(ranked.best.providerName).toBe('A');
  });

  test('prefers faster provider when speed weight dominates', () => {
    const reliability = new ProviderReliabilityTracker();
    const ranked = rankCandidates(
      [
        { providerName: 'Slow', toAmount: '10', platformFee: '0', networkFee: '0', estimatedDurationSeconds: 3600 },
        { providerName: 'Fast', toAmount: '9.9', platformFee: '0', networkFee: '0', estimatedDurationSeconds: 30 },
      ],
      reliability,
      { rate: 0.5, speed: 2.0, reliability: 0 }
    );
    expect(ranked.best.providerName).toBe('Fast');
  });

  test('emits a deterministic ordering on ties', () => {
    const reliability = new ProviderReliabilityTracker();
    const ranked = rankCandidates(
      [
        { providerName: 'ZProvider', toAmount: '10', platformFee: '0', networkFee: '0', estimatedDurationSeconds: 60 },
        { providerName: 'AProvider', toAmount: '10', platformFee: '0', networkFee: '0', estimatedDurationSeconds: 60 },
      ],
      reliability
    );
    // Scores + reliability + to_amount are all equal — falls back to name.
    expect(ranked.ranked.map(r => r.providerName)).toEqual(['AProvider', 'ZProvider']);
  });
});

describe('ProviderReliabilityTracker', () => {
  test('defaults to 1.0 for unknown providers', () => {
    const tracker = new ProviderReliabilityTracker();
    expect(tracker.score('NewProvider')).toBe(1);
  });

  test('computes success ratio', () => {
    const tracker = new ProviderReliabilityTracker();
    tracker.recordSuccess('P');
    tracker.recordSuccess('P');
    tracker.recordFailure('P');
    expect(tracker.score('P')).toBeCloseTo(2 / 3, 5);
  });

  test('snapshot returns per-provider stats', () => {
    const tracker = new ProviderReliabilityTracker();
    tracker.recordSuccess('A');
    tracker.recordFailure('A');
    const snap = tracker.snapshot();
    expect(snap['A']).toEqual({ success: 1, failure: 1, score: 0.5 });
  });
});

describe('InMemoryCache', () => {
  test('returns cached value within TTL', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', { n: 42 }, 5);
    const got = await cache.get<{ n: number }>('k');
    expect(got).toEqual({ n: 42 });
  });

  test('returns null after TTL expires', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', 'value', 0.05); // 50ms
    await new Promise((r) => setTimeout(r, 80));
    const got = await cache.get('k');
    expect(got).toBeNull();
  });

  test('del removes entries', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', 'v', 60);
    await cache.del('k');
    expect(await cache.get('k')).toBeNull();
  });

  test('close clears pending timers', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', 'v', 60);
    expect(cache.size()).toBe(1);
    await cache.close();
    expect(cache.size()).toBe(0);
  });

  test('overwriting a key resets its TTL', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', 'v1', 0.05);
    await new Promise((r) => setTimeout(r, 20));
    await cache.set('k', 'v2', 0.5);
    await new Promise((r) => setTimeout(r, 50));
    expect(await cache.get('k')).toBe('v2');
  });
});

describe('RedisCache.increment', () => {
  function createFakeRedisClient() {
    const values = new Map<string, string>();
    const expiresAt = new Map<string, number>();

    const purgeExpired = (key: string) => {
      const resetAt = expiresAt.get(key);
      if (resetAt !== undefined && Date.now() >= resetAt) {
        values.delete(key);
        expiresAt.delete(key);
      }
    };
    const ttlMsFromOptions = (
      options?: { EX?: number; PX?: number; expiration?: { type: 'EX' | 'PX'; value: number } }
    ): number | undefined => {
      if (!options) return undefined;
      if (options.PX !== undefined) return options.PX;
      if (options.EX !== undefined) return options.EX * 1000;
      if (!options.expiration) return undefined;
      return options.expiration.type === 'PX'
        ? options.expiration.value
        : options.expiration.value * 1000;
    };

    return {
      async get(key: string): Promise<string | null> {
        purgeExpired(key);
        return values.get(key) ?? null;
      },
      async set(
        key: string,
        value: string,
        options?: { EX?: number; PX?: number; expiration?: { type: 'EX' | 'PX'; value: number } }
      ): Promise<unknown> {
        values.set(key, value);
        const ttlMs = ttlMsFromOptions(options);
        if (ttlMs !== undefined) {
          expiresAt.set(key, Date.now() + ttlMs);
        }
        return 'OK';
      },
      async incr(key: string): Promise<number> {
        purgeExpired(key);
        const value = Number(values.get(key) ?? '0') + 1;
        values.set(key, String(value));
        return value;
      },
      async expire(key: string, ttlSeconds: number): Promise<unknown> {
        expiresAt.set(key, Date.now() + ttlSeconds * 1000);
        return 1;
      },
      async pTTL(key: string): Promise<number> {
        purgeExpired(key);
        if (!values.has(key)) return -2;
        const resetAt = expiresAt.get(key);
        return resetAt === undefined ? -1 : resetAt - Date.now();
      },
      async pExpire(key: string, ttlMs: number): Promise<unknown> {
        expiresAt.set(key, Date.now() + ttlMs);
        return 1;
      },
      async del(key: string): Promise<unknown> {
        values.delete(key);
        expiresAt.delete(key);
        return 1;
      },
      async quit(): Promise<unknown> {
        return 'OK';
      },
    };
  }

  test('increments a shared key within one TTL window', async () => {
    const cache = new RedisCache(createFakeRedisClient());

    const first = await cache.increment('auth:rate-limit:k', 60_000);
    const second = await cache.increment('auth:rate-limit:k', 60_000);

    expect(first.value).toBe(1);
    expect(second.value).toBe(2);
    expect(second.resetAt).toBeGreaterThan(Date.now());
    await cache.close();
  });

  test('stores JSON values with TTL', async () => {
    const cache = new RedisCache(createFakeRedisClient());

    await cache.set('quote:k', { n: 42 }, 0.02);
    expect(await cache.get('quote:k')).toEqual({ n: 42 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await cache.get('quote:k')).toBeNull();
    await cache.close();
  });

  test('resets the counter after TTL expires', async () => {
    const cache = new RedisCache(createFakeRedisClient());

    const first = await cache.increment('auth:rate-limit:k', 20);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await cache.increment('auth:rate-limit:k', 20);

    expect(first.value).toBe(1);
    expect(second.value).toBe(1);
    await cache.close();
  });
});

describe('swapQuoteCacheKey', () => {
  test('normalizes asset casing', () => {
    const a = swapQuoteCacheKey({ fromAsset: 'btc', toAsset: 'eth', amount: '0.1' });
    const b = swapQuoteCacheKey({ fromAsset: 'BTC', toAsset: 'ETH', amount: '0.1' });
    expect(a).toBe(b);
  });

  test('different networks produce different keys', () => {
    const a = swapQuoteCacheKey({ fromAsset: 'USDT', toAsset: 'USDT', amount: '100', fromNetwork: 'eth' });
    const b = swapQuoteCacheKey({ fromAsset: 'USDT', toAsset: 'USDT', amount: '100', fromNetwork: 'tron' });
    expect(a).not.toBe(b);
  });
});
