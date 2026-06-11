/**
 * modules/shared/cache
 * Pluggable quote cache with TTL. Defaults to in-memory, with an optional
 * Redis backend activated via the REDIS_URL environment variable and the
 * `redis` package at runtime.
 *
 * Design notes:
 *  - All values are serialized to JSON. Callers stay decoupled from the
 *    underlying store.
 *  - TTLs are enforced by the store. The in-memory backend uses setTimeout
 *    to evict, matching Redis' EXPIRE semantics.
 *  - If `REDIS_URL` is set but the `redis` client fails to load (dev envs
 *    without a node_modules install), we fall back to in-memory and log a
 *    warning once.
 */

import { logger } from '../utils/logger.js';

export interface ICacheBackend {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  increment(key: string, ttlMs: number): Promise<CacheIncrementResult>;
  del(key: string): Promise<void>;
  /** Close underlying connections; a no-op for in-memory. */
  close(): Promise<void>;
}

export interface CacheIncrementResult {
  value: number;
  resetAt: number;
}

interface InMemoryEntry {
  value: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class InMemoryCache implements ICacheBackend {
  private readonly entries = new Map<string, InMemoryEntry>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.deleteEntry(key);
      return null;
    }
    return JSON.parse(entry.value) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.setEntry(key, JSON.stringify(value), ttlSeconds * 1000);
  }

  async increment(key: string, ttlMs: number): Promise<CacheIncrementResult> {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || now >= entry.expiresAt) {
      this.setEntry(key, JSON.stringify(1), ttlMs);
      return { value: 1, resetAt: now + ttlMs };
    }

    const current = JSON.parse(entry.value) as unknown;
    const value = (typeof current === 'number' && Number.isFinite(current) ? current : 0) + 1;
    entry.value = JSON.stringify(value);
    return { value, resetAt: entry.expiresAt };
  }

  async del(key: string): Promise<void> {
    this.deleteEntry(key);
  }

  async close(): Promise<void> {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
    }
    this.entries.clear();
  }

  /** Test helper. */
  size(): number {
    return this.entries.size;
  }

  private setEntry(key: string, value: string, ttlMs: number): void {
    const existing = this.entries.get(key);
    if (existing) clearTimeout(existing.timer);

    const expiresAt = Date.now() + ttlMs;
    const timer = setTimeout(() => this.entries.delete(key), ttlMs);
    // Allow Bun/Node to exit even when idle timers are pending.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }

    this.entries.set(key, { value, expiresAt, timer });
  }

  private deleteEntry(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      this.entries.delete(key);
    }
  }
}

/**
 * Minimal Redis-like interface for the `redis` package and test stubs,
 * without importing the concrete client type into the build.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<unknown>;
  pTTL?: (key: string) => Promise<number>;
  pttl?: (key: string) => Promise<number>;
  pExpire?: (key: string, ttlMs: number) => Promise<unknown>;
  pexpire?: (key: string, ttlMs: number) => Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

interface RedisSetOptions {
  EX?: number;
  PX?: number;
  expiration?: { type: 'EX' | 'PX'; value: number };
}

export class RedisCache implements ICacheBackend {
  constructor(private readonly client: RedisLikeClient) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), { PX: Math.ceil(ttlSeconds * 1000) });
  }

  async increment(key: string, ttlMs: number): Promise<CacheIncrementResult> {
    const value = await this.client.incr(key);
    if (value === 1) {
      await this.expireMs(key, ttlMs);
    }

    let ttl = await this.ttlMs(key);
    if (ttl < 0) {
      await this.expireMs(key, ttlMs);
      ttl = ttlMs;
    }

    return { value, resetAt: Date.now() + ttl };
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // Ignore errors on shutdown.
    }
  }

  private async ttlMs(key: string): Promise<number> {
    const pttl = this.client.pTTL ?? this.client.pttl;
    if (pttl) return pttl.call(this.client, key);
    return -1;
  }

  private async expireMs(key: string, ttlMs: number): Promise<void> {
    const pexpire = this.client.pExpire ?? this.client.pexpire;
    if (pexpire) {
      await pexpire.call(this.client, key, ttlMs);
      return;
    }
    await this.client.expire(key, Math.ceil(ttlMs / 1000));
  }
}

let warnedMissingRedis = false;

/**
 * Build a cache backend from the environment.
 *
 *   REDIS_URL unset    → InMemoryCache
 *   REDIS_URL set      → RedisCache when `redis` package is installed, else InMemoryCache
 *
 * We accept an explicit `client` to simplify testing — pass a stubbed
 * `RedisLikeClient` to exercise the Redis branch deterministically.
 */
export async function buildCacheFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  explicitClient?: RedisLikeClient
): Promise<ICacheBackend> {
  const url = env['REDIS_URL'];
  if (!url) return new InMemoryCache();

  if (explicitClient) return new RedisCache(explicitClient);

  try {
    // Lazy import — avoids a hard dependency for dev environments.
    const mod = (await import('redis').catch(() => null)) as
      | { createClient?: (opts: { url: string }) => RedisLikeClient & { connect: () => Promise<void> } }
      | null;
    if (mod?.createClient) {
      const client = mod.createClient({ url });
      await client.connect();
      logger.info('Redis cache connected', { url: safeUrl(url) });
      return new RedisCache(client);
    }
  } catch (err) {
    if (!warnedMissingRedis) {
      logger.warn('Redis client unavailable — falling back to in-memory cache', {
        error: String(err),
      });
      warnedMissingRedis = true;
    }
  }

  return new InMemoryCache();
}

function safeUrl(url: string): string {
  return url.replace(/:\/\/([^@]+)@/, '://***@');
}

/**
 * Build a deterministic cache key for a swap quote request. The key
 * intentionally omits user identity — quotes are user-agnostic and can be
 * safely reused across callers as long as the parameters match exactly.
 */
export function swapQuoteCacheKey(params: {
  fromAsset: string;
  toAsset: string;
  amount: string;
  fromNetwork?: string;
  toNetwork?: string;
}): string {
  const parts = [
    'swap-quote',
    params.fromAsset.toUpperCase(),
    params.toAsset.toUpperCase(),
    params.amount,
    params.fromNetwork ?? '',
    params.toNetwork ?? '',
  ];
  return parts.join(':');
}
