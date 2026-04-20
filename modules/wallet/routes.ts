/**
 * modules/wallet/routes.ts
 * Wallet API routes: /v1/wallet/
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WalletService } from './service.js';
import { AlchemyBalanceProvider } from '../providers/alchemy/adapter.js';
import { MockBalanceProvider } from '../providers/mock-balance/adapter.js';
import { ValidationError } from '../shared/errors/index.js';
import type { IWalletBalanceProvider } from '../shared/types/index.js';
import { logger } from '../shared/utils/logger.js';

const CreateAddressSchema = z.object({
  asset: z.string().min(2).max(10),
  network: z.string().min(2).max(30),
  label: z.string().max(255).optional(),
});

/**
 * Build the balance provider registry from environment. A mock provider is
 * always registered so local development works without any API keys.
 */
function buildBalanceProviders(): Map<string, IWalletBalanceProvider> {
  const providers = new Map<string, IWalletBalanceProvider>();

  const alchemyKey = process.env['ALCHEMY_API_KEY'];
  if (alchemyKey) {
    providers.set('Alchemy', new AlchemyBalanceProvider(alchemyKey));
    logger.info('Alchemy balance provider initialized');
  }

  // Mock provider covers all networks so /wallet/balance never 502s in dev.
  providers.set('MockBalance', new MockBalanceProvider());
  return providers;
}

export async function walletRoutes(fastify: FastifyInstance): Promise<void> {
  const providers = buildBalanceProviders();
  const walletService = new WalletService(fastify.sql, providers);

  /**
   * GET /v1/wallet/supported
   * List asset/network pairs that can be generated.
   */
  fastify.get('/supported', {
    preHandler: [fastify.authenticate, fastify.requireScope('wallet:read')],
    schema: {
      tags: ['Wallet'],
      summary: 'List supported (asset, network) pairs',
      security: [{ bearerAuth: [] }],
    },
  }, async () => ({
    data: { pairs: walletService.listSupportedPairs() },
  }));

  /**
   * POST /v1/wallet/generate
   * Create the user's HD wallet (one-time) and seed default addresses.
   * Returns the mnemonic ONCE on creation; never retrievable afterward.
   */
  fastify.post('/generate', {
    preHandler: [fastify.authenticate, fastify.requireScope('wallet:write')],
    schema: {
      tags: ['Wallet'],
      summary: 'Generate HD wallet',
      description: [
        'Generate a BIP39 mnemonic + default BIP44 addresses. The mnemonic is',
        'returned ONLY on creation and stored encrypted at rest. Subsequent',
        'calls return the existing wallet without the mnemonic.',
      ].join(' '),
      security: [{ bearerAuth: [] }],
      response: {
        201: { type: 'object', properties: { data: { type: 'object' } } },
        200: { type: 'object', properties: { data: { type: 'object' } } },
      },
    },
  }, async (request, reply) => {
    const result = await walletService.generateWallet(request.userId!);
    return reply.status(result.created ? 201 : 200).send({ data: result });
  });

  /**
   * GET /v1/wallet/addresses
   * List all addresses across chains for the current user.
   */
  fastify.get('/addresses', {
    preHandler: [fastify.authenticate, fastify.requireScope('wallet:read')],
    schema: {
      tags: ['Wallet'],
      summary: 'List wallet addresses',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const addresses = await walletService.listAddresses(request.userId!);
    return { data: { addresses } };
  });

  /**
   * POST /v1/wallet/addresses
   * Derive a new address for a specific (asset, network) pair.
   */
  fastify.post('/addresses', {
    preHandler: [fastify.authenticate, fastify.requireScope('wallet:write')],
    schema: {
      tags: ['Wallet'],
      summary: 'Create wallet address',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['asset', 'network'],
        properties: {
          asset: { type: 'string', minLength: 2, maxLength: 10 },
          network: { type: 'string', minLength: 2, maxLength: 30 },
          label: { type: 'string', maxLength: 255 },
        },
      },
    },
  }, async (request, reply) => {
    const parsed = CreateAddressSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid address request', parsed.error.flatten() as unknown as Record<string, unknown>);
    }
    const address = await walletService.createAddress(request.userId!, parsed.data);
    return reply.status(201).send({ data: { address } });
  });

  /**
   * GET /v1/wallet/addresses/:id/balance
   * Fetch the native balance for a user address.
   */
  fastify.get('/addresses/:id/balance', {
    preHandler: [fastify.authenticate, fastify.requireScope('wallet:read')],
    schema: {
      tags: ['Wallet'],
      summary: 'Query address balance',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const balance = await walletService.getBalance(request.userId!, id);
    return { data: { balance } };
  });
}
