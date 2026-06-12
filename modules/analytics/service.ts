/**
 * modules/analytics/service.ts
 * Cross-domain revenue analytics.
 *
 * Aggregates transactions, revenue events, and affiliate attribution across
 * every FinLayer domain (swap, payments, earn). All figures are quoted in
 * the transaction's fee asset — we do not convert currencies, so callers
 * should treat the per-asset breakdown as authoritative and treat
 * aggregate numbers as same-currency sums (fee asset is almost always the
 * from_asset of the transaction in our schema).
 */

import type { Sql } from 'postgres';
import type { Numeric, ProviderDomain, UUID } from '@finlayer/types';

export type AnalyticsPeriod = '24h' | '7d' | '30d' | '90d' | 'all';

const PERIOD_LOOKBACK_INTERVALS: Record<AnalyticsPeriod, string | null> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  all: null,
};

export interface DomainBreakdown {
  domain: ProviderDomain;
  transaction_count: number;
  total_volume: Numeric;
  total_fees: Numeric;
  platform_revenue: Numeric;
  affiliate_revenue: Numeric;
}

export interface TimeseriesPoint {
  bucket: string; // ISO date (YYYY-MM-DD)
  transaction_count: number;
  total_fees: Numeric;
  platform_revenue: Numeric;
  affiliate_revenue: Numeric;
}

export interface ProviderBreakdown {
  provider_name: string;
  domain: ProviderDomain;
  transaction_count: number;
  completed_count: number;
  failed_count: number;
  total_fees: Numeric;
  success_rate: number; // [0, 1]
}

export interface TopAffiliate {
  affiliate_id: UUID;
  code: string;
  revenue: Numeric;
  conversions: number;
}

export interface RevenueDashboard {
  period: AnalyticsPeriod;
  generated_at: string;
  totals: {
    transaction_count: number;
    total_volume: Numeric;
    total_fees: Numeric;
    platform_revenue: Numeric;
    affiliate_revenue: Numeric;
    active_affiliates: number;
  };
  by_domain: DomainBreakdown[];
  by_provider: ProviderBreakdown[];
  timeseries: TimeseriesPoint[];
  top_affiliates: TopAffiliate[];
}

export class AnalyticsService {
  constructor(private readonly sql: Sql) {}

  async getDashboard(period: AnalyticsPeriod = '30d'): Promise<RevenueDashboard> {
    const [totals, byDomain, byProvider, timeseries, topAffiliates] = await Promise.all([
      this.totals(period),
      this.byDomain(period),
      this.byProvider(period),
      this.timeseries(period),
      this.topAffiliates(period),
    ]);

    return {
      period,
      generated_at: new Date().toISOString(),
      totals,
      by_domain: byDomain,
      by_provider: byProvider,
      timeseries,
      top_affiliates: topAffiliates,
    };
  }

  /**
   * Per-affiliate dashboard variant, restricted to the supplied affiliate id.
   * The shape is identical to the platform dashboard but numbers reflect only
   * transactions attributed to that affiliate.
   */
  async getAffiliateDashboard(affiliateId: UUID, period: AnalyticsPeriod = '30d'): Promise<RevenueDashboard> {
    const [totals, byDomain, byProvider, timeseries] = await Promise.all([
      this.totals(period, affiliateId),
      this.byDomain(period, affiliateId),
      this.byProvider(period, affiliateId),
      this.timeseries(period, affiliateId),
    ]);

    return {
      period,
      generated_at: new Date().toISOString(),
      totals,
      by_domain: byDomain,
      by_provider: byProvider,
      timeseries,
      top_affiliates: [],
    };
  }

  private async totals(
    period: AnalyticsPeriod,
    affiliateId?: UUID
  ): Promise<RevenueDashboard['totals']> {
    const lookbackInterval = PERIOD_LOOKBACK_INTERVALS[period];
    const affiliateFilter = affiliateId ?? null;

    const [row] = await this.sql.unsafe(`
      SELECT
        COUNT(t.id)::int AS transaction_count,
        COALESCE(SUM(t.amount), 0)::text AS total_volume,
        COALESCE(SUM(re.total_fee), 0)::text AS total_fees,
        COALESCE(SUM(re.total_fee * re.platform_share), 0)::text AS platform_revenue,
        COALESCE(SUM(re.total_fee * re.affiliate_share), 0)::text AS affiliate_revenue,
        COUNT(DISTINCT t.affiliate_id)::int AS active_affiliates
      FROM transactions t
      LEFT JOIN revenue_events re ON re.transaction_id = t.id
      WHERE (($1::text) IS NULL OR t.created_at >= NOW() - ($1::text)::interval)
        AND ($2::uuid IS NULL OR t.affiliate_id = $2::uuid)
    `, [lookbackInterval, affiliateFilter]) as Array<{
      transaction_count: number;
      total_volume: string;
      total_fees: string;
      platform_revenue: string;
      affiliate_revenue: string;
      active_affiliates: number;
    }>;

    return {
      transaction_count: row?.transaction_count ?? 0,
      total_volume: row?.total_volume ?? '0',
      total_fees: row?.total_fees ?? '0',
      platform_revenue: row?.platform_revenue ?? '0',
      affiliate_revenue: row?.affiliate_revenue ?? '0',
      active_affiliates: row?.active_affiliates ?? 0,
    };
  }

