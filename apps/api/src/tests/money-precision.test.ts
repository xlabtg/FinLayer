/**
 * Regression tests for issue #19: monetary calculations must not pass through
 * JS floating-point arithmetic.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { generateUUID } from '@finlayer/utils';

import { AffiliatePayoutScheduler } from '../../../../modules/affiliate/scheduler.js';
import { InsufficientLiquidityError } from '../../../../modules/shared/errors/index.js';
import { ChangeNOWAdapter } from '../../../../modules/providers/changenow/adapter.js';
import { RevenueService } from '../../../../modules/swap/revenue.js';
import { createMockSql } from './setup.js';

type MockSql = ReturnType<typeof createMockSql>;

const LARGE_DECIMAL = '9007199254740993.123456789';
const PLATFORM_FEE_03_PERCENT = '27021597764222.979370370367';
const AFFILIATE_SHARE_40_PERCENT = '3602879701896397.2493827156';

function seedAffiliate(
  sql: MockSql,
  affiliateId: string,
  ownerUserId: string = generateUUID()
): void {
  const affiliates = sql._tables.get('affiliates') ?? [];
  sql._tables.set('affiliates', affiliates);
  affiliates.push({
    id: affiliateId,
    user_id: ownerUserId,
    code: `FL_${affiliateId.replace(/-/g, '').substring(0, 8).toUpperCase()}`,
    commission_rate: '0.4',
    payout_address: '0xAffiliatePayoutAddr',
    total_earned: '0',
    total_paid_out: '0',
    created_at: new Date(),
    updated_at: new Date(),
  });
}

function seedRevenueEvent(
  sql: MockSql,
  affiliateId: string,
  opts: { total_fee: string; affiliate_share: string }
): string {
  const id = generateUUID();
  const events = sql._tables.get('revenue_events') ?? [];
  sql._tables.set('revenue_events', events);
  events.push({
    id,
    affiliate_id: affiliateId,
    total_fee: opts.total_fee,
    affiliate_share: opts.affiliate_share,
    distributed_at: null,
    created_at: new Date(),
  });
  return id;
}

describe('money precision (issue #19)', () => {
  test('calculates platform fees without losing precision past Number.MAX_SAFE_INTEGER', () => {
    const revenue = new RevenueService(createMockSql() as never, {
      platformShareRatio: 0.6,
      affiliateShareRatio: 0.4,
      platformFeePercent: 0.003,
    });

    expect(revenue.calculatePlatformFee(LARGE_DECIMAL)).toBe(PLATFORM_FEE_03_PERCENT);
  });

  test('credits affiliate earnings with exact decimal multiplication', async () => {
    const sql = createMockSql();
    const affiliateId = generateUUID();
    seedAffiliate(sql, affiliateId);

    const revenue = new RevenueService(sql as never, {
      platformShareRatio: 0.6,
      affiliateShareRatio: 0.4,
      platformFeePercent: 0.003,
    });

    await revenue.createRevenueEvent({
      transactionId: generateUUID(),
      domain: 'swap',
      totalFee: LARGE_DECIMAL,
      feeAsset: 'USDC',
      affiliateId,
      payerUserId: generateUUID(),
    });

    const affiliate = sql._tables.get('affiliates')!.find((row) => row['id'] === affiliateId)!;
    expect(affiliate['total_earned']).toBe(AFFILIATE_SHARE_40_PERCENT);
  });

  test('creates payout batches and items with exact decimal totals', async () => {
    const sql = createMockSql();
    const affiliateId = generateUUID();
    seedAffiliate(sql, affiliateId);
    const eventId = seedRevenueEvent(sql, affiliateId, {
      total_fee: LARGE_DECIMAL,
      affiliate_share: '0.4',
    });

    const scheduler = new AffiliatePayoutScheduler(sql as never, { minPayoutAmount: 0 });
    const summary = await scheduler.runOnce();

    expect(summary.batches_created).toBe(1);

    const payout = sql._tables.get('affiliate_payouts')![0]!;
    expect(payout['amount']).toBe(AFFILIATE_SHARE_40_PERCENT);

    const item = sql._tables.get('affiliate_payout_items')![0]!;
    expect(item['revenue_event_id']).toBe(eventId);
    expect(item['amount']).toBe(AFFILIATE_SHARE_40_PERCENT);

    const affiliate = sql._tables.get('affiliates')!.find((row) => row['id'] === affiliateId)!;
    expect(affiliate['total_paid_out']).toBe(AFFILIATE_SHARE_40_PERCENT);
  });
});

describe('ChangeNOWAdapter amount comparisons (issue #19)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('rejects an amount below minAmount without float rounding', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      urls.push(url);

      if (url.includes('/exchange/min-amount')) {
        return new Response(JSON.stringify({
          minAmount: '9007199254740993.2',
          maxAmount: null,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        fromAmount: '9007199254740993.1',
        toAmount: '1',
        flow: 'standard',
        type: 'direct',
        validUntil: new Date(Date.now() + 60_000).toISOString(),
        transactionSpeedForecast: '5-10',
        networkFee: '0',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const adapter = new ChangeNOWAdapter('api-key', '', 'https://example.test');

    await expect(adapter.getQuote({
      fromAsset: 'BTC',
      toAsset: 'ETH',
      amount: '9007199254740993.1',
    })).rejects.toBeInstanceOf(InsufficientLiquidityError);
    expect(urls.some((url) => url.includes('/exchange/estimated-amount'))).toBe(false);
  });
});
