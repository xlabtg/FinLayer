/**
 * Regression tests for analytics SQL parameter binding (issue #30).
 */

import { describe, expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import type { UUID } from '@finlayer/types';

import { AnalyticsService } from '../../../../modules/analytics/service.js';

interface UnsafeCall {
  query: string;
  params: readonly unknown[] | undefined;
}

function createCapturingSql() {
  const calls: UnsafeCall[] = [];
  const sql = {
    unsafe(query: string, params?: readonly unknown[]) {
      calls.push({ query, params });
      return Promise.resolve([]);
    },
  } as unknown as Sql;

  return { sql, calls };
}

describe('Analytics SQL parameters (issue #30)', () => {
  test('binds the affiliate id instead of interpolating it into unsafe SQL', async () => {
    const { sql, calls } = createCapturingSql();
    const service = new AnalyticsService(sql);
    const affiliateId = "00000000-0000-4000-8000-000000000001' OR 1=1 --" as UUID;

    await service.getAffiliateDashboard(affiliateId, '7d');

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.query).not.toContain(affiliateId);
      expect(Array.isArray(call.params)).toBe(true);
      expect(call.params).toContain('7 days');
      expect(call.params).toContain(affiliateId);
    }
  });

  test('binds analytics bucket and limit values instead of interpolating them', async () => {
    const { sql, calls } = createCapturingSql();
    const service = new AnalyticsService(sql);

    await service.getDashboard('24h');

    const timeseriesCall = calls.find((call) => call.query.includes('date_trunc'));
    expect(timeseriesCall).toBeDefined();
    expect(timeseriesCall?.query).not.toContain("date_trunc('hour'");
    expect(timeseriesCall?.params).toContain('hour');

    const topAffiliatesCall = calls.find((call) => call.query.includes('LIMIT'));
    expect(topAffiliatesCall).toBeDefined();
    expect(topAffiliatesCall?.query).not.toContain('LIMIT 10');
    expect(topAffiliatesCall?.params).toContain(10);
  });
});
