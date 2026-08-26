import pino from 'pino';
import { redact } from '../shared/redaction.js';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['*.token', '*.password', '*.secret', '*.authorization', '*.cookie'],
    censor: '[REDACTED]',
  },
});

export function installBootstrapErrorHandlers(onFatal) {
  const handle = (kind) => (error) => {
    logger.fatal({ kind, error: redact(error) }, 'fatal process error');
    void onFatal(error, kind);
  };
  const uncaught = handle('uncaughtException');
  const rejection = handle('unhandledRejection');
  process.on('uncaughtException', uncaught);
  process.on('unhandledRejection', rejection);
  return () => {
    process.off('uncaughtException', uncaught);
    process.off('unhandledRejection', rejection);
  };
}
