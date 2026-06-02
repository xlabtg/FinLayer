/**
 * Unit tests for the affiliate payout scheduler.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { generateUUID } from '@finlayer/utils';

import { AffiliatePayoutScheduler } from '../../../../modules/affiliate/scheduler.js';
import { createMockSql } from './setup.js';

type MockSql = ReturnType<typeof createMockSql>;

function seedAffiliate(
  sql: MockSql,
  overrides: { id?: string; payout_address?: string | null; total_paid_out?: string } = {}
) {
  const id = overrides.id ?? generateUUID();
  sql._tables.get('affiliates') ?? sql._tables.set('affiliates', []);
  sql._tables.get('affiliates')!.push({
    id,
    payout_address:
      'payout_address' in overrides ? overrides.payout_address : '0xAffiliatePayoutAddr',
    total_paid_out: overrides.total_paid_out ?? '0',
  });
  return id;
}

function seedRevenueEvent(
  sql: MockSql,
  affiliateId: string,
  opts: { total_fee: string; affiliate_share: string; distributed_at?: Date | null }
) {
  const id = generateUUID();
  sql._tables.get('revenue_events') ?? sql._tables.set('revenue_events', []);
  sql._tables.get('revenue_events')!.push({
    id,
    affiliate_id: affiliateId,
    total_fee: opts.total_fee,
    affiliate_share: opts.affiliate_share,
    distributed_at: opts.distributed_at ?? null,
    created_at: new Date(),
  });
  return id;
}

describe('AffiliatePayoutScheduler', () => {
  let sql: MockSql;
  let scheduler: AffiliatePayoutScheduler;

  beforeEach(() => {
    sql = createMockSql();
  });

  test('runOnce skips affiliates without a payout_address', async () => {
    const aff = seedAffiliate(sql, { payout_address: null });
    seedRevenueEvent(sql, aff, { total_fee: '100', affiliate_share: '0.4' });

    scheduler = new AffiliatePayoutScheduler(sql as never, { minPayoutAmount: 0 });
    const summary = await scheduler.runOnce();
    expect(summary.scanned).toBe(0);
    expect(summary.batches_created).toBe(0);
    expect(sql._tables.get('affiliate_payouts')?.length ?? 0).toBe(0);
  });

  test('runOnce creates a payout batch and marks events distributed', async () => {
    const aff = seedAffiliate(sql);
    const ev1 = seedRevenueEvent(sql, aff, { total_fee: '100', affiliate_share: '0.4' }); // 40
    const ev2 = seedRevenueEvent(sql, aff, { total_fee: '50', affiliate_share: '0.4' });  // 20

    scheduler = new AffiliatePayoutScheduler(sql as never, {
      minPayoutAmount: 1.0,
      payoutAsset: 'USDC',
    });
    const summary = await scheduler.runOnce();

    expect(summary.scanned).toBe(1);
    expect(summary.batches_created).toBe(1);
    expect(summary.skipped).toBe(0);

    const payouts = sql._tables.get('affiliate_payouts')!;
    expect(payouts.length).toBe(1);
    expect(payouts[0]!['affiliate_id']).toBe(aff);
    expect(payouts[0]!['asset']).toBe('USDC');
    expect(payouts[0]!['payout_address']).toBe('0xAffiliatePayoutAddr');
    expect(Number(payouts[0]!['amount'])).toBeCloseTo(60, 6);

    const items = sql._tables.get('affiliate_payout_items')!;
    expect(items.length).toBe(2);
    expect(items.map(i => i['revenue_event_id']).sort()).toEqual([ev1, ev2].sort());

    const events = sql._tables.get('revenue_events')!;
    expect(events.every(e => e['distributed_at'])).toBe(true);
  });

  test('runOnce skips affiliates below minPayoutAmount', async () => {
    const aff = seedAffiliate(sql);
    seedRevenueEvent(sql, aff, { total_fee: '1', affiliate_share: '0.4' }); // 0.4

    scheduler = new AffiliatePayoutScheduler(sql as never, { minPayoutAmount: 1.0 });
    const summary = await scheduler.runOnce();

    expect(summary.scanned).toBe(1);
    expect(summary.batches_created).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(sql._tables.get('affiliate_payouts')?.length ?? 0).toBe(0);
  });

  test('runOnce is idempotent — second run finds nothing to pay', async () => {
    const aff = seedAffiliate(sql);
    seedRevenueEvent(sql, aff, { total_fee: '100', affiliate_share: '0.4' });

    scheduler = new AffiliatePayoutScheduler(sql as never, { minPayoutAmount: 0 });
    const first = await scheduler.runOnce();
    expect(first.batches_created).toBe(1);

    const second = await scheduler.runOnce();
    expect(second.batches_created).toBe(0);
    expect(second.scanned).toBe(0);

    // Only the first run's payout row exists
    expect(sql._tables.get('affiliate_payouts')!.length).toBe(1);
  });

  test('parallel scheduler instances do not double-pay the same revenue events', async () => {
    const aff = seedAffiliate(sql);
    const ev1 = seedRevenueEvent(sql, aff, { total_fee: '100', affiliate_share: '0.4' });
    const ev2 = seedRevenueEvent(sql, aff, { total_fee: '50', affiliate_share: '0.4' });

    const schedulerA = new AffiliatePayoutScheduler(sql as never, { minPayoutAmount: 0 });
    const schedulerB = new AffiliatePayoutScheduler(sql as never, { minPayoutAmount: 0 });

    const [runA, runB] = await Promise.all([
      schedulerA.runOnce(),
      schedulerB.runOnce(),
    ]);

    expect(runA.batches_created + runB.batches_created).toBe(1);

    const payouts = sql._tables.get('affiliate_payouts')!;
    expect(payouts.length).toBe(1);

    const items = sql._tables.get('affiliate_payout_items')!;
    expect(items.length).toBe(2);
    expect(items.map(i => i['revenue_event_id']).sort()).toEqual([ev1, ev2].sort());

    const events = sql._tables.get('revenue_events')!;
    expect(events.every(e => e['distributed_at'])).toBe(true);
  });

  test('runOnce ignores already-distributed revenue events', async () => {
    const aff = seedAffiliate(sql);
    seedRevenueEvent(sql, aff, {
      total_fee: '100',
      affiliate_share: '0.4',
      distributed_at: new Date(), // already paid
    });

    scheduler = new AffiliatePayoutScheduler(sql as never, { minPayoutAmount: 0 });
    const summary = await scheduler.runOnce();
    expect(summary.scanned).toBe(0);
    expect(sql._tables.get('affiliate_payouts')?.length ?? 0).toBe(0);
  });
});
