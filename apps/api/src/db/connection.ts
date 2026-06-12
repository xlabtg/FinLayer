/**
 * Shared PostgreSQL connection factory.
 *
 * Runtime code owns the pool lifecycle at the call site: the Fastify plugin
 * closes its pool on server shutdown, while CLI commands let the process exit
 * after their one-shot work completes.
 */

import postgres from 'postgres';

export type DatabaseClient = ReturnType<typeof postgres>;

export interface CreateDatabaseClientOptions {
  databaseUrl?: string;
  onnotice?: (notice: postgres.Notice) => void;
}

export const DATABASE_POOL_OPTIONS = {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
} as const;

export function getDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return databaseUrl;
}

export function createDatabaseClient(
  options: CreateDatabaseClientOptions = {}
): DatabaseClient {
  const databaseUrl = options.databaseUrl ?? getDatabaseUrl();
  const noticeOptions = options.onnotice
    ? { onnotice: options.onnotice }
    : {};

  return postgres(databaseUrl, {
    ...DATABASE_POOL_OPTIONS,
    ...noticeOptions,
  });
}

export { postgres };
