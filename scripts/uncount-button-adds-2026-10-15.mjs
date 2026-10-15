// Takes back out of Касса every payment the owner counted in with Касса's «Кассаға қосу» button on
// 2026-10-15, as they asked: «кассаға қосу деп қосқан барлық суммаларды қайта кері қайтар» — they
// had pressed it on orders whose money was already in the 30.09 settlement, without noticing.
//
// Found by their audit entries (payment.countsInCurrentBooks, false → true, made from the page —
// a script's entry carries a «— …» reason, the button's does not). №66 Айбек Соната's 220 000 ₸
// was counted in by scripts/count-aibek-sonata-220000-2026-10-15.mjs at the owner's own request and
// is not one of them; №274's 133 260 ₸ is already out (scripts/uncount-274-133260-2026-10-15.mjs).
//
//   node --env-file=.env.local scripts/uncount-button-adds-2026-10-15.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/uncount-button-adds-2026-10-15.mjs --apply
//
// Re-running after an apply is a no-op: the payments are then already out.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2"; // Нур — the owner, who asked
const DAY = "2026-10-15";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
const fmt = (t) => `${(t / 100).toLocaleString("ru-RU")} ₸`;
const when = (ts) => new Date(ts.toMillis() + 5 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const audits = (await db.collection("auditLogs").where("action", "==", "payment.countsInCurrentBooks").get()).docs
  .map((d) => d.data())
  .filter((a) => a.createdAt && when(a.createdAt).startsWith(DAY) && a.after?.countsInCurrentBooks === true && !(a.comment ?? "").includes("—"));
const ids = [...new Set(audits.map((a) => a.entityId))];
const orders = new Map((await db.collection("orders").get()).docs.map((d) => [d.id, d.data()]));
const todo = [];
const pots = {};
for (const id of ids) {
  const ref = db.collection("payments").doc(id);
  const p = (await ref.get()).data();
  const o = orders.get(p?.orderId);
  const state = !p ? "missing" : p.countsInCurrentBooks ? "in Касса" : "already out";
  console.log(`  ${o?.orderNumber} ${o?.customerName} | ${p ? fmt(p.amountTiyn) : "?"} ${p?.methodName ?? ""} | recorded ${p ? when(p.createdAt) : "?"} | ${state}`);
  if (p?.countsInCurrentBooks) {
    todo.push({ ref, id, p, o });
    pots[p.methodName] = (pots[p.methodName] ?? 0) + p.amountTiyn;
  }
}
console.log(`${todo.length} to take out, ${fmt(todo.reduce((s, x) => s + x.p.amountTiyn, 0))}:`, Object.fromEntries(Object.entries(pots).map(([k, v]) => [k, fmt(v)])));
if (todo.length === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}
if (!APPLY) {
  console.log("Dry run only — add --apply to write.");
  process.exit(0);
}
const batch = db.batch();
for (const { ref, id, p, o } of todo) {
  batch.update(ref, { countsInCurrentBooks: false });
  batch.set(db.collection("auditLogs").doc(), {
    userId: actor.uid, userName: actor.name, action: "payment.countsInCurrentBooks", entityType: "payment",
    entityId: id, before: { countsInCurrentBooks: true }, after: { countsInCurrentBooks: false },
    comment: `${o.orderNumber} ${fmt(p.amountTiyn)} ${p.methodName} — «Кассаға қосу» қайтарылды (иесі, 15.10)`,
    createdAt: FieldValue.serverTimestamp(),
  });
}
await batch.commit();
console.log(`✅ ${todo.length} төлем Кассадан қайтарылды.`);
