/**
 * modules/observability/sentry.ts
 * Sentry error tracking (opt-in via SENTRY_DSN).
 *
 * No-op when SENTRY_DSN is unset — the plugin still registers cleanly so tests
 * and local development do not require external services.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import * as Sentry from '@sentry/node';
import { FinLayerError } from '../shared/errors/index.js';
import { logger } from '../shared/utils/logger.js';

export default fp(async function sentryPlugin(fastify: FastifyInstance) {
  const dsn = process.env['SENTRY_DSN'];
  if (!dsn) {
    logger.info('Sentry disabled (SENTRY_DSN not set)');
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env['NODE_ENV'] ?? 'development',
    release: process.env['FINLAYER_VERSION'] ?? '0.1.0',
    tracesSampleRate: parseFloat(process.env['SENTRY_TRACES_SAMPLE_RATE'] ?? '0.1'),
    // Never send Authorization headers or raw request bodies to Sentry
    beforeSend(event) {
      if (event.request?.headers) {
        delete (event.request.headers as Record<string, unknown>)['authorization'];
        delete (event.request.headers as Record<string, unknown>)['x-api-key'];
      }
      return event;
    },
  });

  logger.info('Sentry initialized', { environment: process.env['NODE_ENV'] });

  fastify.addHook('onRequest', async (request) => {
    Sentry.getCurrentScope().setTag('request_id', String(request.id));
  });

  fastify.addHook('onError', async (request, _reply, error) => {
    // Skip expected domain errors (they are not actionable in Sentry)
    if (error instanceof FinLayerError) return;

    Sentry.withScope((scope) => {
      scope.setTag('request_id', String(request.id));
      scope.setTag('method', request.method);
      scope.setTag('route', request.routeOptions?.url ?? request.url);
      if (request.userId) scope.setUser({ id: request.userId });
      Sentry.captureException(error);
    });
  });

  fastify.addHook('onClose', async () => {
    await Sentry.close(2000);
  });
}, { name: 'sentry' });
