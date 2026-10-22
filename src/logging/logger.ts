import pino, { type Logger } from 'pino';

import type { AppConfig } from '../config/env.js';

export type AppLogger = Logger;

export function createLogger(config: Pick<AppConfig, 'environment' | 'logLevel'>): AppLogger {
  return pino({
    base: {
      environment: config.environment,
      service: 'stembot',
    },
    level: config.logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
