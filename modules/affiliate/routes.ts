/**
 * modules/affiliate/routes.ts
 * Affiliate API routes: /v1/affiliate/
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AffiliateService } from './service.js';
import { ValidationError } from '../shared/errors/index.js';

const CreateLinkSchema = z.object({
  target_url: z.string().url('target_url must be a valid URL').max(1000),
  label: z.string().max(255).optional(),
});

export async function affiliateRoutes(fastify: FastifyInstance): Promise<void> {
  const affiliateService = new AffiliateService(fastify.sql);

  /**
   * POST /v1/affiliate/link
   * Create an affiliate tracking link.
   */
  fastify.post('/link', {
    preHandler: [fastify.authenticate, fastify.requireScope('affiliate:write')],
    schema: {
      tags: ['Affiliate'],
      summary: 'Create affiliate link',
      description: 'Create a new trackable affiliate link with click and conversion tracking.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['target_url'],
        properties: {
          target_url: { type: 'string', format: 'uri', description: 'Target URL to track' },
          label: { type: 'string', maxLength: 255, description: 'Human-readable label' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            data: { type: 'object' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const parsed = CreateLinkSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid link request', parsed.error.flatten() as unknown as Record<string, unknown>);
    }

    const affiliate = await affiliateService.getOrCreateAffiliate(request.userId!);
    const link = await affiliateService.createLink(affiliate.id, parsed.data);
    return reply.status(201).send({ data: link });
  });

  /**
   * GET /v1/affiliate/stats
   * Affiliate revenue dashboard.
   */
  fastify.get('/stats', {
    preHandler: [fastify.authenticate, fastify.requireScope('affiliate:read')],
    schema: {
      tags: ['Affiliate'],
      summary: 'Affiliate stats',
      description: 'Get affiliate performance stats including clicks, conversions, and revenue.',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'object' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const stats = await affiliateService.getStats(request.userId!);
    return reply.send({ data: stats });
  });

  /**
   * GET /v1/affiliate/payouts
   * List the current affiliate's payout batches.
   */
  fastify.get('/payouts', {
    preHandler: [fastify.authenticate, fastify.requireScope('affiliate:read')],
    schema: {
      tags: ['Affiliate'],
      summary: 'List affiliate payout batches',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const affiliate = await affiliateService.getOrCreateAffiliate(request.userId!);
    const rows = await fastify.sql`
      SELECT id, amount, asset, payout_address, status, tx_hash,
             event_count, scheduled_at, processed_at, created_at
      FROM affiliate_payouts
      WHERE affiliate_id = ${affiliate.id}
      ORDER BY created_at DESC
      LIMIT 100
    `;
    return reply.send({ data: { payouts: rows } });
  });

  /**
   * POST /v1/affiliate/payouts/run
   * Trigger a payout batching run (admin-only).
   */
  fastify.post('/payouts/run', {
    preHandler: [fastify.authenticate, fastify.requireScope('admin')],
    schema: {
      tags: ['Affiliate'],
      summary: 'Trigger payout scheduler',
      description: 'Manually run the affiliate payout batching job. Requires admin scope.',
      security: [{ bearerAuth: [] }],
    },
  }, async (_request, reply) => {
    const summary = await fastify.payoutScheduler.runOnce();
    return reply.send({ data: summary });
  });

  /**
   * GET /r/:code
   * Affiliate link redirect (registered at root, not /v1/affiliate/).
   */
  fastify.get('/r/:code', {
    schema: {
      tags: ['Affiliate'],
      summary: 'Affiliate link redirect',
      params: {
        type: 'object',
        required: ['code'],
        properties: {
          code: { type: 'string', description: 'Short code for the affiliate link' },
        },
      },
    },
  }, async (request, reply) => {
    const { code } = request.params as { code: string };
    const targetUrl = await affiliateService.recordClick(code);

    if (!targetUrl) {
      return reply.status(404).send({
        error: {
          code: 'LINK_NOT_FOUND',
          message: 'Affiliate link not found',
          domain: 'affiliate',
          retryable: false,
        },
      });
    }

    return reply.status(302).header('Location', targetUrl).send();
  });
}
