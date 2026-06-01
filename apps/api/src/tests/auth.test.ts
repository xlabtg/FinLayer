/**
 * Tests for API key authentication (issue #14).
 *
 * Regression coverage:
 *  1. Authentication is deterministic with >20 active keys sharing the same
 *     prefix (the old `LIMIT 20` prefix scan could miss a valid key).
 *  2. Each validation performs at most ONE bcrypt.compare, regardless of how
 *     many keys share the prefix (the old code did up to 20 → CPU-DoS vector).
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
const { parseApiKey } = await import('@finlayer/utils');
const { UnauthorizedError } = await import('../../../../modules/shared/errors/index.js');
const { createMockSql, createTestUserId } = await import('./setup.js');

describe('AuthService — API key validation (issue #14)', () => {
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
});