  private async byDomain(
    period: AnalyticsPeriod,
    affiliateId?: UUID
  ): Promise<DomainBreakdown[]> {
    const lookbackInterval = PERIOD_LOOKBACK_INTERVALS[period];
    const affiliateFilter = affiliateId ?? null;

    const rows = await this.sql.unsafe(`
      SELECT
        t.domain,
        COUNT(t.id)::int AS transaction_count,
        COALESCE(SUM(t.amount), 0)::text AS total_volume,
        COALESCE(SUM(re.total_fee), 0)::text AS total_fees,
        COALESCE(SUM(re.total_fee * re.platform_share), 0)::text AS platform_revenue,
        COALESCE(SUM(re.total_fee * re.affiliate_share), 0)::text AS affiliate_revenue
      FROM transactions t
      LEFT JOIN revenue_events re ON re.transaction_id = t.id
      WHERE (($1::text) IS NULL OR t.created_at >= NOW() - ($1::text)::interval)
        AND ($2::uuid IS NULL OR t.affiliate_id = $2::uuid)
      GROUP BY t.domain
      ORDER BY transaction_count DESC
    `, [lookbackInterval, affiliateFilter]) as Array<{
      domain: ProviderDomain;
      transaction_count: number;
      total_volume: string;
      total_fees: string;
      platform_revenue: string;
      affiliate_revenue: string;
    }>;

    return rows.map((r) => ({
      domain: r.domain,
      transaction_count: r.transaction_count,
      total_volume: r.total_volume,
      total_fees: r.total_fees,
      platform_revenue: r.platform_revenue,
      affiliate_revenue: r.affiliate_revenue,
    }));
  }

  private async byProvider(
    period: AnalyticsPeriod,
    affiliateId?: UUID
  ): Promise<ProviderBreakdown[]> {
    const lookbackInterval = PERIOD_LOOKBACK_INTERVALS[period];
    const affiliateFilter = affiliateId ?? null;

    const rows = await this.sql.unsafe(`
      SELECT
        p.name AS provider_name,
        p.domain,
        COUNT(t.id)::int AS transaction_count,
        SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END)::int AS completed_count,
        SUM(CASE WHEN t.status IN ('failed', 'expired') THEN 1 ELSE 0 END)::int AS failed_count,
        COALESCE(SUM(re.total_fee), 0)::text AS total_fees
      FROM transactions t
      JOIN providers p ON p.id = t.provider_id
      LEFT JOIN revenue_events re ON re.transaction_id = t.id
      WHERE (($1::text) IS NULL OR t.created_at >= NOW() - ($1::text)::interval)
        AND ($2::uuid IS NULL OR t.affiliate_id = $2::uuid)
      GROUP BY p.name, p.domain
      ORDER BY transaction_count DESC
    `, [lookbackInterval, affiliateFilter]) as Array<{
      provider_name: string;
      domain: ProviderDomain;
      transaction_count: number;
      completed_count: number;
      failed_count: number;
      total_fees: string;
    }>;

    return rows.map((r) => {
      const terminal = r.completed_count + r.failed_count;
      const successRate = terminal === 0 ? 1 : r.completed_count / terminal;
      return {
        provider_name: r.provider_name,
        domain: r.domain,
        transaction_count: r.transaction_count,
        completed_count: r.completed_count,
        failed_count: r.failed_count,
        total_fees: r.total_fees,
        success_rate: Math.round(successRate * 10000) / 10000,
      };
    });
  }

  private async timeseries(
    period: AnalyticsPeriod,
    affiliateId?: UUID
  ): Promise<TimeseriesPoint[]> {
    const lookbackInterval = PERIOD_LOOKBACK_INTERVALS[period];
    const affiliateFilter = affiliateId ?? null;
    // Hour buckets for 24h, day buckets otherwise.
    const bucketGranularity = period === '24h' ? 'hour' : 'day';

    const rows = await this.sql.unsafe(`
      SELECT
        date_trunc($3::text, t.created_at) AS bucket,
        COUNT(t.id)::int AS transaction_count,
        COALESCE(SUM(re.total_fee), 0)::text AS total_fees,
        COALESCE(SUM(re.total_fee * re.platform_share), 0)::text AS platform_revenue,
        COALESCE(SUM(re.total_fee * re.affiliate_share), 0)::text AS affiliate_revenue
      FROM transactions t
      LEFT JOIN revenue_events re ON re.transaction_id = t.id
      WHERE (($1::text) IS NULL OR t.created_at >= NOW() - ($1::text)::interval)
        AND ($2::uuid IS NULL OR t.affiliate_id = $2::uuid)
      GROUP BY 1
      ORDER BY 1 ASC
    `, [lookbackInterval, affiliateFilter, bucketGranularity]) as Array<{
      bucket: Date | string;
      transaction_count: number;
      total_fees: string;
      platform_revenue: string;
      affiliate_revenue: string;
    }>;

    return rows.map((r) => ({
      bucket: r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket),
      transaction_count: r.transaction_count,
      total_fees: r.total_fees,
      platform_revenue: r.platform_revenue,
      affiliate_revenue: r.affiliate_revenue,
    }));
  }

  private async topAffiliates(period: AnalyticsPeriod, limit = 10): Promise<TopAffiliate[]> {
    const lookbackInterval = PERIOD_LOOKBACK_INTERVALS[period];

    const rows = await this.sql.unsafe(`
      SELECT
        a.id AS affiliate_id,
        a.code,
        COALESCE(SUM(re.total_fee * re.affiliate_share), 0)::text AS revenue,
        COUNT(re.id)::int AS conversions
      FROM affiliates a
      JOIN revenue_events re ON re.affiliate_id = a.id
      WHERE (($1::text) IS NULL OR re.created_at >= NOW() - ($1::text)::interval)
      GROUP BY a.id, a.code
      ORDER BY revenue::numeric DESC
      LIMIT $2::int
    `, [lookbackInterval, limit]) as Array<{
      affiliate_id: UUID;
      code: string;
      revenue: string;
      conversions: number;
    }>;

    return rows.map((r) => ({
      affiliate_id: r.affiliate_id,
      code: r.code,
      revenue: r.revenue,
      conversions: r.conversions,
    }));
  }
}
