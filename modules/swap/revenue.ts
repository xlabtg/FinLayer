/**
 * modules/swap/revenue.ts
 * Revenue calculation and tracking middleware.
 * Auto-calculates platform + affiliate splits for each transaction.
 */

import type { SQL } from 'postgres';
import { generateUUID } from '@finlayer/utils';
import type { ProviderDomain, UUID } from '@finlayer/types';
import type { RevenueConfig } from '../shared/types/index.js';
import { logger } from '../shared/utils/logger.js';

interface CreateRevenueEventParams {
  transactionId: UUID;
  domain: ProviderDomain;
  totalFee: string;
  feeAsset: string;
  affiliateId?: UUID | null;
}

export class RevenueService {
  constructor(
    private readonly sql: SQL,
    private readonly config: RevenueConfig
  ) {}

  /**
   * Calculate and store a revenue event for a transaction.
   * Returns the revenue_event_id.
   */
  async createRevenueEvent(params: CreateRevenueEventParams): Promise<UUID> {
    const { transactionId, domain, totalFee, feeAsset, affiliateId } = params;
    const eventId = generateUUID();

    const platformShare = this.config.platformShareRatio;
    const affiliateShare = affiliateId ? this.config.affiliateShareRatio : 0;
    // Adjust shares if no affiliate
    const actualPlatformShare = affiliateId ? platformShare : 1.0;

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
        ${affiliateId ?? null}
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
      hasAffiliate: !!affiliateId,
    });

    // Update affiliate total_earned if applicable
    if (affiliateId) {
      const affiliateAmount = (parseFloat(totalFee) * affiliateShare).toFixed(8);
      await this.sql`
        UPDATE affiliates
        SET total_earned = total_earned + ${affiliateAmount}, updated_at = NOW()
        WHERE id = ${affiliateId}
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
    return (parseFloat(amount) * this.config.platformFeePercent).toFixed(8);
  }
}
