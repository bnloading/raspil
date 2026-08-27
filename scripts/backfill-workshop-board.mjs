// One-off migration: populates workshopActivity for orders already on the shop floor.
// Orders that entered production before the public board existed have no board row; this walks
// every order and writes/removes its row using the same stage mapping the app uses at runtime.
//   node --env-file=.env.local scripts/backfill-workshop-board.mjs
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

/** Mirrors boardStageFor() in src/lib/workshopActivity.ts. */
function boardStageFor(status, pvcMeters) {
  switch (status) {
    case "cutting_queue": return "queue";
    case "cutting_started": return "cutting";
    case "cutting_completed": return pvcMeters > 0 ? "pvc_wait" : "ready";
    case "pvc_queue": return "pvc_wait";
    case "pvc_started": return "pvc";
    case "pvc_completed":
    case "ready": return "ready";
    default: return null;
  }
}

const snap = await db.collection("orders").get();
let written = 0, removed = 0, skipped = 0;

for (const d of snap.docs) {
  const o = d.data();
  if (typeof o.orderNumber !== "string" || typeof o.productionStatus !== "string") { skipped++; continue; }
  const stage = boardStageFor(o.productionStatus, o.pvcMetersTotal ?? 0);
  const ref = db.collection("workshopActivity").doc(d.id);
  if (stage === null) {
    const existing = await ref.get();
    if (existing.exists) { await ref.delete(); removed++; }
    continue;
  }
  const estimatedMinutes =
    stage === "cutting" ? (o.cuttingEstimatedMinutes ?? 0)
    : stage === "pvc" ? (o.pvcEstimatedMinutes ?? 0)
    : 0;
  const startedAt =
    stage === "cutting" ? (o.cuttingStartedAt ?? null)
    : stage === "pvc" ? (o.pvcStartedAt ?? null)
    : null;
  await ref.set({
    orderNumber: o.orderNumber,
    stage,
    queuePosition: o.priority ?? 0,
    needsPvc: (o.pvcMetersTotal ?? 0) > 0,
    estimatedMinutes,
    startedAt,
    updatedAt: FieldValue.serverTimestamp(),
  });
  written++;
}

console.log(`workshopActivity backfill: ${written} written, ${removed} removed, ${skipped} legacy orders skipped`);
process.exit(0);
