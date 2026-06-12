/**
 * modules/payments/routes.ts
 * Payments API routes: /v1/payments/
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PaymentsService } from './service.js';
import { MoonPayAdapter } from '../providers/moonpay/adapter.js';
import { TransakAdapter } from '../providers/transak/adapter.js';
import { NowPaymentsAdapter } from '../providers/nowpayments/adapter.js';
import { ValidationError } from '../shared/errors/index.js';
import type { IPaymentProviderAdapter } from '../shared/types/index.js';
import { logger } from '../shared/utils/logger.js';

const InvoiceCreateSchema = z.object({
  asset: z.string().min(2).max(20),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'amount must be a positive number'),
  network: z.string().optional(),
  description: z.string().max(1000).optional(),
  expires_in_seconds: z.number().int().min(60).max(7 * 24 * 60 * 60).optional(),
  callback_url: z.string().url().optional(),
  affiliate_id: z.string().uuid().optional(),
  idempotency_key: z.string().min(8).max(128),
  metadata: z.record(z.unknown()).optional(),
});

export async function paymentsRoutes(fastify: FastifyInstance): Promise<void> {
  // Initialise providers from environment.
  const providers = new Map<string, IPaymentProviderAdapter>();

  const moonpayKey = process.env['MOONPAY_API_KEY'];
  if (moonpayKey) {
    providers.set('MoonPay', new MoonPayAdapter(moonpayKey, process.env['MOONPAY_WEBHOOK_SECRET'] ?? ''));
    logger.info('MoonPay provider initialized');
  }

  const transakKey = process.env['TRANSAK_API_KEY'];
  if (transakKey) {
    providers.set(
      'Transak',
      new TransakAdapter(
        transakKey,
        process.env['TRANSAK_WEBHOOK_SECRET'] ?? '',
        process.env['TRANSAK_API_URL'] ?? undefined,
        process.env['TRANSAK_API_SECRET'] ?? ''
      )
    );
    logger.info('Transak provider initialized');
  }

  const nowPaymentsKey = process.env['NOWPAYMENTS_API_KEY'];
  if (nowPaymentsKey) {
    providers.set(
      'NowPayments',
      new NowPaymentsAdapter(nowPaymentsKey, process.env['NOWPAYMENTS_IPN_SECRET'] ?? '')
    );
    logger.info('NowPayments provider initialized');
  }

  if (providers.size === 0) {
    logger.warn('No payment provider API keys configured — payments module inactive');
  }

  const paymentsService = new PaymentsService(fastify.sql, providers);

  /**
   * GET /v1/payments/providers — list active payment providers.
   */
  fastify.get('/providers', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Payments'],
      summary: 'List payment providers',
      description: 'Returns all active payment (fiat on-ramp + crypto invoice) providers.',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'object' } } },
        },
      },
    },
  }, async (_request, reply) => {
    const rows = await fastify.sql`
      SELECT id, name, domain, is_active, priority
      FROM providers
      WHERE domain = 'payments' AND is_active = TRUE
      ORDER BY priority DESC
    `;
    return reply.send({ data: rows });
  });

  /**
   * POST /v1/payments/invoice — create a new invoice.
   */
  fastify.post('/invoice', {
    preHandler: [fastify.authenticate, fastify.requireScope('payments:write')],
    schema: {
      tags: ['Payments'],
      summary: 'Create invoice',
      description:
        'Create a new payment invoice via the configured provider. Returns a deposit address (or widget URL for fiat on-ramps) plus a webhook URL for async status updates.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['asset', 'amount', 'idempotency_key'],
        properties: {
          asset: { type: 'string', minLength: 2, maxLength: 20 },
          amount: { type: 'string' },
          network: { type: 'string' },
          description: { type: 'string', maxLength: 1000 },
          expires_in_seconds: { type: 'integer', minimum: 60, maximum: 604800 },
          callback_url: { type: 'string', format: 'uri' },
          affiliate_id: { type: 'string', format: 'uuid' },
          idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
      response: {
        201: {
          description: 'Invoice created.',
          type: 'object',
          properties: { data: { type: 'object' } },
        },
      },
    },
  }, async (request, reply) => {
    const parsed = InvoiceCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid invoice request', parsed.error.flatten() as unknown as Record<string, unknown>);
    }

    const invoice = await paymentsService.createInvoice(request.userId!, parsed.data);
    return reply.status(201).send({ data: { invoice } });
  });

  /**
   * GET /v1/payments/invoice/:id — fetch invoice status.
   */
  fastify.get('/invoice/:id', {
    preHandler: [fastify.authenticate, fastify.requireScope('payments:read')],
    schema: {
      tags: ['Payments'],
      summary: 'Get invoice',
      description: 'Fetch invoice status. Refreshes from the provider if not yet in a terminal state.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'object' } },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const invoice = await paymentsService.getInvoice(id, request.userId!);
    return reply.send({ data: { invoice } });
  });

  /**
   * POST /v1/payments/webhook/:provider — inbound provider webhook.
   *
   * Idempotent: duplicate deliveries (same provider_event_id) are no-ops.
   * The signature is verified with the provider-specific secret configured via
   * *_WEBHOOK_SECRET env vars.
   */
  fastify.post('/webhook/:provider', {
    // No auth — providers call this directly; signature verification replaces auth.
    config: {
      // Keep a raw copy of the body for signature verification.
      rawBody: true,
    },
    schema: {
      tags: ['Payments', 'Internal'],
      summary: 'Provider webhook',
      description:
        'Inbound webhook from a payment provider. Verifies the provider signature, records the delivery, and updates the invoice. Idempotent across retries.',
      params: {
        type: 'object',
        required: ['provider'],
        properties: { provider: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { provider } = request.params as { provider: string };

    // Canonicalise provider name for case-insensitive lookup (MoonPay/moonpay).
    const providerName =
      Array.from(providers.keys()).find(n => n.toLowerCase() === provider.toLowerCase()) ??
      provider;

    const rawBody =
      typeof (request as unknown as { rawBody?: string | Buffer }).rawBody === 'string'
        ? ((request as unknown as { rawBody: string }).rawBody)
        : Buffer.isBuffer((request as unknown as { rawBody?: Buffer }).rawBody)
        ? ((request as unknown as { rawBody: Buffer }).rawBody.toString('utf8'))
        : JSON.stringify(request.body ?? {});

    const result = await paymentsService.handleWebhook({
      providerName,
      rawBody,
      headers: request.headers as Record<string, string | string[] | undefined>,
    });

    return reply.send({ ok: true, ...result });
  });
}
