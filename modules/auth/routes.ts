/**
 * modules/auth/routes.ts
 * API key management routes: POST /v1/auth/api-keys, GET /v1/auth/me
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../shared/errors/index.js';
import type { ApiKeyCreateRequest, ApiKeyScope } from '@finlayer/types';

const VALID_SCOPES: ApiKeyScope[] = [
  'swap:read', 'swap:write',
  'payments:read', 'payments:write',
  'earn:read', 'earn:write',
  'wallet:read', 'wallet:write',
  'affiliate:read', 'affiliate:write',
  'admin',
];

const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(255),
  scopes: z.array(z.enum(VALID_SCOPES as [ApiKeyScope, ...ApiKeyScope[]])).min(1),
  rate_limit: z.number().int().min(1).max(10000).optional(),
  expires_at: z.string().datetime().optional(),
});

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /v1/auth/api-keys
   * Create a new API key.
   * Requires: authenticate
   */
  fastify.post('/api-keys', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Auth'],
      summary: 'Create API key',
      description: 'Create a new API key with specific scopes. The full key is returned only once.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name', 'scopes'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255, description: 'Human-readable key name' },
          scopes: {
            type: 'array',
            items: { type: 'string', enum: VALID_SCOPES },
            minItems: 1,
            description: 'Access scopes for this key',
          },
          rate_limit: { type: 'integer', minimum: 1, maximum: 10000, description: 'Requests per minute' },
          expires_at: { type: 'string', format: 'date-time', description: 'Optional expiration date' },
        },
      },
      response: {
        201: {
          description: 'API key created. Save the secret — it is not retrievable.',
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                api_key: { type: 'object' },
                secret: { type: 'string', description: 'Full API key — shown only once' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const parsed = CreateApiKeySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body', parsed.error.flatten() as unknown as Record<string, unknown>);
    }

    const userId = request.userId!;
    const result = await fastify.authService.createApiKey(userId, parsed.data as ApiKeyCreateRequest);

    return reply.status(201).send({ data: result });
  });

  /**
   * GET /v1/auth/me
   * Get current API key info.
   */
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Auth'],
      summary: 'Get current API key',
      description: 'Returns information about the authenticated API key and its user.',
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
    return reply.send({
      data: {
        api_key: request.apiKey,
        user: {
          id: request.userId,
        },
      },
    });
  });

  /**
   * DELETE /v1/auth/api-keys/:id
   * Revoke an API key.
   */
  fastify.delete('/api-keys/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Auth'],
      summary: 'Revoke API key',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' } },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await fastify.authService.revokeApiKey(id, request.userId!);
    return reply.status(204).send();
  });
}
