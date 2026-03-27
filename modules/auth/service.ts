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
import { generateUUID, generateApiKey, nowISO, futureISO } from '@finlayer/utils';
import type {
  ApiKey,
  ApiKeyScope,
  ApiKeyCreateRequest,
  ApiKeyCreateResponse,
  UUID,
} from '@finlayer/types';
import { UnauthorizedError, ForbiddenError, RateLimitError } from '../shared/errors/index.js';
import { logger } from '../shared/utils/logger.js';

const BCRYPT_ROUNDS = 10;
const KEY_PREFIX_LIVE = 'fl_live';
const KEY_PREFIX_TEST = 'fl_test';

interface DbApiKey {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: string[];
  rate_limit: number;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

// In-memory rate limit store (replace with Redis in production)
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

export class AuthService {
  constructor(private readonly sql: SQL) {}

  /**
   * Create a new API key. Returns the plain key once — never retrievable again.
   */
  async createApiKey(
    userId: UUID,
    request: ApiKeyCreateRequest,
    isTestMode = false
  ): Promise<ApiKeyCreateResponse> {
    const prefix = isTestMode ? KEY_PREFIX_TEST : KEY_PREFIX_LIVE;
    const { key } = generateApiKey(prefix);

    const keyHash = await bcrypt.hash(key, BCRYPT_ROUNDS);

    const [row] = await this.sql<DbApiKey[]>`
      INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, rate_limit, expires_at)
      VALUES (
        ${userId},
        ${request.name},
        ${keyHash},
        ${prefix},
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

    // Extract prefix from key (e.g., "fl_live_abc123" → "fl_live")
    const parts = rawKey.split('_');
    if (parts.length < 3) {
      throw new UnauthorizedError();
    }
    const prefix = `${parts[0]}_${parts[1]}`;

    // Find candidates by prefix (avoids full table scan)
    const rows = await this.sql<DbApiKey[]>`
      SELECT * FROM api_keys
      WHERE key_prefix = ${prefix}
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 20
    `;

    if (rows.length === 0) {
      throw new UnauthorizedError();
    }

    // bcrypt compare against each candidate (at most 20)
    let matchedRow: DbApiKey | null = null;
    for (const row of rows) {
      const matches = await bcrypt.compare(rawKey, row.key_hash);
      if (matches) {
        matchedRow = row;
        break;
      }
    }

    if (!matchedRow) {
      throw new UnauthorizedError();
    }

    // Check rate limit
    this.checkRateLimit(matchedRow.id, matchedRow.rate_limit);

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
    rateLimitStore.delete(keyId);
    logger.info('API key revoked', { keyId, userId });
  }

  private checkRateLimit(keyId: string, limitPerMinute: number): void {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const entry = rateLimitStore.get(keyId);

    if (!entry || now > entry.resetAt) {
      rateLimitStore.set(keyId, { count: 1, resetAt: now + windowMs });
      return;
    }

    if (entry.count >= limitPerMinute) {
      const retryAfterMs = entry.resetAt - now;
      throw new RateLimitError(retryAfterMs);
    }

    entry.count++;
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
