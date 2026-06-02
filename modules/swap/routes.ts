/**
 * modules/swap/routes.ts
 * Swap API routes: /v1/swap/
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SwapService } from './service.js';
import { ChangeNOWAdapter } from '../providers/changenow/adapter.js';
import { ValidationError, FinLayerError } from '../shared/errors/index.js';
import type { ISwapProviderAdapter } from '../shared/types/index.js';
import { logger } from '../shared/utils/logger.js';
import { buildCacheFromEnv } from '../shared/cache/index.js';

const QuoteRequestSchema = z.object({
  from_asset: z.string().min(2).max(10).toUpperCase(),
  to_asset: z.string().min(2).max(10).toUpperCase(),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'amount must be a positive number'),
  from_network: z.string().optional(),
  to_network: z.string().optional(),
  affiliate_id: z.string().uuid().optional(),
  idempotency_key: z.string().min(8).max(128).optional(),
});

const ExecuteRequestSchema = z.object({
  quote_id: z.string().uuid('quote_id must be a valid UUID'),
  recipient_address: z.string().min(10, 'recipient_address is required'),
  refund_address: z.string().min(10).optional(),
  affiliate_id: z.string().uuid().optional(),
  idempotency_key: z.string().min(8).max(128),
});

export async function swapRoutes(fastify: FastifyInstance): Promise<void> {
  // Initialize providers
  const providers = new Map<string, ISwapProviderAdapter>();
  const changeNowApiKey = process.env['CHANGENOW_API_KEY'];
  if (changeNowApiKey) {
    const changeNowWebhookSecret = process.env['CHANGENOW_WEBHOOK_SECRET'] ?? '';
    providers.set('ChangeNOW', new ChangeNOWAdapter(changeNowApiKey, changeNowWebhookSecret));
    if (!changeNowWebhookSecret) {
      logger.warn('CHANGENOW_WEBHOOK_SECRET not set — swap webhooks will be rejected until configured');
    }
    logger.info('ChangeNOW provider initialized');
  } else {
    logger.warn('CHANGENOW_API_KEY not set — swap provider not available in production');
  }

  // Boot cache backend (Redis if REDIS_URL set, otherwise in-memory).
  const cache = await buildCacheFromEnv();
  const swapService = new SwapService(fastify.sql, providers, { cache });

  /**
   * GET /v1/swap/providers
   * List available swap providers.
   */
  fastify.get('/providers', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Swap'],
      summary: 'List swap providers',
      description: 'Returns all active swap (crypto exchange) providers.',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    },
  }, async (request, reply) => {
    const rows = await fastify.sql`
      SELECT id, name, domain, is_active, priority
      FROM providers
      WHERE domain = 'swap' AND is_active = TRUE
      ORDER BY priority DESC
    `;
    return reply.send({ data: rows });
  });

  /**
   * POST /v1/swap/quote
   * Get swap quotes from all available providers.
   */
  fastify.post('/quote', {
    preHandler: [fastify.authenticate, fastify.requireScope('swap:read')],
    schema: {
      tags: ['Swap'],
      summary: 'Get swap quote',
      description: 'Get the best swap quote across all providers for the given asset pair.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['from_asset', 'to_asset', 'amount'],
        properties: {
          from_asset: { type: 'string', minLength: 2, maxLength: 10, description: 'Source asset ticker, e.g. BTC' },
          to_asset: { type: 'string', minLength: 2, maxLength: 10, description: 'Target asset ticker, e.g. ETH' },
          amount: { type: 'string', description: 'Amount of from_asset to exchange' },
          from_network: { type: 'string', description: 'Source network, e.g. bitcoin' },
          to_network: { type: 'string', description: 'Target network, e.g. ethereum' },
          affiliate_id: { type: 'string', format: 'uuid', description: 'Affiliate ID for revenue tracking' },
        },
      },
      response: {
        200: {
          description: 'Swap quotes from all providers',
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                quotes: { type: 'array', items: { type: 'object' } },
                best_quote_id: { type: 'string', format: 'uuid' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const parsed = QuoteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid quote request', parsed.error.flatten() as unknown as Record<string, unknown>);
    }

    const result = await swapService.getQuote(request.userId!, parsed.data);
    return reply.send({ data: result });
  });

  /**
   * POST /v1/swap/execute
   * Execute a swap using a quote. Returns 202 Accepted with async tracking.
   */
  fastify.post('/execute', {
    preHandler: [fastify.authenticate, fastify.requireScope('swap:write')],
    schema: {
      tags: ['Swap'],
      summary: 'Execute swap',
      description: 'Execute a previously obtained swap quote. Returns a deposit address and webhook URL for tracking.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['quote_id', 'recipient_address', 'idempotency_key'],
        properties: {
          quote_id: { type: 'string', format: 'uuid', description: 'Quote ID from POST /quote' },
          recipient_address: { type: 'string', description: 'Destination address for output asset' },
          refund_address: { type: 'string', description: 'Address to refund if exchange fails' },
          affiliate_id: { type: 'string', format: 'uuid', description: 'Affiliate ID for revenue tracking' },
          idempotency_key: { type: 'string', minLength: 8, maxLength: 128, description: 'Unique key to prevent duplicate transactions' },
        },
      },
      response: {
        202: {
          description: 'Swap initiated. Send from_asset to deposit_address and monitor via webhook.',
          type: 'object',
          properties: {
            data: { type: 'object' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const parsed = ExecuteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid execute request', parsed.error.flatten() as unknown as Record<string, unknown>);
    }

    const transaction = await swapService.executeSwap(request.userId!, parsed.data);

    // 202 Accepted — async operation
    return reply.status(202).send({ data: transaction });
  });

  /**
   * GET /v1/swap/tx/:id
   * Get swap transaction status.
   */
  fastify.get('/tx/:id', {
    preHandler: [fastify.authenticate, fastify.requireScope('swap:read')],
    schema: {
      tags: ['Swap'],
      summary: 'Get transaction status',
      description: 'Get the current status of a swap transaction.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Transaction ID' },
        },
      },
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
    const { id } = request.params as { id: string };
    const transaction = await swapService.getSwapStatus(id, request.userId!);
    return reply.send({ data: { transaction } });
  });

  /**
   * POST /v1/swap/webhook/:id
   * Internal webhook endpoint for provider status updates.
   *
   * No bearer auth — providers call this directly. Authenticity is established
   * by verifying the provider's HMAC signature over the raw body (see
   * SwapService.handleWebhook). The `:id` is validated as a UUID and the update
   * is scoped to `domain = 'swap'`, so a forged or foreign request cannot touch
   * a payments/earn transaction.
   */
  fastify.post('/webhook/:id', {
    config: {
      // Keep a raw copy of the body for signature verification.
      rawBody: true,
    },
    schema: {
      tags: ['Swap', 'Internal'],
      summary: 'Provider webhook',
      description: 'Receives signed status updates from swap providers.',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Transaction ID' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const rawBody =
      typeof (request as unknown as { rawBody?: string | Buffer }).rawBody === 'string'
        ? ((request as unknown as { rawBody: string }).rawBody)
        : Buffer.isBuffer((request as unknown as { rawBody?: Buffer }).rawBody)
        ? ((request as unknown as { rawBody: Buffer }).rawBody.toString('utf8'))
        : JSON.stringify(request.body ?? {});

    logger.info('Swap webhook received', { txId: id });

    const result = await swapService.handleWebhook({
      txId: id,
      rawBody,
      headers: request.headers as Record<string, string | string[] | undefined>,
    });

    return reply.send({ ok: true, ...result });
  });
}
