/**
 * modules/affiliate/service.ts
 * Affiliate management: create, track, and distribute revenue.
 */

import type { SQL } from 'postgres';
import { generateUUID } from '@finlayer/utils';
import type { UUID, Affiliate, AffiliateLink, AffiliateStats, AffiliateLinkCreateRequest } from '@finlayer/types';
import { logger } from '../shared/utils/logger.js';
import { assertAffiliateRedirectTargetAllowed } from './redirect-policy.js';

interface DbAffiliate {
  id: string;
  user_id: string;
  code: string;
  commission_rate: string;
  payout_address: string | null;
  total_earned: string;
  total_paid_out: string;
  created_at: Date;
  updated_at: Date;
}

interface DbAffiliateLink {
  id: string;
  affiliate_id: string;
  target_url: string;
  short_code: string;
  label: string | null;
  clicks: number;
  conversions: number;
  created_at: Date;
}

export interface AffiliateClickResult {
  target_url: string;
  affiliate_id: UUID;
  affiliate_link_id: UUID;
}

export interface AffiliateLinkAttribution {
  affiliate_id: UUID;
  affiliate_link_id: UUID;
}

export class AffiliateService {
  constructor(private readonly sql: SQL) {}

  /**
   * Get or create an affiliate profile for a user.
   */
  async getOrCreateAffiliate(userId: UUID): Promise<Affiliate> {
    const [existing] = await this.sql<DbAffiliate[]>`
      SELECT * FROM affiliates WHERE user_id = ${userId}
    `;
    if (existing) return this.mapAffiliate(existing);

    // Auto-generate affiliate code from UUID prefix
    const code = `FL_${userId.replace(/-/g, '').substring(0, 8).toUpperCase()}`;

    const [created] = await this.sql<DbAffiliate[]>`
      INSERT INTO affiliates (id, user_id, code, commission_rate)
      VALUES (${generateUUID()}, ${userId}, ${code}, 0.4)
      RETURNING *
    `;

    if (!created) throw new Error('Failed to create affiliate profile');
    logger.info('Affiliate created', { userId, code });
    return this.mapAffiliate(created);
  }

  /**
   * Create an affiliate tracking link.
   */
  async createLink(affiliateId: UUID, request: AffiliateLinkCreateRequest): Promise<AffiliateLink> {
    assertAffiliateRedirectTargetAllowed(request.target_url);

    const shortCode = `${affiliateId.substring(0, 8)}_${generateUUID().substring(0, 8)}`;
    const baseUrl = process.env['API_BASE_URL'] ?? 'http://localhost:3000';
    const shortUrl = `${baseUrl}/r/${shortCode}`;

    const [row] = await this.sql<DbAffiliateLink[]>`
      INSERT INTO affiliate_links (id, affiliate_id, target_url, short_code, label)
      VALUES (${generateUUID()}, ${affiliateId}, ${request.target_url}, ${shortCode}, ${request.label ?? null})
      RETURNING *
    `;
    if (!row) throw new Error('Failed to create affiliate link');

    return this.mapLink(row, shortUrl);
  }

  /**
   * Get affiliate stats dashboard.
   */
  async getStats(userId: UUID): Promise<AffiliateStats> {
    const affiliate = await this.getOrCreateAffiliate(userId);

    const links = await this.sql<DbAffiliateLink[]>`
      SELECT * FROM affiliate_links WHERE affiliate_id = ${affiliate.id} ORDER BY created_at DESC
    `;

    const baseUrl = process.env['API_BASE_URL'] ?? 'http://localhost:3000';

    const recentEvents = await this.sql`
      SELECT * FROM revenue_events
      WHERE affiliate_id = ${affiliate.id}
      ORDER BY created_at DESC
      LIMIT 10
    `;

    // Revenue breakdown by domain
    const domainRevenue = await this.sql<{ source_domain: string; total: string }[]>`
      SELECT source_domain, SUM(total_fee * affiliate_share) as total
      FROM revenue_events
      WHERE affiliate_id = ${affiliate.id}
      GROUP BY source_domain
    `;

    const pendingRevenue = await this.sql<{ total: string }[]>`
      SELECT COALESCE(SUM(total_fee * affiliate_share), 0) AS total
      FROM revenue_events
      WHERE affiliate_id = ${affiliate.id} AND distributed_at IS NULL
    `;

    return {
      affiliate,
      links: links.map(l => this.mapLink(l, `${baseUrl}/r/${l.short_code}`)),
      total_clicks: links.reduce((acc, l) => acc + l.clicks, 0),
      total_conversions: links.reduce((acc, l) => acc + l.conversions, 0),
      pending_revenue: pendingRevenue[0]?.total ?? '0',
      revenue_by_domain: {
        swap: domainRevenue.find(r => r.source_domain === 'swap')?.total ?? '0',
        payments: domainRevenue.find(r => r.source_domain === 'payments')?.total ?? '0',
        earn: domainRevenue.find(r => r.source_domain === 'earn')?.total ?? '0',
      },
      recent_events: recentEvents as never,
    };
  }

