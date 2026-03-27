/**
 * PostgreSQL database client.
 * Uses the 'postgres' library (sql tagged template literals).
 */

import postgres from 'postgres';
import { logger } from '../../../modules/shared/utils/logger.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

export const sql = postgres(DATABASE_URL, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
  transform: {
    // Automatically parse JSONB columns
    column: { to: postgres.camel },
  },
  onnotice: (notice) => {
    logger.debug('PostgreSQL notice', { notice: notice.message });
  },
});

export async function checkDbConnection(): Promise<void> {
  await sql`SELECT 1`;
  logger.info('Database connection established');
}

export { postgres };
