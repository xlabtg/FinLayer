/**
 * Regression tests for CSP scoping (issue #31).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import fp from 'fastify-plugin';
import type { AddressInfo } from 'node:net';

import { createMockSql } from './setup.js';

mock.module('../plugins/database.js', () => ({
  default: fp(async (fastify) => {
    fastify.decorate('sql', createMockSql());
  }, { name: 'database' }),
}));

const previousLogLevel = process.env['LOG_LEVEL'];
process.env['LOG_LEVEL'] = 'silent';
const { buildApp } = await import('../index.js');
if (previousLogLevel === undefined) {
  delete process.env['LOG_LEVEL'];
} else {
  process.env['LOG_LEVEL'] = previousLogLevel;
}

function expectHeaderString(value: string | null): string {
  expect(typeof value).toBe('string');
  return value as string;
}

async function listenOnRandomPort(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('CSP configuration (issue #31)', () => {
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

  test('keeps Helmet CSP enabled on application routes', async () => {
    const app = await buildApp();

    try {
      const baseUrl = await listenOnRandomPort(app);

      const response = await fetch(`${baseUrl}/health`);
      const csp = expectHeaderString(response.headers.get('content-security-policy'));

      expect(response.status).toBe(200);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("object-src 'none'");
    } finally {
      await app.close();
    }
  });

  test('serves Swagger UI with a docs-specific CSP', async () => {
    const app = await buildApp();

    try {
      const baseUrl = await listenOnRandomPort(app);

      const docsResponse = await fetch(`${baseUrl}/docs/static/index.html`);
      const appResponse = await fetch(`${baseUrl}/health`);

      const docsCsp = expectHeaderString(docsResponse.headers.get('content-security-policy'));
      const appCsp = expectHeaderString(appResponse.headers.get('content-security-policy'));

      expect(docsResponse.status).toBe(200);
      expect(await docsResponse.text()).toContain('swagger-ui-bundle.js');
      expect(docsCsp).not.toBe(appCsp);
      expect(docsCsp).toContain('validator.swagger.io');
    } finally {
      await app.close();
    }
  });
});
