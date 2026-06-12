/**
 * Regression tests for affiliate attribution validation (issue #33).
 */

import { describe, expect, test } from 'bun:test';
import { generateUUID } from '@finlayer/utils';

import { RevenueService } from '../../../../modules/swap/revenue.js';
import { DEFAULT_REVENUE_CONFIG } from '../../../../modules/shared/types/index.js';
import { ValidationError } from '../../../../modules/shared/errors/index.js';
import { createMockSql } from './setup.js';

function seedAffiliate(
  mockSql: ReturnType<typeof createMockSql>,
  affiliateId: string,
  ownerUserId: string
): void {
  const affiliates = mockSql._tables.get('affiliates') ?? [];
  mockSql._tables.set('affiliates', affiliates);
  affiliates.push({
    id: affiliateId,
    user_id: ownerUserId,
    code: `FL_${affiliateId.replace(/-/g, '').substring(0, 8).toUpperCase()}`,
    commission_rate: '0.4',
    payout_address: null,
    total_earned: '0',
    total_paid_out: '0',
    created_at: new Date(),
    updated_at: new Date(),
  });
}

function seedAffiliateLink(
  mockSql: ReturnType<typeof createMockSql>,
  linkId: string,
  affiliateId: string
): Record<string, unknown> {
  const links = mockSql._tables.get('affiliate_links') ?? [];
  mockSql._tables.set('affiliate_links', links);

  const row = {
    id: linkId,
    affiliate_id: affiliateId,
    target_url: 'https://app.finlayer.io/swap',
    short_code: `ln_${linkId.replace(/-/g, '').substring(0, 8)}`,
    label: null,
    clicks: 1,
    conversions: 0,
    created_at: new Date(),
  };
  links.push(row);
  return row;
}

describe('Affiliate attribution validation (issue #33)', () => {
  test('accepts an existing affiliate owned by another user', async () => {
    const mockSql = createMockSql();
    const revenueService = new RevenueService(mockSql as never, DEFAULT_REVENUE_CONFIG);
    const payerUserId = generateUUID();
    const affiliateId = generateUUID();

    seedAffiliate(mockSql, affiliateId, generateUUID());

    await expect(
      revenueService.validateAffiliateAttribution(affiliateId, payerUserId)
    ).resolves.toBe(affiliateId);
  });

  test('rejects self-referral and unknown affiliate ids', async () => {
    const mockSql = createMockSql();
    const revenueService = new RevenueService(mockSql as never, DEFAULT_REVENUE_CONFIG);
    const payerUserId = generateUUID();
    const ownAffiliateId = generateUUID();
    const unknownAffiliateId = generateUUID();

    seedAffiliate(mockSql, ownAffiliateId, payerUserId);

    await expect(
      revenueService.validateAffiliateAttribution(ownAffiliateId, payerUserId)
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      revenueService.validateAffiliateAttribution(unknownAffiliateId, payerUserId)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('keeps missing affiliate attribution optional', async () => {
    const mockSql = createMockSql();
    const revenueService = new RevenueService(mockSql as never, DEFAULT_REVENUE_CONFIG);

    await expect(
      revenueService.validateAffiliateAttribution(undefined, generateUUID())
    ).resolves.toBeNull();
  });
});

describe('Affiliate link conversions (issue #74)', () => {
  test('increments the attributed link conversion when a revenue event is created', async () => {
    const mockSql = createMockSql();
    const revenueService = new RevenueService(mockSql as never, DEFAULT_REVENUE_CONFIG);
    const payerUserId = generateUUID();
    const affiliateId = generateUUID();
    const affiliateLinkId = generateUUID();

    seedAffiliate(mockSql, affiliateId, generateUUID());
    const link = seedAffiliateLink(mockSql, affiliateLinkId, affiliateId);

    const eventId = await revenueService.createRevenueEvent({
      transactionId: generateUUID(),
      domain: 'swap',
      totalFee: '10',
      feeAsset: 'USDC',
      affiliateId,
      affiliateLinkId,
      payerUserId,
    } as Parameters<RevenueService['createRevenueEvent']>[0] & { affiliateLinkId: string });

    const events = mockSql._tables.get('revenue_events') ?? [];
    const event = events.find((row) => row['id'] === eventId);

    expect(event!['affiliate_link_id']).toBe(affiliateLinkId);
    expect(link['conversions']).toBe(1);
  });
});
