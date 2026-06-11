/**
 * modules/auth/service.ts
 * API key creation, validation, and scope checking.
 *
 * Security principles:
 * - API keys are NEVER stored in plain text — only bcrypt hash + prefix
 * - Keys are NEVER logged (only prefix is logged for debugging)
 * - Rate limiting enforced per key
 */

import bcrypt from 'bcryptjs';
import type { SQL } from 'postgres';
import { generateUUID, generateApiKey, parseApiKey, nowISO, futureISO } from '@finlayer/utils';
import type {
  ApiKey,
  ApiKeyScope,
  ApiKeyCreateRequest,
  ApiKeyCreateResponse,
  UUID,
} from '@finlayer/types';
import { UnauthorizedError, ForbiddenError, RateLimitError } from '../shared/errors/index.js';
import { logger } from '../shared/utils/logger.js';
import { InMemoryCache, type ICacheBackend } from '../shared/cache/index.js';

const BCRYPT_ROUNDS = 10;
const KEY_PREFIX_LIVE = 'fl_live';
const KEY_PREFIX_TEST = 'fl_test';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_KEY_PREFIX = 'auth:rate-limit';

interface DbApiKey {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  key_id: string;
  scopes: string[];
  rate_limit: number;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

export interface AuthServiceOptions {
  rateLimitCache?: ICacheBackend;
  rateLimitWindowMs?: number;
}

export class AuthService {
  private readonly rateLimitCache: ICacheBackend;
  private readonly rateLimitWindowMs: number;

  constructor(
    private readonly sql: SQL,
    options: AuthServiceOptions = {}
  ) {
    this.rateLimitCache = options.rateLimitCache ?? new InMemoryCache();
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS;
  }

  /**
   * Create a new API key. Returns the plain key once — never retrievable again.
   */
  async createApiKey(
    userId: UUID,
    request: ApiKeyCreateRequest,
    isTestMode = false
  ): Promise<ApiKeyCreateResponse> {
    const prefix = isTestMode ? KEY_PREFIX_TEST : KEY_PREFIX_LIVE;
    const { key, keyId } = generateApiKey(prefix);

    const keyHash = await bcrypt.hash(key, BCRYPT_ROUNDS);

    const [row] = await this.sql<DbApiKey[]>`
      INSERT INTO api_keys (user_id, name, key_hash, key_prefix, key_id, scopes, rate_limit, expires_at)
      VALUES (
        ${userId},
        ${request.name},
        ${keyHash},
        ${prefix},
        ${keyId},
        ${request.scopes as string[]},
        ${request.rate_limit ?? 60},
        ${request.expires_at ?? null}
      )
      RETURNING *
    `;

    if (!row) throw new Error('Failed to create API key');

    logger.info('API key created', { userId, name: request.name, prefix, scopes: request.scopes });

    return {
      api_key: this.mapDbApiKey(row),
      secret: key,
    };
  }

  /**
   * Validate an API key from Authorization header.
   * Throws UnauthorizedError if invalid.
   * Throws RateLimitError if rate limit exceeded.
   */
  async validateApiKey(rawKey: string): Promise<ApiKey> {
    if (!rawKey || typeof rawKey !== 'string') {
      throw new UnauthorizedError();
    }

    // Extract the unique keyId embedded in the key (e.g. "fl_live_<keyId>_<secret>").
    const parsed = parseApiKey(rawKey);
    if (!parsed) {
      throw new UnauthorizedError();
    }

    // Look up the single key by its unique, indexed keyId — no LIMIT heuristic,
    // no candidate scan. At most one row matches, regardless of key count.
    const [matchedRow] = await this.sql<DbApiKey[]>`
      SELECT * FROM api_keys
      WHERE key_id = ${parsed.keyId}
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `;

    if (!matchedRow) {
      throw new UnauthorizedError();
    }

    // Exactly one bcrypt.compare per request — constant cost, no CPU-DoS amplification.
    const matches = await bcrypt.compare(rawKey, matchedRow.key_hash);
    if (!matches) {
      throw new UnauthorizedError();
    }

    // Check rate limit
    await this.checkRateLimit(matchedRow.id, matchedRow.rate_limit);

    // Update last_used_at asynchronously (fire and forget)
    void this.sql`
      UPDATE api_keys SET last_used_at = NOW() WHERE id = ${matchedRow.id}
    `;

    return this.mapDbApiKey(matchedRow);
  }

  /**
   * Verify that an API key has a required scope.
   */
  requireScope(apiKey: ApiKey, scope: ApiKeyScope): void {
    if (!apiKey.scopes.includes(scope) && !apiKey.scopes.includes('admin')) {
      throw new ForbiddenError(scope);
    }
  }

  /**
   * Get API key info by ID.
   */
  async getApiKey(keyId: UUID): Promise<ApiKey | null> {
    const [row] = await this.sql<DbApiKey[]>`
      SELECT * FROM api_keys WHERE id = ${keyId} AND revoked_at IS NULL
    `;
    return row ? this.mapDbApiKey(row) : null;
  }

  /**
   * Revoke an API key.
   */
  async revokeApiKey(keyId: UUID, userId: UUID): Promise<void> {
    await this.sql`
      UPDATE api_keys
      SET revoked_at = NOW()
      WHERE id = ${keyId} AND user_id = ${userId}
    `;
    // Clear rate limit cache
    await this.rateLimitCache.del(this.rateLimitKey(keyId));
    logger.info('API key revoked', { keyId, userId });
  }

  private async checkRateLimit(keyId: string, limitPerMinute: number): Promise<void> {
    const result = await this.rateLimitCache.increment(
      this.rateLimitKey(keyId),
      this.rateLimitWindowMs
    );

    if (result.value > limitPerMinute) {
      const retryAfterMs = Math.max(0, result.resetAt - Date.now());
      throw new RateLimitError(retryAfterMs);
    }
  }

  private rateLimitKey(keyId: string): string {
    return `${RATE_LIMIT_KEY_PREFIX}:${keyId}`;
  }

  private mapDbApiKey(row: DbApiKey): ApiKey {
    return {
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      key_prefix: row.key_prefix,
      scopes: row.scopes as ApiKeyScope[],
      rate_limit: row.rate_limit,
      created_at: row.created_at.toISOString(),
      last_used_at: row.last_used_at?.toISOString() ?? null,
      expires_at: row.expires_at?.toISOString() ?? null,
    };
  }
}
