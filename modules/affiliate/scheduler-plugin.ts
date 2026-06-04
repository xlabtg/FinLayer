/**
 * modules/affiliate/scheduler-plugin.ts
 * Fastify plugin that wires up the affiliate payout scheduler.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { AffiliatePayoutScheduler } from './scheduler.js';
import { logger } from '../shared/utils/logger.js';

declare module 'fastify' {
  interface FastifyInstance {
    payoutScheduler: AffiliatePayoutScheduler;
  }
}

export default fp(async function schedulerPlugin(fastify: FastifyInstance) {
  const enabled = process.env['PAYOUT_SCHEDULER_ENABLED'] === 'true';
  const intervalMs = parseInt(process.env['PAYOUT_INTERVAL_MS'] ?? '3600000', 10);
  const minAmount = process.env['PAYOUT_MIN_AMOUNT'] ?? '1.0';
  const payoutAsset = process.env['PAYOUT_ASSET'] ?? 'USDC';

  const scheduler = new AffiliatePayoutScheduler(fastify.sql, {
    intervalMs,
    minPayoutAmount: minAmount,
    payoutAsset,
  });

  fastify.decorate('payoutScheduler', scheduler);

  if (enabled) {
    scheduler.start();
  } else {
    logger.info('Affiliate payout scheduler disabled (set PAYOUT_SCHEDULER_ENABLED=true to enable)');
  }

  fastify.addHook('onClose', async () => {
    scheduler.stop();
  });
}, { name: 'payout-scheduler' });
