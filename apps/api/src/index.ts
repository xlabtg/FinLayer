/**
 * FinLayer API Server
 * Entry point for the Fastify application.
 */

import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';

import databasePlugin from './plugins/database.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import authPlugin from '../../../modules/auth/plugin.js';
import payoutSchedulerPlugin from '../../../modules/affiliate/scheduler-plugin.js';
import metricsPlugin from '../../../modules/observability/metrics.js';
import sentryPlugin from '../../../modules/observability/sentry.js';
import { authRoutes } from '../../../modules/auth/routes.js';
import { swapRoutes } from '../../../modules/swap/routes.js';
import { earnRoutes } from '../../../modules/earn/routes.js';
import { affiliateRoutes } from '../../../modules/affiliate/routes.js';
import { paymentsRoutes } from '../../../modules/payments/routes.js';
import { analyticsRoutes } from '../../../modules/analytics/routes.js';
import { marketplaceRoutes } from '../../../modules/marketplace/routes.js';
import { walletRoutes } from '../../../modules/wallet/routes.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const HOST = process.env['HOST'] ?? '0.0.0.0';
const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info';
const API_VERSION = 'v1';

async function buildApp() {
  const app = Fastify({
    logger: {
      level: LOG_LEVEL,
      serializers: {
        // Never log Authorization header (contains API key)
        req(request) {
          return {
            method: request.method,
            url: request.url,
            hostname: request.hostname,
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort,
          };
        },
      },
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
  });

  // ─── Security ──────────────────────────────────────────────────────────────

  await app.register(helmet, {
    contentSecurityPolicy: false, // Disabled for Swagger UI
  });

  await app.register(cors, {
    origin: process.env['CORS_ORIGINS']?.split(',') ?? '*',
    credentials: true,
  });

  // ─── OpenAPI / Swagger ─────────────────────────────────────────────────────

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'FinLayer API',
        description: `
**FinLayer** — Multi-domain financial API platform for AI agents.

## Authentication
All endpoints require an API key in the \`Authorization\` header:
\`\`\`
Authorization: Bearer fl_live_<your-key>
\`\`\`

## Agent-Friendly Design
- All errors include \`code\`, \`domain\`, \`retryable\` fields
- State-changing operations require \`idempotency_key\`
- Async operations return \`202 Accepted\` + \`webhook_url\`

## Domains
- **swap**: Crypto exchange aggregation (ChangeNOW, DEX)
- **payments**: Fiat on/off-ramp, invoicing
- **earn**: Yield strategies (Aave, Compound)
- **wallet**: Non-custodial key management
- **affiliate**: Revenue sharing & tracking
        `.trim(),
        version: '0.1.0',
        contact: {
          name: 'FinLayer API',
          url: 'https://github.com/xlabtg/FinLayer',
        },
        license: {
          name: 'MIT',
          url: 'https://opensource.org/licenses/MIT',
        },
      },
      externalDocs: {
        description: 'GitHub Repository',
        url: 'https://github.com/xlabtg/FinLayer',
      },
      servers: [
        { url: `http://localhost:${PORT}`, description: 'Local development' },
        { url: 'https://api.finlayer.io', description: 'Production' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'API Key',
            description: 'FinLayer API key (fl_live_...)',
          },
        },
      },
      tags: [
        { name: 'Auth', description: 'API key management and authentication' },
        { name: 'Swap', description: 'Crypto exchange aggregation' },
        { name: 'Payments', description: 'Fiat on/off-ramp and invoicing (Phase 2)' },
        { name: 'Earn', description: 'Yield strategies and lending (Phase 3)' },
        { name: 'Wallet', description: 'Non-custodial wallet management (Phase 4)' },
        { name: 'Affiliate', description: 'Revenue sharing and affiliate tracking' },
        { name: 'Analytics', description: 'Cross-domain revenue dashboard (Phase 5)' },
        { name: 'Marketplace', description: 'Affiliate deep-link generator (Phase 5)' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'tag',
      deepLinking: true,
    },
    staticCSP: true,
  });

  // ─── Core Plugins ──────────────────────────────────────────────────────────

  await app.register(sentryPlugin);
  await app.register(metricsPlugin);
  await app.register(databasePlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  await app.register(payoutSchedulerPlugin);

  // Capture raw JSON body so payment webhook routes can verify provider
  // HMAC signatures against the exact bytes delivered.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body: string, done) => {
      (req as unknown as { rawBody: string }).rawBody = body;
      try {
        const json = body.length > 0 ? JSON.parse(body) : {};
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  // ─── Health Check ──────────────────────────────────────────────────────────

  app.get('/health', {
    schema: {
      tags: ['System'],
      summary: 'Health check',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            version: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  }, async () => ({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  }));

  // ─── API Routes ────────────────────────────────────────────────────────────

  app.register(async (v1) => {
    v1.register(authRoutes, { prefix: '/auth' });
    v1.register(swapRoutes, { prefix: '/swap' });
    v1.register(paymentsRoutes, { prefix: '/payments' });
    v1.register(earnRoutes, { prefix: '/earn' });
    v1.register(affiliateRoutes, { prefix: '/affiliate' });
    v1.register(analyticsRoutes, { prefix: '/analytics' });
    v1.register(marketplaceRoutes, { prefix: '/marketplace' });
    v1.register(walletRoutes, { prefix: '/wallet' });
  }, { prefix: `/${API_VERSION}` });

  // Affiliate redirect routes (outside /v1/ prefix)
  app.register(affiliateRoutes);

  return app;
}

async function start(): Promise<void> {
  const app = await buildApp();

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`FinLayer API running on http://${HOST}:${PORT}`);
    app.log.info(`Swagger docs: http://${HOST}:${PORT}/docs`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  const app = await buildApp();
  await app.close();
  process.exit(0);
});

start();

export { buildApp };
