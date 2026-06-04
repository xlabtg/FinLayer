/**
 * modules/swap/revenue.ts
 * Revenue calculation and tracking middleware.
 * Auto-calculates platform + affiliate splits for each transaction.
 */

import type { SQL } from 'postgres';
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
  payerUserId?: UUID | null;
}

export class RevenueService {
  private readonly affiliateService: AffiliateService;

  constructor(
    private readonly sql: SQL,
    private readonly config: RevenueConfig
  ) {
    this.affiliateService = new AffiliateService(sql);
  }

  async validateAffiliateAttribution(
    affiliateId: UUID | null | undefined,
    payerUserId: UUID
  ): Promise<UUID | null> {
    if (!affiliateId) return null;

    const isValid = await this.affiliateService.validateAffiliateId(affiliateId, payerUserId);
    if (!isValid) {
      throw new ValidationError('Invalid affiliate_id for this user', { affiliate_id: affiliateId });
    }

    return affiliateId;
  }

  /**
   * Calculate and store a revenue event for a transaction.
   * Returns the revenue_event_id.
   */
  async createRevenueEvent(params: CreateRevenueEventParams): Promise<UUID> {
    const { transactionId, domain, totalFee, feeAsset, affiliateId, payerUserId } = params;
    const eventId = generateUUID();
    let effectiveAffiliateId = affiliateId ?? null;

    if (effectiveAffiliateId) {
      const isValid = await this.affiliateService.validateAffiliateId(
        effectiveAffiliateId,
        payerUserId ?? undefined
      );
      if (!isValid) {
        logger.warn('Affiliate attribution rejected for revenue event', {
          transactionId,
          domain,
          affiliateId: effectiveAffiliateId,
          payerUserId: payerUserId ?? null,
        });
        effectiveAffiliateId = null;
      }
    }

    const platformShare = this.config.platformShareRatio;
    const affiliateShare = effectiveAffiliateId ? this.config.affiliateShareRatio : 0;
    // Adjust shares if no affiliate
    const actualPlatformShare = effectiveAffiliateId ? platformShare : 1.0;

    await this.sql`
      INSERT INTO revenue_events (
        id, transaction_id, source_domain,
        total_fee, fee_asset,
        platform_share, affiliate_share,
        affiliate_id
      ) VALUES (
        ${eventId}, ${transactionId}, ${domain},
        ${totalFee}, ${feeAsset},
        ${actualPlatformShare}, ${affiliateShare},
        ${effectiveAffiliateId}
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
    });

    // Update affiliate total_earned if applicable
    if (effectiveAffiliateId) {
      const affiliateAmount = multiplyNumericStrings(totalFee, String(affiliateShare));
      await this.sql`
        UPDATE affiliates
        SET total_earned = total_earned + ${affiliateAmount}, updated_at = NOW()
        WHERE id = ${effectiveAffiliateId}
      `;
    }

    return eventId;
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
