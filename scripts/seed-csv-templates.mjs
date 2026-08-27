// Seeds a starter set of named cutting-program export templates, each with a genuinely different
// format so a shop can see what the options do. Safe to re-run: templates are matched by name and
// updated rather than duplicated.
//   node --env-file=.env.local scripts/seed-csv-templates.mjs

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const ALL_COLUMNS = [
  "orderNumber", "customerName", "partNumber", "partName", "material", "materialThickness",
  "lengthMm", "widthMm", "quantity", "grainDirection", "rotationAllowed",
  "pvcEdgeA", "pvcEdgeB", "pvcEdgeC", "pvcEdgeD", "pvcThickness", "pvcColour", "note",
];

const templates = [
  {
    name: "Cutting негізгі",
    columns: ALL_COLUMNS,
    delimiter: ",",
    encoding: "utf8-bom",
    includeHeaders: true,
    unit: "mm",
    dimensionOrder: "length_first",
    pvcMapping: "per_edge",
    isDefault: true,
  },
  {
    name: "Пила №1",
    // A saw that wants a lean file: dimensions, quantity and a single combined edging field.
    columns: ["partNumber", "partName", "lengthMm", "widthMm", "quantity", "pvcEdgeA", "pvcEdgeB", "pvcEdgeC", "pvcEdgeD"],
    columnLabels: { partNumber: "N", partName: "NAME", lengthMm: "L", widthMm: "W", quantity: "QTY", pvcEdgeA: "EDGES" },
    delimiter: ";",
    encoding: "utf8-bom",
    includeHeaders: true,
    unit: "mm",
    dimensionOrder: "length_first",
    pvcMapping: "combined",
    isDefault: false,
  },
  {
    name: "Пила №2",
    // Width-first, centimetres, no header row — the format an older program expects.
    columns: ["partName", "lengthMm", "widthMm", "quantity", "pvcThickness", "pvcColour"],
    delimiter: ";",
    encoding: "utf8",
    includeHeaders: false,
    unit: "cm",
    dimensionOrder: "width_first",
    pvcMapping: "per_edge",
    isDefault: false,
  },
  {
    name: "Excel формат",
    columns: ALL_COLUMNS,
    delimiter: ";",
    encoding: "utf8-bom",
    includeHeaders: true,
    unit: "mm",
    dimensionOrder: "length_first",
    pvcMapping: "per_edge",
    isDefault: false,
  },
  {
    name: "Клиентке арналған",
    // What a customer should see: no internal material/rotation columns.
    columns: ["partNumber", "partName", "lengthMm", "widthMm", "quantity", "pvcColour", "note"],
    columnLabels: { partNumber: "№", partName: "Бөлшек", note: "Ескертпе" },
    delimiter: ",",
    encoding: "utf8-bom",
    includeHeaders: true,
    unit: "mm",
    dimensionOrder: "length_first",
    pvcMapping: "combined",
    isDefault: false,
  },
];

const existing = await db.collection("csvTemplates").get();
const byName = new Map(existing.docs.map((d) => [d.data().name, d.ref]));

for (const t of templates) {
  const payload = {
    ...t,
    columnLabels: t.columnLabels ?? {},
    archived: false,
    updatedAt: FieldValue.serverTimestamp(),
    updatedByName: "seed",
  };
  const ref = byName.get(t.name);
  if (ref) {
    await ref.set(payload, { merge: true });
    console.log(`updated: ${t.name}`);
  } else {
    await db.collection("csvTemplates").add({ ...payload, createdAt: FieldValue.serverTimestamp() });
    console.log(`created: ${t.name}${t.isDefault ? " (default)" : ""}`);
  }
}

console.log(`\n${templates.length} CSV templates ready.`);
process.exit(0);
