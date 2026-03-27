/**
 * Database migration runner.
 * Runs all SQL migration files in order.
 */

import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { sql } from './client.js';
import { logger } from '../../../modules/shared/utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         SERIAL PRIMARY KEY,
      filename   VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const rows = await sql<{ filename: string }[]>`
    SELECT filename FROM schema_migrations ORDER BY id
  `;
  return new Set(rows.map(r => r.filename));
}

async function runMigrations(): Promise<void> {
  logger.info('Starting database migrations');

  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter(f => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      logger.debug(`Skipping already-applied migration: ${file}`);
      continue;
    }

    const sqlContent = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    logger.info(`Applying migration: ${file}`);

    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(sqlContent);
        await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`;
      });
      count++;
      logger.info(`Migration applied: ${file}`);
    } catch (err) {
      logger.error(`Migration failed: ${file}`, { error: String(err) });
      throw err;
    }
  }

  logger.info(`Migrations complete. Applied ${count} new migration(s).`);
}

// Run if called directly
runMigrations()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('Migration runner failed', { error: String(err) });
    process.exit(1);
  });
