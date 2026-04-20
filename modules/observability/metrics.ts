/**
 * modules/observability/metrics.ts
 * Prometheus metrics registry + Fastify plugin.
 *
 * Exposes:
 *  - GET /metrics  — scrape endpoint (Prometheus text format)
 *
 * Instrumentation:
 *  - http_requests_total{method,route,status}
 *  - http_request_duration_seconds{method,route,status}
 *  - finlayer_domain_events_total{domain,type} — incremented from services
 *  - Default Node process metrics (CPU, memory, event loop lag)
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

export interface FinLayerMetrics {
  registry: Registry;
  httpRequestsTotal: Counter<'method' | 'route' | 'status'>;
  httpRequestDurationSeconds: Histogram<'method' | 'route' | 'status'>;
  domainEventsTotal: Counter<'domain' | 'type'>;
}

declare module 'fastify' {
  interface FastifyInstance {
    metrics: FinLayerMetrics;
  }
  interface FastifyRequest {
    _metricsStart?: bigint;
  }
}

function buildMetrics(): FinLayerMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ app: 'finlayer-api' });
  collectDefaultMetrics({ register: registry });

  const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Count of HTTP requests processed by the API',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });

  const httpRequestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    // Buckets tuned for a public JSON API. Adjust once real latency is known.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const domainEventsTotal = new Counter({
    name: 'finlayer_domain_events_total',
    help: 'Count of domain-specific events (swap executed, wallet generated, etc.)',
    labelNames: ['domain', 'type'] as const,
    registers: [registry],
  });

  return { registry, httpRequestsTotal, httpRequestDurationSeconds, domainEventsTotal };
}

/** Stable route label — uses the matched route pattern, not the concrete path. */
function routeLabel(request: FastifyRequest): string {
  const url = request.routeOptions?.url ?? request.routerPath ?? request.url;
  return url ?? 'unknown';
}

export default fp(async function metricsPlugin(fastify: FastifyInstance) {
  const metrics = buildMetrics();
  fastify.decorate('metrics', metrics);

  fastify.addHook('onRequest', async (request) => {
    request._metricsStart = process.hrtime.bigint();
  });

  fastify.addHook('onResponse', async (request, reply) => {
    // /metrics itself should not be recorded, avoids polluting its own output
    const route = routeLabel(request);
    if (route === '/metrics') return;

    const status = String(reply.statusCode);
    const method = request.method;

    metrics.httpRequestsTotal.inc({ method, route, status });
    if (request._metricsStart) {
      const durationSeconds = Number(process.hrtime.bigint() - request._metricsStart) / 1e9;
      metrics.httpRequestDurationSeconds.observe({ method, route, status }, durationSeconds);
    }
  });

  fastify.get('/metrics', {
    schema: {
      tags: ['System'],
      summary: 'Prometheus metrics endpoint',
      description: 'Returns metrics in Prometheus text exposition format.',
      response: {
        200: {
          type: 'string',
          description: 'Prometheus-formatted metrics',
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });
}, { name: 'metrics' });
