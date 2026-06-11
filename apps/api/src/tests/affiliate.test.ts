/**
 * Regression tests for affiliate redirects (issue #25).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateUUID } from '@finlayer/utils';

import { AffiliateService } from '../../../../modules/affiliate/service.js';
import { createMockSql } from './setup.js';

describe('Affiliate redirects (issue #25)', () => {
  let service: AffiliateService;
  let mockSql: ReturnType<typeof createMockSql>;
  let previousAllowList: string | undefined;

  beforeEach(() => {
    previousAllowList = process.env['AFFILIATE_REDIRECT_ALLOWED_ORIGINS'];
    process.env['AFFILIATE_REDIRECT_ALLOWED_ORIGINS'] = 'https://app.finlayer.io';

    mockSql = createMockSql();
    service = new AffiliateService(mockSql as never);
  });

  afterEach(() => {
    if (previousAllowList === undefined) {
      delete process.env['AFFILIATE_REDIRECT_ALLOWED_ORIGINS'];
    } else {
      process.env['AFFILIATE_REDIRECT_ALLOWED_ORIGINS'] = previousAllowList;
    }
  });

  test('resolves an allow-listed redirect target and records one click', async () => {
    const targetUrl = 'https://app.finlayer.io/swap?from=BTC&to=ETH';
    const link = seedAffiliateLink('safe', targetUrl);

    const resolvedTarget = await service.recordClick('safe');

    expect(resolvedTarget).toBe(targetUrl);
    expect(link['clicks']).toBe(1);
  });

  test('blocks resolving an external redirect target outside the allow-list', async () => {
    const link = seedAffiliateLink('evil', 'https://evil.example/phish');

    await expect(service.recordClick('evil')).rejects.toMatchObject({
      code: 'AFFILIATE_REDIRECT_TARGET_NOT_ALLOWED',
      domain: 'affiliate',
      retryable: false,
      details: {
        target_origin: 'https://evil.example',
      },
    });
    expect(link['clicks']).toBe(0);
  });

  test('blocks resolving a non-http redirect target', async () => {
    const link = seedAffiliateLink('ftp', 'ftp://app.finlayer.io/file');

    await expect(service.recordClick('ftp')).rejects.toMatchObject({
      code: 'AFFILIATE_REDIRECT_TARGET_NOT_ALLOWED',
      domain: 'affiliate',
      retryable: false,
    });
    expect(link['clicks']).toBe(0);
  });

  test('rejects creating new affiliate links outside the allow-list', async () => {
    const affiliate = await service.getOrCreateAffiliate(generateUUID());

    await expect(
      service.createLink(affiliate.id, { target_url: 'https://evil.example/phish' })
    ).rejects.toMatchObject({
      code: 'AFFILIATE_REDIRECT_TARGET_NOT_ALLOWED',
      domain: 'affiliate',
      retryable: false,
    });
    expect(mockSql._tables.get('affiliate_links') ?? []).toHaveLength(0);
  });

  function seedAffiliateLink(shortCode: string, targetUrl: string): Record<string, unknown> {
    const links = mockSql._tables.get('affiliate_links') ?? [];
    if (!mockSql._tables.has('affiliate_links')) {
      mockSql._tables.set('affiliate_links', links);
    }

    const row = {
      id: generateUUID(),
      affiliate_id: generateUUID(),
      target_url: targetUrl,
      short_code: shortCode,
      label: null,
      clicks: 0,
      conversions: 0,
      created_at: new Date(),
    };
    links.push(row);
    return row;
  }
});
