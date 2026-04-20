/**
 * modules/analytics/routes.ts
 * Analytics API routes: /v1/analytics/
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AnalyticsService, type AnalyticsPeriod } from './service.js';
import { AffiliateService } from '../affiliate/service.js';
import { ValidationError } from '../shared/errors/index.js';

const PERIODS: readonly AnalyticsPeriod[] = ['24h', '7d', '30d', '90d', 'all'] as const;

const QuerySchema = z.object({
  period: z.enum(PERIODS as unknown as [AnalyticsPeriod, ...AnalyticsPeriod[]]).optional(),
});

export async function analyticsRoutes(fastify: FastifyInstance): Promise<void> {
  const analytics = new AnalyticsService(fastify.sql);
  const affiliate = new AffiliateService(fastify.sql);

  /**
   * GET /v1/analytics/revenue
   * Platform-wide cross-domain revenue dashboard. Requires admin scope
   * because it exposes totals across all users.
   */
  fastify.get('/revenue', {
    preHandler: [fastify.authenticate, fastify.requireScope('admin')],
    schema: {
      tags: ['Analytics'],
      summary: 'Cross-domain revenue dashboard',
      description:
        'Aggregate revenue figures across swap, payments, and earn for the requested window. ' +
        'Includes domain breakdown, provider success rates, a daily/hourly timeseries, and the top affiliates.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: PERIODS as unknown as string[],
            description: 'Lookback window (default: 30d)',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'object' } },
        },
      },
    },
  }, async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ValidationError('Invalid analytics query', parsed.error.flatten() as unknown as Record<string, unknown>);
    }
    const dashboard = await analytics.getDashboard(parsed.data.period ?? '30d');
    return reply.send({ data: dashboard });
  });

  /**
   * GET /v1/analytics/affiliate
   * Per-affiliate revenue dashboard, scoped to the requesting user's
   * affiliate profile. Any user with the affiliate:read scope can call this.
   */
  fastify.get('/affiliate', {
    preHandler: [fastify.authenticate, fastify.requireScope('affiliate:read')],
    schema: {
      tags: ['Analytics', 'Affiliate'],
      summary: 'Per-affiliate revenue dashboard',
      description:
        'Same shape as the platform dashboard but filtered to the caller\'s affiliate profile. ' +
        'Safe for agents to poll frequently; only their own numbers are returned.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: PERIODS as unknown as string[],
            description: 'Lookback window (default: 30d)',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'object' } },
        },
      },
    },
  }, async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ValidationError('Invalid analytics query', parsed.error.flatten() as unknown as Record<string, unknown>);
    }
    const profile = await affiliate.getOrCreateAffiliate(request.userId!);
    const dashboard = await analytics.getAffiliateDashboard(profile.id, parsed.data.period ?? '30d');
    return reply.send({ data: dashboard });
  });
}
