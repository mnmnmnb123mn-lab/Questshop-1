import pino from 'pino';
import { redact, redactText } from './redaction.js';

function safeMessage(message) {
  return typeof message === 'string' ? redactText(message) : message;
}

function safeFields(object) {
  return redact(object ?? {});
}

export function createLogger(bindings = {}, destination = null) {
  const options = {
    level: process.env.LOG_LEVEL ?? 'info',
    base: redact({ service: 'questshop', ...bindings }),
    redact: {
      paths: ['*.token', '*.authorization', '*.cookie', '*.password', '*.secret', '*.ciphertext'],
      censor: '[REDACTED]',
    },
  };
  const base = destination == null ? pino(options) : pino(options, destination);
  return Object.freeze({
    debug: (object, message) => base.debug(safeFields(object), safeMessage(message)),
    info: (object, message) => base.info(safeFields(object), safeMessage(message)),
    warn: (object, message) => base.warn(safeFields(object), safeMessage(message)),
    error: (object, message) => base.error(safeFields(object), safeMessage(message)),
    child: (child) => createLogger({ ...bindings, ...child }, destination),
  });
}
