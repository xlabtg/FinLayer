/**
 * modules/earn/routes.ts
 * Earn API routes: /v1/earn/
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EarnService } from './service.js';
import { AaveV3Adapter, type AaveRpcClient } from '../providers/aave/adapter.js';
import { AaveV3JsonRpcClient } from '../providers/aave/rpc.js';
import { CompoundV3Adapter, type CompoundRpcClient } from '../providers/compound/adapter.js';
import { CompoundV3JsonRpcClient } from '../providers/compound/rpc.js';
import { ValidationError } from '../shared/errors/index.js';
import type { IEarnProviderAdapter } from '../shared/types/index.js';
import { logger } from '../shared/utils/logger.js';

const DepositRequestSchema = z.object({
  strategy_id: z.string().min(3, 'strategy_id is required'),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'amount must be a positive number'),
  from_address: z.string().min(10, 'from_address is required'),
  affiliate_id: z.string().uuid().optional(),
  affiliate_link_id: z.string().uuid().optional(),
  idempotency_key: z.string().min(8).max(128),
});

const WithdrawRequestSchema = z.object({
  position_id: z.string().uuid('position_id must be a valid UUID'),
  to_address: z.string().min(10, 'to_address is required'),
  affiliate_id: z.string().uuid().optional(),
  affiliate_link_id: z.string().uuid().optional(),
  idempotency_key: z.string().min(8).max(128),
});

/**
 * Options to inject adapters at route-register time.
 * When omitted, falls back to reading env vars + creating real adapters (no-op
 * RPC clients when AAVE_RPC_URL / COMPOUND_RPC_URL are absent).
 */
export interface EarnRoutesOptions {
  adapters?: Map<string, IEarnProviderAdapter>;
}

