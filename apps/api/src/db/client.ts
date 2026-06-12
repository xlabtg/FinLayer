/**
 * CLI PostgreSQL client for migration commands.
 *
 * The API server creates and closes its runtime pool in plugins/database.ts.
 * Both entry points share pool settings through db/connection.ts.
 */

import { createDatabaseClient } from './connection.js';
import { logger } from '../../../../modules/shared/utils/logger.js';

export const sql = createDatabaseClient({
  onnotice: (notice) => {
    logger.debug('PostgreSQL notice', { notice: notice.message });
  },
});

export async function checkDbConnection(): Promise<void> {
  await sql`SELECT 1`;
  logger.info('Database connection established');
}

export { postgres } from './connection.js';
