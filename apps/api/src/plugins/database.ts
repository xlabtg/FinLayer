/**
 * Fastify plugin: PostgreSQL database connection.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../db/connection.js';

declare module 'fastify' {
  interface FastifyInstance {
    sql: DatabaseClient;
  }
}

export default fp(async function databasePlugin(fastify: FastifyInstance) {
  const sql = createDatabaseClient();

  fastify.decorate('sql', sql);

  fastify.addHook('onClose', async () => {
    await sql.end();
  });

  // Verify connection
  await sql`SELECT 1`;
  fastify.log.info('Database connected');
}, { name: 'database' });
