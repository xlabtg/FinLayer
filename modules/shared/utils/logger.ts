/**
 * Structured JSON logger (Pino-compatible interface).
 * In production, replace with actual pino instance.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  msg: string;
  time: string;
  [key: string]: unknown;
}

function formatLog(level: LogLevel, msg: string, data?: Record<string, unknown>): LogEntry {
  return {
    level,
    msg,
    time: new Date().toISOString(),
    ...(data ?? {}),
  };
}

export const logger = {
  debug(msg: string, data?: Record<string, unknown>): void {
    if (process.env['LOG_LEVEL'] === 'debug') {
      console.debug(JSON.stringify(formatLog('debug', msg, data)));
    }
  },
  info(msg: string, data?: Record<string, unknown>): void {
    console.info(JSON.stringify(formatLog('info', msg, data)));
  },
  warn(msg: string, data?: Record<string, unknown>): void {
    console.warn(JSON.stringify(formatLog('warn', msg, data)));
  },
  error(msg: string, data?: Record<string, unknown>): void {
    console.error(JSON.stringify(formatLog('error', msg, data)));
  },
  child(bindings: Record<string, unknown>) {
    return {
      debug: (msg: string, data?: Record<string, unknown>) => logger.debug(msg, { ...bindings, ...data }),
      info: (msg: string, data?: Record<string, unknown>) => logger.info(msg, { ...bindings, ...data }),
      warn: (msg: string, data?: Record<string, unknown>) => logger.warn(msg, { ...bindings, ...data }),
      error: (msg: string, data?: Record<string, unknown>) => logger.error(msg, { ...bindings, ...data }),
    };
  },
};
