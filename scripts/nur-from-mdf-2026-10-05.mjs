// Puts 1 906 000 ₸ from МДФ into Нұр, as the owner asked on 2026-10-05 («Нұрға 1906000 теңге қос,
// МДФ-тен деп жазып»).
//
// The money comes from the МДФ line's business, which the МДФ Касса does not carry (nothing has
// moved there since the 30.09 restart), so there is no МДФ pot to take it out of. It is one dated
// correction on the ЛДСП Касса's Нұр pot, "+1 906 000 ₸ · МДФ-тен", written exactly as the Admin's
// «Банкпен теңестіру» form writes one (applicationSettings.cashAdjustments.ldsp, see
// ManagerCashbox.tsx ReconcileEditor): Касса lists it with its date and reason, and it can be taken
// back there if it was wrong.
//
//   node --env-file=.env.local scripts/nur-from-mdf-2026-10-05.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/nur-from-mdf-2026-10-05.mjs --apply
//
// Re-running after an apply is a no-op: the correction is then already in the list. Its id is fixed
// rather than random, so even two runs racing each other add one entry — arrayUnion skips an equal one.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2"; // Нур — the owner, who asked
const DEPT = "ldsp";
const ACCOUNT = "deposit"; // Нұр (lib/cashbox.ts CASH_ACCOUNT_LABELS)
const AMOUNT_TIYN = 1_906_000_00;
const DATE = "2026-10-05";
const NOTE = "МДФ-тен";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
const fmt = (t) => `${(t / 100).toLocaleString("ru-RU")} ₸`;
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const settingsRef = db.collection("applicationSettings").doc("global");
const settings = (await settingsRef.get()).data();
// A correction dated before the restart would be written and never counted (lib/cashbox.ts).
if (settings.cashStartDate && DATE < settings.cashStartDate) {
  throw new Error(`${DATE} is before the restart (${settings.cashStartDate})`);
}
const ID = "nur-from-mdf-2026-10-05";
const same = (settings.cashAdjustments?.[DEPT] ?? [])
  .find((a) => a.id === ID || (a.account === ACCOUNT && a.amountTiyn === AMOUNT_TIYN && a.date === DATE && a.note === NOTE));
if (same) {
  console.log(`already written (${same.id}) — nothing to do.`);
  process.exit(0);
}

const adjustment = {
  id: ID, account: ACCOUNT, amountTiyn: AMOUNT_TIYN, date: DATE, note: NOTE,
  byUid: actor.uid, byName: actor.name,
};
console.log(`→ ЛДСП Касса, Нұр: +${fmt(AMOUNT_TIYN)} · ${DATE} · «${NOTE}» · ${actor.name}`);
if (!APPLY) {
  console.log("Dry run only — add --apply to write.");
  process.exit(0);
}

// One batch: the correction and its audit entry land together or not at all.
const batch = db.batch();
batch.update(settingsRef, { [`cashAdjustments.${DEPT}`]: FieldValue.arrayUnion(adjustment) });
batch.set(db.collection("auditLogs").doc(), {
  userId: actor.uid, userName: actor.name, action: "cash.adjustment.add", entityType: "applicationSettings",
  entityId: "global", before: null, after: adjustment, comment: `${NOTE} +${fmt(AMOUNT_TIYN)} (Нұр)`,
  createdAt: FieldValue.serverTimestamp(),
});
await batch.commit();
console.log("✅ Жазылды:", JSON.stringify(adjustment));
