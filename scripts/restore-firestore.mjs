// Restores a backup made by scripts/backup-firestore.mjs.
//
// Dry run by default — it prints what it would write and changes nothing. Restoring is the kind of
// operation you run once, in a hurry, on the worst day, so it refuses to do anything destructive
// without being told twice.
//
//   node --env-file=.env.local scripts/restore-firestore.mjs backups/2026-08-28_19-30
//   node --env-file=.env.local scripts/restore-firestore.mjs backups/2026-08-28_19-30 --apply
//   node --env-file=.env.local scripts/restore-firestore.mjs <dir> --apply --only orders,payments
//
// Documents are written by id with merge:false, so a restored document exactly matches the backup.
// Documents created AFTER the backup are left alone — this fills gaps and overwrites, it does not
// wipe the database first. Use --only to restore a single collection you actually lost.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp, GeoPoint } from "firebase-admin/firestore";

const dir = process.argv[2];
const APPLY = process.argv.includes("--apply");
const only = (() => {
  const i = process.argv.indexOf("--only");
  return i > -1 ? new Set(process.argv[i + 1].split(",").map((s) => s.trim())) : null;
})();

if (!dir || !existsSync(dir)) {
  console.error("Backup қалтасын көрсетіңіз, мысалы: backups/2026-08-28_19-30");
  process.exit(1);
}

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const manifestPath = join(dir, "manifest.json");
if (existsSync(manifestPath)) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  console.log(`Backup: ${m.takenAt}  project: ${m.projectId}`);
  // Restoring one project's data into another is almost always a mistake, so say it loudly.
  if (m.projectId !== sa.project_id) {
    console.error(`\n⛔ Backup "${m.projectId}" жобасынан, ал сіз "${sa.project_id}" жобасына жазғалы тұрсыз.`);
    process.exit(1);
  }
}

/** Inverse of the encoder in backup-firestore.mjs — rebuilds the real Firestore types. */
function decode(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(decode);
  if (typeof value === "object") {
    if (value.__type__ === "timestamp") return new Timestamp(value.seconds, value.nanoseconds);
    if (value.__type__ === "geo") return new GeoPoint(value.lat, value.lng);
    if (value.__type__ === "ref") return db.doc(value.path);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decode(v);
    return out;
  }
  return value;
}

let writes = 0;
async function restoreDocs(colRef, docs) {
  for (const d of docs) {
    if (APPLY) await colRef.doc(d.id).set(decode(d.data));
    writes++;
    for (const [subName, subDocs] of Object.entries(d.__subcollections__ ?? {})) {
      await restoreDocs(colRef.doc(d.id).collection(subName), subDocs);
    }
  }
}

const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json");
for (const file of files) {
  const name = file.replace(/\.json$/, "");
  if (only && !only.has(name)) continue;
  const docs = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const before = writes;
  await restoreDocs(db.collection(name), docs);
  console.log(`  ${name}: ${writes - before}`);
}

console.log(`\n${APPLY ? "✅ Қалпына келтірілді" : "🔍 Dry run — ештеңе жазылған жоқ"}: ${writes} құжат`);
if (!APPLY) console.log("Шынымен жазу үшін соңына --apply қосыңыз.");
process.exit(0);
