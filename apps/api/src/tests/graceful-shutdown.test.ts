/**
 * Tests for graceful shutdown (issue #16).
 *
 * Regression coverage: the previous SIGTERM handler built a *new* Fastify
 * instance and closed that, leaving the running server (and its DB pool /
 * in-flight requests) untouched. These tests assert that the shutdown handler
 * closes exactly the instance it was given, exactly once.
 */

import { describe, test, expect } from 'bun:test';
import { createGracefulShutdown } from '../shutdown.js';

// Minimal stand-in for the bits of a Fastify instance the handler touches.
function createFakeApp() {
  let closeCalls = 0;
  return {
    closeCount: () => closeCalls,
    close: async () => {
      closeCalls++;
    },
    log: {
      info: () => {},
      error: () => {},
    },
  };
}

describe('graceful shutdown (issue #16)', () => {
  test('closes the running instance it was given', async () => {
    const app = createFakeApp();
    const exitCodes: number[] = [];

    const shutdown = createGracefulShutdown(app as never, (code) => {
      exitCodes.push(code);
    });

    await shutdown('SIGTERM');

    expect(app.closeCount()).toBe(1);
    expect(exitCodes).toEqual([0]);
  });

  test('is idempotent: a second signal does not close twice', async () => {
    const app = createFakeApp();
    const exitCodes: number[] = [];

    const shutdown = createGracefulShutdown(app as never, (code) => {
      exitCodes.push(code);
    });

    await shutdown('SIGTERM');
    await shutdown('SIGINT');

    expect(app.closeCount()).toBe(1);
    expect(exitCodes).toEqual([0]);
  });

  test('exits with code 1 when close() fails', async () => {
    const exitCodes: number[] = [];
    const app = {
      close: async () => {
        throw new Error('pool drain failed');
      },
      log: { info: () => {}, error: () => {} },
    };

    const shutdown = createGracefulShutdown(app as never, (code) => {
      exitCodes.push(code);
    });

    await shutdown('SIGTERM');

    expect(exitCodes).toEqual([1]);
  });
});
