/**
 * Fastify plugin: Global error handler.
 * Converts FinLayerError and Zod errors into agent-friendly JSON responses.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { FinLayerError } from '../../../../modules/shared/errors/index.js';

export default fp(async function errorHandlerPlugin(fastify: FastifyInstance) {
  fastify.setErrorHandler(async (error, request, reply) => {
    // FinLayer domain errors
    if (error instanceof FinLayerError) {
      return reply.status(error.httpStatus).send({ error: error.toApiError() });
    }

    // Fastify validation errors
    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          domain: 'general',
          retryable: false,
          details: { validation: error.validation },
        },
      });
    }

    // Rate limiting from @fastify/rate-limit
    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests',
          domain: 'general',
          retryable: true,
          retry_after_ms: 60000,
        },
      });
    }

    // Unknown errors — log but don't expose internals
    fastify.log.error({ err: error, request_id: request.id }, 'Unhandled error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        domain: 'general',
        retryable: false,
        suggestion: 'Check request and retry. If issue persists, contact support.',
      },
    });
  });

  fastify.setNotFoundHandler(async (request, reply) => {
    return reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
        domain: 'general',
        retryable: false,
        suggestion: 'Check the API documentation at /docs',
      },
    });
  });
}, { name: 'error-handler' });
