// Takes the blank line off ORD-2026-000295 (Сырт) and lets it leave the saw, as the owner asked on
// 2026-10-01 ("0 лист деген тұр соны өшір — дайын деген басылмай тұр").
//
// Its countertop was cut and confirmed by Олжас at 11:10, but the shop floor's copy of its lines
// (lineJobs) carried a second, blank one — no material, 0 sheets, no ПВХ — left by an autosave
// that landed in the same second the order was sent to the saw. With nothing on it to confirm, the
// order could never reach "Дайын". The app now ignores such lines (lib/orderLines.ts isEmptyJob);
// this removes 295's and completes it the way the last confirmed line would have: no ПВХ on it, so
// straight to "ready", with the same history, audit and workshop-board writes.
//
//   node --env-file=.env.local scripts/fix-blank-line-295-2026-10-01.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/fix-blank-line-295-2026-10-01.mjs --apply
//
// Re-running after an apply is a no-op: the order is no longer on the saw.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2";
const ORDER = "ORD-2026-000295";
const NOTE = "Бос жол (материалсыз, 0 лист) алынды — распил аяқталды";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const snap = await db.collection("orders").where("orderNumber", "==", ORDER).get();
if (snap.size !== 1) throw new Error(`${ORDER}: ${snap.size} табылды`);
const ref = snap.docs[0].ref;
const order = snap.docs[0].data();
if (order.productionStatus !== "cutting_started") {
  console.log(`${ORDER} is ${order.productionStatus} — nothing to do.`);
  process.exit(0);
}

const blank = (j) => !j.materialId && !(j.sheetQty > 0) && !(j.pvcMeters > 0);
const jobs = order.lineJobs ?? [];
const kept = jobs.filter((j) => !blank(j)).map((j, index) => ({ ...j, index }));
console.log(`lines: ${jobs.map((j) => `${j.materialName || "(бос)"} ×${j.sheetQty}${j.cuttingCompletedAt ? " ✓" : ""}`).join(" | ")}`);
if (kept.length === jobs.length) throw new Error("No blank line to remove");
if (!kept.every((j) => j.cuttingCompletedAt)) throw new Error("A real line is still uncut — not finishing the order");
const needsPvc = kept.some((j) => j.pvcMeters > 0);
const next = needsPvc ? "pvc_queue" : "ready";
console.log(`→ ${kept.length} line(s) kept, all cut; status cutting_started → ${next}`);
if (!APPLY) {
  console.log("Dry run only — add --apply to write.");
  process.exit(0);
}

const now = FieldValue.serverTimestamp();
await ref.update({
  lineJobs: kept,
  confirmedSheets: kept.reduce((s, j) => s + (j.confirmedSheets ?? 0), 0),
  productionStatus: next,
  cuttingCompletedAt: now,
  ...(needsPvc ? { pvcQueuedAt: now } : { readyAt: now }),
});
const history = ref.collection("statusHistory");
const row = (prevStatus, newStatus, comment = "") => ({
  field: "production", prevStatus, newStatus, userId: actor.uid, userName: actor.name, comment, createdAt: now,
});
await history.add(row("cutting_started", "cutting_completed", NOTE));
await history.add(row("cutting_completed", next));
await db.collection("auditLogs").add({
  userId: actor.uid, userName: actor.name, action: "order.cutting_completed", entityType: "order",
  entityId: ref.id, before: { lineJobs: jobs.length }, after: { lineJobs: kept.length, productionStatus: next },
  comment: NOTE, createdAt: now,
});
// The public workshop board: "Дайын" (or ПВХ күтуде), as syncWorkshopBoard writes it.
await db.collection("workshopActivity").doc(ref.id).set({
  orderNumber: order.orderNumber,
  customerName: (order.customerName ?? "").trim(),
  orderKind: order.orderKind ?? "cutting",
  stage: needsPvc ? "pvc_wait" : "ready",
  queuePosition: order.priority ?? 0,
  needsPvc,
  estimatedMinutes: 0,
  startedAt: null,
  updatedAt: now,
});
console.log(`✅ ${ORDER} → ${next}`);
