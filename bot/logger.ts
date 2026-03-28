/**
 * logger.ts
 *
 * Shared pino logger for all bot modules.
 * JSON structured logging with log levels.
 *
 * Usage:
 *   import { logger } from './logger';
 *   logger.info({ pool, binId }, 'Harvest triggered');
 *   logger.error({ err }, 'Transaction failed');
 */

import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino/file', options: { destination: 1 } } // stdout
    : undefined,
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  base: { service: 'crank-bot' },
});
