/**
 * modules/affiliate/scheduler.ts
 * Cron-style affiliate payout scheduler.
 *
 * Runs periodically and, for each affiliate with a configured payout_address,
 * aggregates undistributed revenue events into a single `affiliate_payouts`
 * batch row. The batch is marked 'pending' and picked up by the payout worker
 * (actual on-chain disbursement is out of scope for Phase 4 and is left as
 * 'pending' until an off-chain operator settles it — the status transitions
 * are still automated).
 *
 * Design notes:
 *  - Uses setInterval (Bun-compatible) rather than an external cron runner to
 *    avoid extra infrastructure in Phase 4.
 *  - Idempotent: a payout batch only "consumes" revenue events via
 *    affiliate_payout_items, and those events get distributed_at set inside
 *    the same transaction. Re-runs therefore cannot double-pay.
 *  - Enabled via PAYOUT_SCHEDULER_ENABLED=true (default: false). Interval via
 *    PAYOUT_INTERVAL_MS (default: 1 hour).
 */

import type { SQL } from 'postgres';
import { generateUUID } from '@finlayer/utils';
import { logger } from '../shared/utils/logger.js';

export interface SchedulerOptions {
  intervalMs?: number;
  minPayoutAmount?: number; // e.g. 1.0 USDC — avoid micro-payouts
  payoutAsset?: string;
  enabled?: boolean;
}

interface AffiliateWithPending {
  affiliate_id: string;
  payout_address: string;
  total_pending: string;
  event_count: string; // postgres COUNT(*) is bigint → returned as string
}

interface PendingRevenueEvent {
  id: string;
  total_fee: string;
  affiliate_share: string;
}

export interface PayoutRunSummary {
  scanned: number;
  batches_created: number;
  skipped: number;
}

export class AffiliatePayoutScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly minPayoutAmount: number;
  private readonly payoutAsset: string;

  constructor(
    private readonly sql: SQL,
    options: SchedulerOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? 60 * 60 * 1000;
    this.minPayoutAmount = options.minPayoutAmount ?? 1.0;
    this.payoutAsset = options.payoutAsset ?? 'USDC';
  }

  /** Start the interval-based loop. Safe to call multiple times. */
  start(): void {
    if (this.timer) return;
    logger.info('Affiliate payout scheduler started', {
      intervalMs: this.intervalMs,
      minPayoutAmount: this.minPayoutAmount,
      payoutAsset: this.payoutAsset,
    });

    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        logger.error('Payout scheduler tick failed', { error: String(err) });
      });
    }, this.intervalMs);
    // Do not keep the event loop alive just for the scheduler
    if (typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info('Affiliate payout scheduler stopped');
  }

  /**
   * Perform a single pass over eligible affiliates. Exposed for tests and for
   * manual triggering via an admin endpoint.
   */
  async runOnce(): Promise<PayoutRunSummary> {
    if (this.running) {
      logger.debug('Payout run already in progress, skipping');
      return { scanned: 0, batches_created: 0, skipped: 0 };
    }
    this.running = true;
    try {
      const eligible = await this.sql<AffiliateWithPending[]>`
        SELECT
          a.id AS affiliate_id,
          a.payout_address,
          COALESCE(SUM(re.total_fee * re.affiliate_share), 0) AS total_pending,
          COUNT(re.id) AS event_count
        FROM affiliates a
        JOIN revenue_events re ON re.affiliate_id = a.id
        WHERE a.payout_address IS NOT NULL
          AND re.distributed_at IS NULL
        GROUP BY a.id, a.payout_address
        HAVING COUNT(re.id) > 0
      `;

      let created = 0;
      let skipped = 0;
      for (const row of eligible) {
        if (parseFloat(row.total_pending) < this.minPayoutAmount) {
          skipped++;
          continue;
        }
        await this.createPayout(row);
        created++;
      }

      const summary: PayoutRunSummary = {
        scanned: eligible.length,
        batches_created: created,
        skipped,
      };
      logger.info('Affiliate payout run complete', { ...summary });
      return summary;
    } finally {
      this.running = false;
    }
  }

  private async createPayout(row: AffiliateWithPending): Promise<void> {
    const events = await this.sql<PendingRevenueEvent[]>`
      SELECT id, total_fee, affiliate_share
      FROM revenue_events
      WHERE affiliate_id = ${row.affiliate_id}
        AND distributed_at IS NULL
      ORDER BY created_at ASC
    `;

    if (events.length === 0) return;

    const payoutId = generateUUID();

    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO affiliate_payouts (
          id, affiliate_id, amount, asset,
          payout_address, status, event_count, scheduled_at
        ) VALUES (
          ${payoutId}, ${row.affiliate_id}, ${row.total_pending}, ${this.payoutAsset},
          ${row.payout_address}, 'pending', ${events.length}, NOW()
        )
      `;

      for (const ev of events) {
        const amount = (parseFloat(ev.total_fee) * parseFloat(ev.affiliate_share)).toFixed(8);
        await tx`
          INSERT INTO affiliate_payout_items (payout_id, revenue_event_id, amount)
          VALUES (${payoutId}, ${ev.id}, ${amount})
        `;
        await tx`
          UPDATE revenue_events SET distributed_at = NOW() WHERE id = ${ev.id}
        `;
      }

      await tx`
        UPDATE affiliates
        SET total_paid_out = total_paid_out + ${row.total_pending},
            updated_at = NOW()
        WHERE id = ${row.affiliate_id}
      `;
    });

    logger.info('Affiliate payout batch created', {
      payoutId,
      affiliateId: row.affiliate_id,
      amount: row.total_pending,
      eventCount: events.length,
    });
  }
}