export async function earnRoutes(fastify: FastifyInstance, opts: EarnRoutesOptions = {}): Promise<void> {
  const providers = opts.adapters ?? buildDefaultAdapters();
  const earnService = new EarnService(fastify.sql, providers);

  /**
   * GET /v1/earn/strategies
   * List yield strategies across all earn providers.
   */
  fastify.get('/strategies', {
    preHandler: [fastify.authenticate, fastify.requireScope('earn:read')],
    schema: {
      tags: ['Earn'],
      summary: 'List earn strategies',
      description: 'Returns yield strategies (Aave V3, Compound V3, …) with live APY.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          asset: { type: 'string', description: 'Filter by asset ticker, e.g. USDC' },
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
    const query = request.query as { asset?: string };
    const result = await earnService.listStrategies(
      query.asset === undefined ? undefined : { asset: query.asset }
    );
    return reply.send({ data: result });
  });

  /**
   * POST /v1/earn/deposit
   * Initiate a deposit into an earn strategy. Returns 202 Accepted.
   */
  fastify.post('/deposit', {
    preHandler: [fastify.authenticate, fastify.requireScope('earn:write')],
    schema: {
      tags: ['Earn'],
      summary: 'Deposit to earn strategy',
      description: 'Deposit into a yield strategy (Aave V3, Compound V3). Async on-chain operation.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['strategy_id', 'amount', 'from_address', 'idempotency_key'],
        properties: {
          strategy_id: { type: 'string', description: '<provider_id>:<provider_strategy_id>' },
          amount: { type: 'string' },
          from_address: { type: 'string' },
          affiliate_id: { type: 'string', format: 'uuid' },
          affiliate_link_id: { type: 'string', format: 'uuid' },
          idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
        },
      },
      response: {
        202: { type: 'object', properties: { data: { type: 'object' } } },
      },
    },
  }, async (request, reply) => {
    const parsed = DepositRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(
        'Invalid deposit request',
        parsed.error.flatten() as unknown as Record<string, unknown>
      );
    }
    const result = await earnService.deposit(request.userId!, parsed.data);
    return reply.status(202).send({ data: result });
  });

  /**
   * POST /v1/earn/withdraw
   * Withdraw an earn position.
   */
  fastify.post('/withdraw', {
    preHandler: [fastify.authenticate, fastify.requireScope('earn:write')],
    schema: {
      tags: ['Earn'],
      summary: 'Withdraw earn position',
      description: 'Withdraw principal + accrued yield from an active position.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['position_id', 'to_address', 'idempotency_key'],
        properties: {
          position_id: { type: 'string', format: 'uuid' },
          to_address: { type: 'string' },
          affiliate_id: { type: 'string', format: 'uuid' },
          affiliate_link_id: { type: 'string', format: 'uuid' },
          idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
        },
      },
      response: {
        202: { type: 'object', properties: { data: { type: 'object' } } },
      },
    },
  }, async (request, reply) => {
    const parsed = WithdrawRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(
        'Invalid withdraw request',
        parsed.error.flatten() as unknown as Record<string, unknown>
      );
    }
    const result = await earnService.withdraw(request.userId!, parsed.data);
    return reply.status(202).send({ data: result });
  });

  /**
   * GET /v1/earn/positions
   * List the authenticated user's earn positions.
   */
  fastify.get('/positions', {
    preHandler: [fastify.authenticate, fastify.requireScope('earn:read')],
    schema: {
      tags: ['Earn'],
      summary: 'List earn positions',
      security: [{ bearerAuth: [] }],
      response: {
        200: { type: 'object', properties: { data: { type: 'object' } } },
      },
    },
  }, async (request, reply) => {
    const result = await earnService.listPositions(request.userId!);
    return reply.send({ data: result });
  });

  /**
   * GET /v1/earn/positions/:id
   * Get a single position (refreshed from chain).
   */
  fastify.get('/positions/:id', {
    preHandler: [fastify.authenticate, fastify.requireScope('earn:read')],
    schema: {
      tags: ['Earn'],
      summary: 'Get earn position',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: { type: 'object', properties: { data: { type: 'object' } } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const position = await earnService.getPosition(request.userId!, id);
    return reply.send({ data: { position } });
  });
}

/**
 * Build default adapters wired to env vars. When RPC URLs aren't present,
 * listing still works through provider APIs but write ops fail loudly.
 */
function buildDefaultAdapters(): Map<string, IEarnProviderAdapter> {
  const providers = new Map<string, IEarnProviderAdapter>();

  const aaveRpcUrl = process.env['AAVE_RPC_URL'];
  const compoundRpcUrl = process.env['COMPOUND_RPC_URL'];

  providers.set(
    'AaveV3',
    new AaveV3Adapter({
      rpcClient: aaveRpcUrl
        ? new AaveV3JsonRpcClient({ rpcUrl: aaveRpcUrl })
        : makeUnavailableAaveRpc(),
    })
  );
  providers.set(
    'CompoundV3',
    new CompoundV3Adapter({
      rpcClient: compoundRpcUrl
        ? new CompoundV3JsonRpcClient({ rpcUrl: compoundRpcUrl })
        : makeUnavailableCompoundRpc(),
    })
  );

  if (!aaveRpcUrl) {
    logger.warn('AAVE_RPC_URL not set — Aave deposit/withdraw will be unavailable at runtime');
  }
  if (!compoundRpcUrl) {
    logger.warn('COMPOUND_RPC_URL not set — Compound deposit/withdraw will be unavailable at runtime');
  }
  return providers;
}

function makeUnavailableAaveRpc(): AaveRpcClient {
  const err = () => {
    throw new ValidationError(
      'Aave on-chain client is not configured (set AAVE_RPC_URL)'
    );
  };
  return {
    deposit: async () => err(),
    withdraw: async () => err(),
    getPosition: async () => err(),
    isHealthy: async () => false,
  };
}

function makeUnavailableCompoundRpc(): CompoundRpcClient {
  const err = () => {
    throw new ValidationError(
      'Compound on-chain client is not configured (set COMPOUND_RPC_URL)'
    );
  };
  return {
    deposit: async () => err(),
    withdraw: async () => err(),
    getPosition: async () => err(),
    isHealthy: async () => false,
  };
}
