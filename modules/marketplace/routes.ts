/**
 * modules/marketplace/routes.ts
 * Marketplace API routes: /v1/marketplace/
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MarketplaceService, type MarketplaceLinkParams } from './service.js';
import { ValidationError } from '../shared/errors/index.js';

const BaseFields = {
  label: z.string().max(255).optional(),
  campaign: z.string().max(64).optional(),
};

const SwapSchema = z.object({
  kind: z.literal('swap'),
  from_asset: z.string().min(2).max(10),
  to_asset: z.string().min(2).max(10),
  amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  recipient_address: z.string().min(10).optional(),
  ...BaseFields,
});

const PaymentSchema = z.object({
  kind: z.literal('payment'),
  asset: z.string().min(2).max(10),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  network: z.string().max(50).optional(),
  description: z.string().max(500).optional(),
  ...BaseFields,
});

const EarnSchema = z.object({
  kind: z.literal('earn'),
  strategy_id: z.string().uuid(),
  amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  ...BaseFields,
});

const GenerateSchema = z.discriminatedUnion('kind', [SwapSchema, PaymentSchema, EarnSchema]);

export async function marketplaceRoutes(fastify: FastifyInstance): Promise<void> {
  const marketplace = new MarketplaceService(fastify.sql);

  /**
   * POST /v1/marketplace/link
   * Generate an affiliate marketplace deep link.
   */
  fastify.post('/link', {
    preHandler: [fastify.authenticate, fastify.requireScope('affiliate:write')],
    schema: {
      tags: ['Marketplace', 'Affiliate'],
      summary: 'Generate affiliate marketplace link',
      description:
        'Produce a deep link (and persisted `affiliate_links` row) that pre-fills a swap, ' +
        'payment, or earn action and auto-attributes the affiliate. Returns the short tracking ' +
        'URL, the target deep link, and an SDK snippet for embedding.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['kind'],
        properties: {
          kind: { type: 'string', enum: ['swap', 'payment', 'earn'] },
          from_asset: { type: 'string' },
          to_asset: { type: 'string' },
          asset: { type: 'string' },
          amount: { type: 'string' },
          recipient_address: { type: 'string' },
          strategy_id: { type: 'string', format: 'uuid' },
          network: { type: 'string' },
          description: { type: 'string' },
          label: { type: 'string' },
          campaign: { type: 'string' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: { data: { type: 'object' } },
        },
      },
    },
  }, async (request, reply) => {
    const parsed = GenerateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(
        'Invalid marketplace link request',
        parsed.error.flatten() as unknown as Record<string, unknown>
      );
    }
    const generated = await marketplace.generate(request.userId!, parsed.data as MarketplaceLinkParams);
    return reply.status(201).send({ data: generated });
  });
}
