// Full backup of the Firestore database to timestamped JSON on this machine.
//
// Why this exists rather than Firebase's own backups: managed backups, point-in-time recovery and
// `gcloud firestore export` all require the Blaze plan, because they write to Cloud Storage. On
// the free Spark plan this Admin-SDK export is the only backup available — and a database with no
// backup is one mistake away from gone.
//
//   node --env-file=.env.local scripts/backup-firestore.mjs
//   node --env-file=.env.local scripts/backup-firestore.mjs --out D:/backups
//
// Writes backups/<YYYY-MM-DD_HH-mm>/<collection>.json, one file per collection, plus a
// manifest.json recording what was captured. Subcollections (orders/{id}/parts) are nested inside
// their parent document under "__subcollections__" so a restore can put them back.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const outRoot = (() => {
  const i = process.argv.indexOf("--out");
  return i > -1 ? process.argv[i + 1] : "backups";
})();

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

/**
 * Firestore values are not all JSON. Timestamps, GeoPoints and DocumentReferences are tagged so
 * the restore can rebuild them as the same types instead of as plain objects — a Timestamp that
 * comes back as {_seconds} would break every date comparison in the app.
 */
function encode(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Timestamp) return { __type__: "timestamp", seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === "object") {
    if (value.constructor?.name === "DocumentReference") return { __type__: "ref", path: value.path };
    if (value.constructor?.name === "GeoPoint") return { __type__: "geo", lat: value.latitude, lng: value.longitude };
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = encode(v);
    return out;
  }
  return value;
}

async function dumpDoc(docSnap) {
  const entry = { id: docSnap.id, data: encode(docSnap.data()) };
  const subs = await docSnap.ref.listCollections();
  if (subs.length > 0) {
    entry.__subcollections__ = {};
    for (const sub of subs) {
      const snap = await sub.get();
      entry.__subcollections__[sub.id] = await Promise.all(snap.docs.map(dumpDoc));
    }
  }
  return entry;
}

const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
const dir = join(outRoot, stamp);
mkdirSync(dir, { recursive: true });

const collections = await db.listCollections();
const manifest = { takenAt: new Date().toISOString(), projectId: sa.project_id, collections: {} };
let totalDocs = 0;

for (const col of collections) {
  const snap = await col.get();
  const docs = [];
  for (const d of snap.docs) docs.push(await dumpDoc(d));
  writeFileSync(join(dir, `${col.id}.json`), JSON.stringify(docs, null, 2), "utf8");
  manifest.collections[col.id] = docs.length;
  totalDocs += docs.length;
  console.log(`  ${col.id}: ${docs.length}`);
}

writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
console.log(`\n✅ ${collections.length} collection(s), ${totalDocs} document(s) → ${dir}`);
console.log("Бұл қалтаны басқа жерге де көшіріп қойыңыз — бір ғана компьютерде тұрған көшірме толық қорғаныс емес.");
process.exit(0);
