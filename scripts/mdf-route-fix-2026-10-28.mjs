// Moves every МДФ order in production that waits at a station its route does not pass to the
// station it belongs at, as the owner asked on 2026-10-28 («Аманжол дайын деп баса алмай тұр»).
//
// Every order used to be sent ЧПУ → Шкурка → Краска → Вакуум. Nobody paints, so №562 Айгерим —
// sanded by Арман at 14:51 — sat at «Краска» and the vacuum press never got it to finish. A film
// order now goes ЧПУ → Шкурка → Вакуум, a paint order ЧПУ → Шкурка → Краска, and an order with no
// finish recorded is film (src/lib/mdfRoute.ts). This applies that route to the orders already on
// the floor: each goes to the first station of its route not yet finished on it.
//
//   node --env-file=.env.local scripts/mdf-route-fix-2026-10-28.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/mdf-route-fix-2026-10-28.mjs --apply
//
// Re-running after an apply is a no-op.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2"; // Нур — the owner, who asked
const LABELS = { cnc: "ЧПУ", sanding: "Шкурка", painting: "Краска", vacuum: "Вакуум" };
// The same route as src/lib/mdfRoute.ts mdfRouteFor.
const routeFor = (order) => (order.mdfFinish === "paint" ? ["cnc", "sanding", "painting"] : ["cnc", "sanding", "vacuum"]);

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const snap = await db.collection("orders").where("orderKind", "==", "mdf_wrap").get();
const moves = [];
for (const d of snap.docs) {
  const o = d.data();
  if (o.productionStatus !== "mdf_production") continue;
  const belongsAt = routeFor(o).find((s) => !o.mdfStageJobs?.[s]?.completedAt);
  if (!belongsAt || belongsAt === o.mdfStage) continue;
  moves.push({ ref: d.ref, o, belongsAt });
  console.log(`  ${o.orderNumber} ${o.customerName}: ${LABELS[o.mdfStage] ?? o.mdfStage} → ${LABELS[belongsAt]}`);
}
if (moves.length === 0) {
  console.log("already on route — nothing to do.");
  process.exit(0);
}
if (!APPLY) {
  console.log("Dry run only — add --apply to write.");
  process.exit(0);
}
const batch = db.batch();
for (const { ref, o, belongsAt } of moves) {
  batch.update(ref, { mdfStage: belongsAt, updatedAt: FieldValue.serverTimestamp() });
  batch.set(ref.collection("statusHistory").doc(), {
    field: "production", prevStatus: o.productionStatus, newStatus: o.productionStatus,
    userId: actor.uid, userName: actor.name,
    comment: `${LABELS[o.mdfStage] ?? o.mdfStage} → ${LABELS[belongsAt]}: пленка заказы краскадан өтпейді`,
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.collection("auditLogs").doc(), {
    userId: actor.uid, userName: actor.name, action: "order.mdf_route_fix", entityType: "order", entityId: ref.id,
    before: { mdfStage: o.mdfStage }, after: { mdfStage: belongsAt },
    comment: `${o.orderNumber}: ${LABELS[o.mdfStage] ?? o.mdfStage} → ${LABELS[belongsAt]} (пленка — ЧПУ, Шкурка, Вакуум; иесі, 28.10)`,
    createdAt: FieldValue.serverTimestamp(),
  });
}
await batch.commit();
console.log(`✅ ${moves.length} заказ өз кезеңіне көшірілді.`);
