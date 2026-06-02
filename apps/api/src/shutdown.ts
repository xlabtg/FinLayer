/**
 * Graceful shutdown helpers (issue #16).
 *
 * Kept in a standalone module (free of the heavy app/route imports) so the
 * shutdown behaviour can be unit-tested without booting the whole server.
 */

import type { FastifyInstance } from 'fastify';

/** The subset of a Fastify instance the shutdown handler depends on. */
type Closable = Pick<FastifyInstance, 'close' | 'log'>;

/**
 * Build a graceful-shutdown handler bound to a *running* Fastify instance.
 *
 * Returns a signal handler that closes the given (already listening) `app`,
 * draining in-flight requests and releasing the DB pool, then exits. The
 * returned handler is idempotent: a second signal while shutdown is in
 * progress is ignored so we never call `app.close()` twice.
 *
 * `exit` is injectable so the behaviour can be unit-tested without killing the
 * test runner.
 */
export function createGracefulShutdown(
  app: Closable,
  exit: (code: number) => void = process.exit,
): (signal: NodeJS.Signals) => Promise<void> {
  let shuttingDown = false;

  return async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info(`Received ${signal}, closing server gracefully…`);
    try {
      await app.close();
      app.log.info('Server closed, in-flight requests drained');
      exit(0);
    } catch (err) {
      app.log.error(err, 'Error during graceful shutdown');
      exit(1);
    }
  };
}

/**
 * Register SIGTERM/SIGINT handlers that close the running `app`.
 *
 * A single shutdown handler is shared between both signals so the
 * "already shutting down" guard works across them.
 */
export function registerShutdownHandlers(
  app: Closable,
  exit: (code: number) => void = process.exit,
): void {
  const shutdown = createGracefulShutdown(app, exit);
  process.once('SIGTERM', (signal) => {
    void shutdown(signal);
  });
  process.once('SIGINT', (signal) => {
    void shutdown(signal);
  });
}
