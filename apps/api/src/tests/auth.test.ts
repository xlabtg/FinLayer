/**
 * Tests for API key authentication.
 *
 * Regression coverage:
 *  1. Authentication is deterministic with >20 active keys sharing the same
 *     prefix (the old `LIMIT 20` prefix scan could miss a valid key).
 *  2. Each validation performs at most ONE bcrypt.compare, regardless of how
 *     many keys share the prefix (the old code did up to 20 → CPU-DoS vector).
 *  3. The background `last_used_at` update handles write failures locally
 *     instead of surfacing an unhandled rejection (issue #37).
 *
 * `bcryptjs` is mocked so we can (a) count compare calls deterministically and
 * (b) keep the suite fast and independent of the native hashing cost.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';

// ─── bcryptjs mock (counts compare calls) ──────────────────────────────────────
let compareCalls = 0;
const bcryptMock = {
  hash: (key: string, _rounds: number): Promise<string> => Promise.resolve(`hashed:${key}`),
  compare: (key: string, hash: string): Promise<boolean> => {
    compareCalls++;
    return Promise.resolve(hash === `hashed:${key}`);
  },
};
mock.module('bcryptjs', () => ({ default: bcryptMock, ...bcryptMock }));

// Import the service AFTER registering the module mock.
const { AuthService } = await import('../../../../modules/auth/service.js');
const { InMemoryCache } = await import('../../../../modules/shared/cache/index.js');
const { parseApiKey } = await import('@finlayer/utils');
const { UnauthorizedError, RateLimitError } = await import('../../../../modules/shared/errors/index.js');
const { createMockSql, createTestUserId } = await import('./setup.js');

describe('AuthService — API key validation', () => {
  let service: InstanceType<typeof AuthService>;
  let mockSql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    mockSql = createMockSql();
    service = new AuthService(mockSql as never);
    compareCalls = 0;
  });

  async function seedKeys(userId: string, count: number): Promise<string[]> {
    const secrets: string[] = [];
    for (let i = 0; i < count; i++) {
      const { secret } = await service.createApiKey(userId, {
        name: `key-${i}`,
        scopes: ['swap:read'],
      });
      secrets.push(secret);
    }
    return secrets;
  }

  function failLastUsedAtUpdate(
    sql: ReturnType<typeof createMockSql>,
    error: Error
  ): ReturnType<typeof createMockSql> {
    return new Proxy(
      function (strings: TemplateStringsArray, ...values: unknown[]) {
        const query = strings.join('?').trim().toUpperCase();
        if (query.startsWith('UPDATE API_KEYS') && query.includes('LAST_USED_AT')) {
          return Promise.reject(error);
        }
        return sql(strings, ...values);
      },
      {
        get(_target, prop) {
          return sql[prop as keyof typeof sql];
        },
      }
    ) as ReturnType<typeof createMockSql>;
  }

  test('authentication is deterministic with >20 active live keys', async () => {
    const userId = createTestUserId();
    const secrets = await seedKeys(userId, 25);

    expect(mockSql._tables.get('api_keys')!.length).toBe(25);

    // Every single key must validate — including those beyond the old LIMIT 20.
    for (const secret of secrets) {
      const apiKey = await service.validateApiKey(secret);
      expect(apiKey.user_id).toBe(userId);
    }
  });

  test('each validation performs exactly one bcrypt.compare', async () => {
    const userId = createTestUserId();
    const secrets = await seedKeys(userId, 25);

    // Validate the LAST created key (worst case for a prefix scan).
    compareCalls = 0;
    const apiKey = await service.validateApiKey(secrets[secrets.length - 1]!);
    expect(apiKey.user_id).toBe(userId);
    expect(compareCalls).toBe(1);
  });

  test('unknown keyId costs zero bcrypt.compare (no CPU-DoS amplification)', async () => {
    const userId = createTestUserId();
    await seedKeys(userId, 25);

    compareCalls = 0;
    // A garbage key with a well-formed shape but a non-existent keyId.
    await expect(
      service.validateApiKey('fl_live_deadbeefdeadbeefdeadbeefdeadbeef_garbage')
    ).rejects.toBeInstanceOf(UnauthorizedError);
    // No candidate row → bcrypt is never invoked.
    expect(compareCalls).toBe(0);
  });

  test('a wrong secret with a valid keyId fails with a single compare', async () => {
    const userId = createTestUserId();
    const { secret } = await service.createApiKey(userId, {
      name: 'victim',
      scopes: ['swap:read'],
    });
    const parsed = parseApiKey(secret)!;
    const forged = `${parsed.prefix}_${parsed.keyId}_wrongsecret`;

    compareCalls = 0;
    await expect(service.validateApiKey(forged)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(compareCalls).toBe(1);
  });

  test('malformed keys are rejected without touching the DB', async () => {
    compareCalls = 0;
    await expect(service.validateApiKey('')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(service.validateApiKey('fl_live')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(service.validateApiKey('fl_live_onlykeyid')).rejects.toBeInstanceOf(
      UnauthorizedError
    );
    expect(compareCalls).toBe(0);
  });

  test('generated keys embed a unique keyId', async () => {
    const userId = createTestUserId();
    const a = await service.createApiKey(userId, { name: 'a', scopes: ['swap:read'] });
    const b = await service.createApiKey(userId, { name: 'b', scopes: ['swap:read'] });
    const pa = parseApiKey(a.secret)!;
    const pb = parseApiKey(b.secret)!;
    expect(pa.keyId).not.toBe(pb.keyId);
    expect(pa.prefix).toBe('fl_live');
  });

  test('rate limit is enforced across service instances sharing a cache', async () => {
    const cache = new InMemoryCache();
    const firstService = new AuthService(mockSql as never, {
      rateLimitCache: cache,
      rateLimitWindowMs: 60_000,
    });
    const secondService = new AuthService(mockSql as never, {
      rateLimitCache: cache,
      rateLimitWindowMs: 60_000,
    });

    const userId = createTestUserId();
    const { secret } = await firstService.createApiKey(userId, {
      name: 'shared-limit',
      scopes: ['swap:read'],
      rate_limit: 1,
    });

    await firstService.validateApiKey(secret);
    expect(cache.size()).toBe(1);
    await expect(secondService.validateApiKey(secret)).rejects.toBeInstanceOf(RateLimitError);

    await cache.close();
  });

  test('in-memory rate limit counters expire after the window', async () => {
    const cache = new InMemoryCache();
    service = new AuthService(mockSql as never, {
      rateLimitCache: cache,
      rateLimitWindowMs: 20,
    });
    const userId = createTestUserId();
    const secrets = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        service.createApiKey(userId, {
          name: `ttl-${i}`,
          scopes: ['swap:read'],
        })
      )
    );

    for (const { secret } of secrets) {
      await service.validateApiKey(secret);
    }

    expect(cache.size()).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cache.size()).toBe(0);

    await cache.close();
  });

  test('last_used_at update failures do not become unhandled rejections', async () => {
    const userId = createTestUserId();
    const updateError = new Error('last_used_at update failed');
    const sql = failLastUsedAtUpdate(mockSql, updateError);
    service = new AuthService(sql as never);
    const { secret } = await service.createApiKey(userId, {
      name: 'background-last-used',
      scopes: ['swap:read'],
    });
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };

    process.on('unhandledRejection', onUnhandledRejection);
    try {
      await expect(service.validateApiKey(secret)).resolves.toMatchObject({ user_id: userId });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
