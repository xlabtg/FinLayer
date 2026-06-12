/**
 * modules/swap/revenue.ts
 * Revenue calculation and tracking middleware.
 * Auto-calculates platform + affiliate splits for each transaction.
 */

import type { Sql } from 'postgres';
import { generateUUID, multiplyNumericStrings } from '@finlayer/utils';
import type { ProviderDomain, UUID } from '@finlayer/types';
import type { RevenueConfig } from '../shared/types/index.js';
import { logger } from '../shared/utils/logger.js';
import { ValidationError } from '../shared/errors/index.js';
import { AffiliateService } from '../affiliate/service.js';

interface CreateRevenueEventParams {
  transactionId: UUID;
  domain: ProviderDomain;
  totalFee: string;
  feeAsset: string;
  affiliateId?: UUID | null;
  affiliateLinkId?: UUID | null;
  payerUserId?: UUID | null;
}

interface RevenueAttribution {
  affiliateId: UUID | null;
  affiliateLinkId: UUID | null;
}

export class RevenueService {
  private readonly affiliateService: AffiliateService;

  constructor(
    private readonly sql: Sql,
    private readonly config: RevenueConfig
  ) {
    this.affiliateService = new AffiliateService(sql);
  }

  async validateAffiliateAttribution(
    affiliateId: UUID | null | undefined,
    payerUserId: UUID
  ): Promise<UUID | null> {
    const attribution = await this.validateRevenueAttribution(affiliateId, payerUserId);
    return attribution.affiliateId;
  }

  async validateRevenueAttribution(
    affiliateId: UUID | null | undefined,
    payerUserId: UUID,
    affiliateLinkId?: UUID | null
  ): Promise<RevenueAttribution> {
    if (!affiliateId && !affiliateLinkId) {
      return { affiliateId: null, affiliateLinkId: null };
    }

    if (affiliateLinkId) {
      const link = await this.affiliateService.validateAffiliateLink(
        affiliateLinkId,
        affiliateId ?? null,
        payerUserId
      );
      if (!link) {
        throw new ValidationError('Invalid affiliate attribution for this user', {
          affiliate_id: affiliateId ?? null,
          affiliate_link_id: affiliateLinkId,
        });
      }

      return {
        affiliateId: link.affiliate_id,
        affiliateLinkId: link.affiliate_link_id,
      };
    }

    const isValid = await this.affiliateService.validateAffiliateId(affiliateId!, payerUserId);
    if (!isValid) {
      throw new ValidationError('Invalid affiliate_id for this user', { affiliate_id: affiliateId });
    }

    return { affiliateId: affiliateId!, affiliateLinkId: null };
  }

  /**
   * Calculate and store a revenue event for a transaction.
   * Returns the revenue_event_id.
   */
  async createRevenueEvent(params: CreateRevenueEventParams): Promise<UUID> {
    const { transactionId, domain, totalFee, feeAsset, affiliateId, affiliateLinkId, payerUserId } = params;
    const eventId = generateUUID();
    const attribution = await this.resolveRevenueAttributionForEvent(
      transactionId,
      domain,
      affiliateId ?? null,
      affiliateLinkId ?? null,
      payerUserId ?? undefined
    );
    const effectiveAffiliateId = attribution.affiliateId;
    const effectiveAffiliateLinkId = attribution.affiliateLinkId;

    const platformShare = this.config.platformShareRatio;
    const affiliateShare = effectiveAffiliateId ? this.config.affiliateShareRatio : 0;
    // Adjust shares if no affiliate
    const actualPlatformShare = effectiveAffiliateId ? platformShare : 1.0;

    await this.sql`
      INSERT INTO revenue_events (
        id, transaction_id, source_domain,
        total_fee, fee_asset,
        platform_share, affiliate_share,
        affiliate_id, affiliate_link_id
      ) VALUES (
        ${eventId}, ${transactionId}, ${domain},
        ${totalFee}, ${feeAsset},
        ${actualPlatformShare}, ${affiliateShare},
        ${effectiveAffiliateId}, ${effectiveAffiliateLinkId}
      )
    `;

    logger.info('Revenue event created', {
      eventId,
      transactionId,
      domain,
      totalFee,
      feeAsset,
      platformShare: actualPlatformShare,
      affiliateShare,
      hasAffiliate: !!effectiveAffiliateId,
      affiliateLinkId: effectiveAffiliateLinkId,
    });

    // Update affiliate aggregates if applicable.
    if (effectiveAffiliateId) {
      const affiliateAmount = multiplyNumericStrings(totalFee, String(affiliateShare));
      await this.sql`
        UPDATE affiliates
        SET total_earned = total_earned + ${affiliateAmount}, updated_at = NOW()
        WHERE id = ${effectiveAffiliateId}
      `;
      if (effectiveAffiliateLinkId) {
        await this.affiliateService.recordConversion(effectiveAffiliateLinkId, effectiveAffiliateId);
      }
    }

    return eventId;
  }

  private async resolveRevenueAttributionForEvent(
    transactionId: UUID,
    domain: ProviderDomain,
    affiliateId: UUID | null,
    affiliateLinkId: UUID | null,
    payerUserId?: UUID
  ): Promise<RevenueAttribution> {
    if (!affiliateId && !affiliateLinkId) {
      return { affiliateId: null, affiliateLinkId: null };
    }

    if (affiliateLinkId) {
      const link = await this.affiliateService.validateAffiliateLink(
        affiliateLinkId,
        affiliateId,
        payerUserId
      );
      if (link) {
        return {
          affiliateId: link.affiliate_id,
          affiliateLinkId: link.affiliate_link_id,
        };
      }

      logger.warn('Affiliate link attribution rejected for revenue event', {
        transactionId,
        domain,
        affiliateId,
        affiliateLinkId,
        payerUserId: payerUserId ?? null,
      });
    }

    if (affiliateId) {
      const isValid = await this.affiliateService.validateAffiliateId(affiliateId, payerUserId);
      if (isValid) {
        return { affiliateId, affiliateLinkId: null };
      }

      logger.warn('Affiliate attribution rejected for revenue event', {
        transactionId,
        domain,
        affiliateId,
        payerUserId: payerUserId ?? null,
      });
    }

    return { affiliateId: null, affiliateLinkId: null };
  }

  /**
   * Get revenue breakdown for a transaction.
   */
  async getRevenueEvent(revenueEventId: UUID) {
    const [row] = await this.sql`
      SELECT * FROM revenue_events WHERE id = ${revenueEventId}
    `;
    return row;
  }

  /**
   * Calculate platform fee for an amount.
   * Returns fee as a string to preserve precision.
   */
  calculatePlatformFee(amount: string): string {
    return multiplyNumericStrings(amount, String(this.config.platformFeePercent));
  }
}
