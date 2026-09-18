// Populate participant history from existing material jobs. Dry run unless --apply is supplied.
// node --env-file=.env.local scripts/backfill-worker-history.mjs [--apply]
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
const accountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
if (!accountPath) throw new Error('FIREBASE_SERVICE_ACCOUNT_PATH is required');
initializeApp({ credential: cert(JSON.parse(readFileSync(accountPath, 'utf8'))) });
const db = getFirestore();
const apply = process.argv.includes('--apply');
let count = 0;
for (const doc of (await db.collection('orders').get()).docs) {
  const order = doc.data();
  if (order.orderKind === 'mdf_wrap') continue;
  const update = {};
  for (const [field, ownerKey, startedKey, completedKey] of [['cuttingWorkerIds', 'cuttingByUid', 'cuttingStartedAt', 'cuttingCompletedAt'], ['pvcWorkerIds', 'pvcByUid', 'pvcStartedAt', 'pvcCompletedAt']]) {
    const ids = [...new Set((order.lineJobs ?? []).filter(job => job[startedKey] || job[completedKey]).map(job => job[ownerKey]).filter(id => typeof id === 'string' && id))];
    const missing = ids.filter(id => !(order[field] ?? []).includes(id));
    if (missing.length) update[field] = FieldValue.arrayUnion(...missing);
  }
  if (!Object.keys(update).length) continue;
  count++;
  if (apply) await doc.ref.update(update);
}
console.log(`${apply ? 'Updated' : 'Would update'} ${count} orders. No other fields changed.`);
