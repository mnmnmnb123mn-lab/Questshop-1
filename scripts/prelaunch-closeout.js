import '../src/config/load-local-environment.js';
import { loadEnvironment } from '../src/config/env.js';
import { acquireSingleInstanceLock, closeSqliteDatabase, openSqliteDatabase } from '../src/db/sqlite.js';
import { refundReadyOrderItem, resolveOrderItemReview, settleOrderItem } from '../src/domain/sqlite/orders.js';
import { resolveTopupFinancialReview, reverseCreditedTopup } from '../src/domain/sqlite/payments.js';

if (process.env.CONFIRM_PRELAUNCH_CLOSEOUT !== 'I_UNDERSTAND_COMPENSATING_TRANSACTIONS') {
  throw new Error('Set CONFIRM_PRELAUNCH_CLOSEOUT=I_UNDERSTAND_COMPENSATING_TRANSACTIONS after Owner review');
}

const env = loadEnvironment();
if (!env.PRELAUNCH) throw new Error('Pre-launch closeout is permitted only while PRELAUNCH=true');
// Closeout changes balances, so it must be mutually exclusive with the bot
// runtime just like restore.  It never attempts to take over a live lock.
const closeoutLock = await acquireSingleInstanceLock(env.SQLITE_PATH);
let db;
const report = { released: 0, refundedCaptured: 0, reversedTopups: 0, failures: [] };
try {
  db = await openSqliteDatabase({ databasePath: env.SQLITE_PATH, secret: env.QUESTSHOP_SECRET_KEY });
  const items = db.prepare(`SELECT i.*,r.id AS review_id FROM order_items i JOIN orders o ON o.id=i.order_id
    LEFT JOIN manual_reviews r ON r.subject_type='ORDER_ITEM' AND r.subject_id=i.id AND r.state='OPEN'
    WHERE o.prelaunch=1 AND i.state NOT IN ('FAILED','REFUNDED')`).all();
  for (const item of items) {
    try {
      if (item.state === 'READY_TO_CLAIM') { refundReadyOrderItem(db, { itemId: item.id, actorId: env.OWNER_ID, reason: 'PRELAUNCH_CLOSEOUT' }); report.refundedCaptured += 1; }
      else if (item.state === 'REVIEW' && item.review_id) { resolveOrderItemReview(db, { reviewId: item.review_id, actorId: env.OWNER_ID, decision: 'RELEASE', reason: 'PRELAUNCH_CLOSEOUT' }); report.released += 1; }
      else { settleOrderItem(db, { itemId: item.id, outcome: 'FAILED', reason: 'PRELAUNCH_CLOSEOUT', evidence: { prelaunchCloseout: true } }); report.released += 1; }
    } catch (error) { report.failures.push({ subject: item.id, code: error.code ?? error.name }); }
  }
  const topups = db.prepare("SELECT * FROM topups WHERE prelaunch=1 AND status IN ('CREDITED','REVIEW')").all();
  for (const topup of topups) {
    try {
      if (topup.status === 'CREDITED') {
        const result = reverseCreditedTopup(db, { topupId: topup.id, actorId: env.OWNER_ID, reason: 'PRELAUNCH_CLOSEOUT' });
        if (result.reviewOpened) throw Object.assign(new Error('manual reversal review required'), { code: 'REVERSAL_MANUAL_REVIEW' });
        report.reversedTopups += 1;
      } else {
        const review = db.prepare("SELECT * FROM manual_reviews WHERE subject_type='TOPUP' AND subject_id=? AND state='OPEN'").get(topup.id);
        if (!review) throw Object.assign(new Error('missing top-up review'), { code: 'TOPUP_REVIEW_MISSING' });
        resolveTopupFinancialReview(db, { reviewId: review.id, actorId: env.OWNER_ID, decision: 'REJECT', reason: 'PRELAUNCH_CLOSEOUT' });
        resolveTopupFinancialReview(db, { reviewId: review.id, actorId: env.OWNER_ID, decision: 'REJECT', reason: 'PRELAUNCH_CLOSEOUT' });
      }
    } catch (error) { report.failures.push({ subject: topup.id, code: error.code ?? error.name }); }
  }
  console.log(JSON.stringify(report));
  if (report.failures.length) process.exitCode = 1;
} finally {
  closeSqliteDatabase(db);
  await closeoutLock.release();
}
