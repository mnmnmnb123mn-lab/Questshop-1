import { v7 as uuidv7 } from 'uuid';
import { QuestshopError } from '../../shared/errors.js';

const GIT_SHA = /^[0-9a-f]{7,64}$/;
const TYPES = new Set(['PRELAUNCH_GATE', 'PRELAUNCH_CLOSEOUT']);

export function assertReleaseIdentity(release) {
  if (!release?.prelaunch || !GIT_SHA.test(String(release.gitSha ?? ''))) {
    throw new QuestshopError('RELEASE_SHA_REQUIRED', 'Pre-launch ต้องระบุ Git SHA ที่ตรวจสอบได้ก่อนทำรายการ');
  }
  if (!release.appVersion || !release.engineVersion) {
    throw new QuestshopError('RELEASE_VERSION_REQUIRED', 'Pre-launch ต้องระบุ App และ Engine version');
  }
  return Object.freeze({
    prelaunch: true,
    gitSha: String(release.gitSha),
    appVersion: String(release.appVersion),
    engineVersion: String(release.engineVersion),
  });
}

export async function appendReleaseEvidence(client, {
  evidenceType,
  subjectType,
  subjectId,
  release,
  evidence = {},
}, context) {
  if (!TYPES.has(evidenceType) || !subjectType || !subjectId) {
    throw new TypeError('invalid release evidence');
  }
  const identity = assertReleaseIdentity(release);
  const idempotencyKey = `${context.idempotencyKey}:release:${evidenceType}:${subjectType}:${subjectId}`;
  const result = await client.query(`
    INSERT INTO release_evidence(
      id,evidence_type,subject_type,subject_id,prelaunch,git_sha,app_version,engine_version,
      actor_type,actor_id,idempotency_key,evidence,trace_id
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(idempotency_key) DO NOTHING
    RETURNING *
  `, [uuidv7(), evidenceType, subjectType, String(subjectId), identity.prelaunch,
    identity.gitSha, identity.appVersion, identity.engineVersion, context.actorType,
    context.actorId, idempotencyKey, evidence, context.traceId]);
  if (result.rows[0]) return result.rows[0];
  return (await client.query('SELECT * FROM release_evidence WHERE idempotency_key=$1', [idempotencyKey])).rows[0];
}
