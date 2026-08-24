import { createHash } from 'node:crypto';

function text(value) {
  if (value == null || value === '') return null;
  return String(value);
}

function decimal(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric.toFixed(3);
}

// Only fields that change the request/verification contract belong here.
// Presentation metadata (name, artwork, reward amount) deliberately does not
// invalidate a passed Monitor test or a customer quote.
export function canonicalQuestContract(quest, versions = {}) {
  return Object.freeze({
    applicationId: text(quest?.applicationId),
    contractVersion: text(versions.contractVersion ?? quest?.contractVersion),
    engineVersion: text(versions.engineVersion ?? quest?.engineVersion),
    eventName: text(quest?.eventName),
    executorId: text(quest?.executorId),
    executorVersion: text(versions.executorVersion ?? quest?.executorVersion),
    joinOperator: text(quest?.joinOperator ?? 'or'),
    progressKey: text(quest?.progressKey),
    questId: text(quest?.id ?? quest?.questId),
    target: decimal(quest?.secondsNeeded ?? quest?.taskTarget),
    verificationVersion: text(versions.verificationVersion ?? quest?.verificationVersion ?? '1'),
  });
}

export function questContractHash(quest, versions = {}) {
  const canonical = canonicalQuestContract(quest, versions);
  const complete = Boolean(canonical.questId && canonical.eventName && canonical.progressKey
    && canonical.target && canonical.executorId && canonical.engineVersion
    && canonical.executorVersion && canonical.contractVersion && canonical.verificationVersion);
  const serialized = JSON.stringify(canonical);
  return Object.freeze({
    canonical,
    complete,
    hash: complete ? createHash('sha256').update(serialized).digest('hex') : null,
  });
}

export function sameQuestContract(left, right) {
  return Boolean(left?.contractHash && right?.contractHash
    && left.contractHash === right.contractHash);
}
