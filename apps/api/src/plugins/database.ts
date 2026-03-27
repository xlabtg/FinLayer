/**
 * Fastify plugin: PostgreSQL database connection.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';

declare module 'fastify' {
  interface FastifyInstance {
    sql: ReturnType<typeof postgres>;
  }
}

export default fp(async function databasePlugin(fastify: FastifyInstance) {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const sql = postgres(DATABASE_URL, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  fastify.decorate('sql', sql);

  fastify.addHook('onClose', async () => {
    await sql.end();
  });

  // Verify connection
  await sql`SELECT 1`;
  fastify.log.info('Database connected');
}, { name: 'database' });
