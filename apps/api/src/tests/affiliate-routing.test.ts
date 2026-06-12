/**
 * Regression tests for affiliate route registration (issue #26).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import fp from 'fastify-plugin';

import { createMockSql } from './setup.js';

mock.module('../plugins/database.js', () => ({
  default: fp(async (fastify) => {
    fastify.decorate('sql', createMockSql());
  }, { name: 'database' }),
}));

const { buildApp } = await import('../index.js');

describe('Affiliate route registration (issue #26)', () => {
  let previousCorsOrigins: string | undefined;

  beforeEach(() => {
    previousCorsOrigins = process.env['CORS_ORIGINS'];

    process.env['CORS_ORIGINS'] = 'https://app.finlayer.io';
  });

  afterEach(() => {
    if (previousCorsOrigins === undefined) {
      delete process.env['CORS_ORIGINS'];
    } else {
      process.env['CORS_ORIGINS'] = previousCorsOrigins;
    }
  });

  test('exposes only the public redirect route at the root', async () => {
    const app = await buildApp();

    try {
      await app.ready();

      expect(app.hasRoute({ method: 'GET', url: '/r/:code' })).toBe(true);

      const rootApiRoutes = [
        { method: 'POST', url: '/link' },
        { method: 'GET', url: '/stats' },
        { method: 'GET', url: '/payouts' },
        { method: 'POST', url: '/payouts/run' },
      ] as const;

      for (const route of rootApiRoutes) {
        expect(app.hasRoute(route)).toBe(false);
      }

      expect(app.hasRoute({ method: 'POST', url: '/v1/affiliate/link' })).toBe(true);
      expect(app.hasRoute({ method: 'GET', url: '/v1/affiliate/stats' })).toBe(true);
      expect(app.hasRoute({ method: 'GET', url: '/v1/affiliate/payouts' })).toBe(true);
      expect(app.hasRoute({ method: 'POST', url: '/v1/affiliate/payouts/run' })).toBe(true);
      expect(app.hasRoute({ method: 'GET', url: '/v1/affiliate/r/:code' })).toBe(false);
    } finally {
      await app.close();
    }
  });
});
