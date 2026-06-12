/**
 * modules/auth/plugin.ts
 * Fastify plugin for authentication — adds auth decorator and preHandler.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ApiKey, ApiKeyScope } from '@finlayer/types';
import { AuthService } from './service.js';
import { UnauthorizedError, FinLayerError } from '../shared/errors/index.js';
import { buildCacheFromEnv } from '../shared/cache/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    authService: AuthService;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireScope: (scope: ApiKeyScope) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    apiKey?: ApiKey;
    userId?: string;
  }
}

export default fp(async function authPlugin(fastify: FastifyInstance) {
  const rateLimitCache = await buildCacheFromEnv();
  const authService = new AuthService(fastify.sql, { rateLimitCache });
  fastify.decorate('authService', authService);
  fastify.addHook('onClose', async () => {
    await rateLimitCache.close();
  });

  // Extract Bearer token from Authorization header
  fastify.decorate('authenticate', async function (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        error: new UnauthorizedError().toApiError(),
      });
    }
    const rawKey = authHeader.slice(7);
    try {
      const apiKey = await authService.validateApiKey(rawKey);
      request.apiKey = apiKey;
      request.userId = apiKey.user_id;
      // Propagate affiliate_id from query or header for tracking
      const affiliateId =
        (request.query as Record<string, unknown>)['affiliate_id'] ??
        request.headers['x-affiliate-id'];
      if (affiliateId && typeof affiliateId === 'string') {
        (request as unknown as Record<string, unknown>)['affiliateId'] = affiliateId;
      }
    } catch (err) {
      if (err instanceof FinLayerError) {
        return reply.status(err.httpStatus).send({ error: err.toApiError() });
      }
      return reply.status(401).send({ error: new UnauthorizedError().toApiError() });
    }
  });

  // Returns a preHandler that checks a specific scope
  fastify.decorate(
    'requireScope',
    (scope: ApiKeyScope) => async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!request.apiKey) {
        return reply.status(401).send({ error: new UnauthorizedError().toApiError() });
      }
      try {
        authService.requireScope(request.apiKey, scope);
      } catch (err) {
        if (err instanceof FinLayerError) {
          return reply.status(err.httpStatus).send({ error: err.toApiError() });
        }
        throw err;
      }
    }
  );
}, { name: 'auth' });