  /**
   * Record a click on an affiliate link.
   */
  async recordClick(shortCode: string): Promise<AffiliateClickResult | null> {
    const [row] = await this.sql<{ id: string; affiliate_id: string; target_url: string }[]>`
      SELECT id, affiliate_id, target_url
      FROM affiliate_links
      WHERE short_code = ${shortCode}
    `;
    if (!row) return null;

    assertAffiliateRedirectTargetAllowed(row.target_url);

    await this.sql`
      UPDATE affiliate_links
      SET clicks = clicks + 1
      WHERE short_code = ${shortCode}
    `;

    return {
      target_url: row.target_url,
      affiliate_id: row.affiliate_id,
      affiliate_link_id: row.id,
    };
  }

  /**
   * Validate that an affiliate_id exists and, when a payer is known, is not
   * owned by the same user.
   */
  async validateAffiliateId(affiliateId: UUID, payerUserId?: UUID): Promise<boolean> {
    const [row] = await this.sql<{ id: string; user_id: string }[]>`
      SELECT id, user_id FROM affiliates WHERE id = ${affiliateId}
    `;
    if (!row) return false;
    if (payerUserId && row.user_id === payerUserId) return false;
    return true;
  }

  /**
   * Validate a link-level attribution source and ensure it belongs to the
   * optional affiliate_id supplied alongside the request.
   */
  async validateAffiliateLink(
    affiliateLinkId: UUID,
    affiliateId?: UUID | null,
    payerUserId?: UUID
  ): Promise<AffiliateLinkAttribution | null> {
    const [row] = await this.sql<{ id: string; affiliate_id: string; user_id: string }[]>`
      SELECT l.id, l.affiliate_id, a.user_id
      FROM affiliate_links l
      JOIN affiliates a ON a.id = l.affiliate_id
      WHERE l.id = ${affiliateLinkId}
    `;
    if (!row) return null;
    if (affiliateId && row.affiliate_id !== affiliateId) return null;
    if (payerUserId && row.user_id === payerUserId) return null;
    return {
      affiliate_id: row.affiliate_id,
      affiliate_link_id: row.id,
    };
  }

  /**
   * Record a paid conversion for one concrete affiliate link.
   */
  async recordConversion(affiliateLinkId: UUID, affiliateId: UUID): Promise<void> {
    await this.sql`
      UPDATE affiliate_links
      SET conversions = conversions + 1
      WHERE id = ${affiliateLinkId} AND affiliate_id = ${affiliateId}
    `;
  }

  private mapAffiliate(row: DbAffiliate): Affiliate {
    return {
      id: row.id,
      user_id: row.user_id,
      code: row.code,
      commission_rate: row.commission_rate,
      payout_address: row.payout_address,
      total_earned: row.total_earned,
      total_paid_out: row.total_paid_out,
      created_at: row.created_at.toISOString(),
    };
  }

  private mapLink(row: DbAffiliateLink, shortUrl: string): AffiliateLink {
    return {
      id: row.id,
      affiliate_id: row.affiliate_id,
      target_url: row.target_url,
      short_url: shortUrl,
      label: row.label,
      clicks: row.clicks,
      conversions: row.conversions,
      created_at: row.created_at.toISOString(),
    };
  }
}
