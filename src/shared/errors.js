export class QuestshopError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'QuestshopError';
    this.code = code;
    this.category = options.category ?? 'UNKNOWN';
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? null;
  }
}

export class StaleStateError extends QuestshopError {
  constructor(aggregate, id) {
    super('STALE_STATE', `${aggregate} ${id} changed concurrently`, {
      category: 'CONCURRENCY',
      retryable: true,
    });
  }
}

export class AuthorizationError extends QuestshopError {
  constructor(message = 'ไม่มีสิทธิ์ดำเนินการนี้') {
    super('NOT_AUTHORIZED', message, { category: 'AUTHORIZATION' });
  }
}

export class FencingLostError extends QuestshopError {
  constructor(resourceId) {
    super('FENCING_LOST', `Worker lost ownership of ${resourceId}`, {
      category: 'CONCURRENCY',
    });
  }
}

