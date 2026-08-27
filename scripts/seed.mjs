// Seeds reference data (payment methods, sample materials, PVC types, app settings) and one dev
// account per role, using the Firebase Admin SDK. Run with:
//   node --env-file=.env.local scripts/seed.mjs
// Requires FIREBASE_SERVICE_ACCOUNT_PATH and the SEED_* vars from .env.example.

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function normalizePhone(raw) {
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 10) digits = "7" + digits;
  if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
  if (digits.length !== 11 || !digits.startsWith("7")) throw new Error(`Invalid phone: ${raw}`);
  return digits;
}

const serviceAccountPath = requireEnv("FIREBASE_SERVICE_ACCOUNT_PATH");
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));

if (getApps().length === 0) {
  initializeApp({ credential: cert(serviceAccount) });
}
const auth = getAuth();
const db = getFirestore();

async function ensureUser({ name, email, phone, password, role }) {
  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(email);
    console.log(`✓ Auth user already exists: ${email}`);
  } catch {
    userRecord = await auth.createUser({ email, password, displayName: name });
    console.log(`✓ Created auth user: ${email}`);
  }
  await db.collection("users").doc(userRecord.uid).set(
    {
      name,
      phone: phone ?? "",
      email: phone ? null : email,
      authEmail: email,
      role,
      blocked: false,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  console.log(`✓ Firestore user doc ready: ${name} (${role})`);
  return userRecord.uid;
}

async function seedPaymentMethods() {
  const methods = [
    { id: "cash", name: "Нал / Қолма-қол", active: true, isMixed: false },
    { id: "kaspi", name: "Kaspi", active: true, isMixed: false },
    { id: "pay", name: "Pay", active: true, isMixed: false },
    { id: "nur", name: "Нұр", active: true, isMixed: false },
    { id: "balim", name: "Бәлім", active: true, isMixed: false },
    { id: "mixed", name: "Аралас", active: true, isMixed: true },
  ];
  for (const m of methods) {
    await db.collection("paymentMethods").doc(m.id).set(m, { merge: true });
  }
  console.log(`✓ Seeded ${methods.length} payment methods`);
}

async function seedSettings() {
  await db.collection("applicationSettings").doc("global").set(
    {
      cuttingPricePerSheetTiyn: 5_000_000,
      pvcThicknessOptionsMm: [0.4, 1, 2],
      companyName: "Цех Трекер",
    },
    { merge: true },
  );
  console.log("✓ Seeded applicationSettings/global");
}

async function seedMaterials() {
  const materials = [
    {
      id: "ldsp-ak",
      name: "ЛДСП Ақ",
      article: "AK-001",
      color: "Ақ",
      manufacturer: "Egger",
      thicknessMm: 16,
      sheetLengthMm: 2800,
      sheetWidthMm: 2070,
      sellingPriceTiyn: 1_500_000,
      initialQty: 50,
      qtyOnHand: 50,
      reservedQty: 0,
      minStock: 5,
      active: true,
      archived: false,
      grainDirectionRequired: false,
      note: "",
      purchasePriceTiyn: 1_100_000,
    },
    {
      id: "ldsp-dub-votan",
      name: "ЛДСП Дуб Вотан",
      article: "DV-014",
      color: "Дуб Вотан",
      manufacturer: "Egger",
      thicknessMm: 16,
      sheetLengthMm: 2800,
      sheetWidthMm: 2070,
      sellingPriceTiyn: 1_700_000,
      initialQty: 30,
      qtyOnHand: 30,
      reservedQty: 0,
      minStock: 5,
      active: true,
      archived: false,
      grainDirectionRequired: true,
      note: "",
      purchasePriceTiyn: 1_250_000,
    },
  ];
  for (const { purchasePriceTiyn, ...m } of materials) {
    await db.collection("materials").doc(m.id).set(m, { merge: true });
    await db.collection("materialCosts").doc(m.id).set({ purchasePriceTiyn }, { merge: true });
  }
  console.log(`✓ Seeded ${materials.length} materials`);
}

async function seedPvcTypes() {
  const pvcTypes = [
    { id: "pvc-04-white", thicknessMm: 0.4, colorName: "Ақ", pricePerMeterTiyn: 15_000, active: true },
    { id: "pvc-1-white", thicknessMm: 1, colorName: "Ақ", pricePerMeterTiyn: 25_000, active: true },
    { id: "pvc-2-white", thicknessMm: 2, colorName: "Ақ", pricePerMeterTiyn: 40_000, active: true },
  ];
  for (const p of pvcTypes) {
    await db.collection("pvcTypes").doc(p.id).set(p, { merge: true });
  }
  console.log(`✓ Seeded ${pvcTypes.length} PVC types`);
}

async function main() {
  await seedPaymentMethods();
  await seedSettings();
  await seedMaterials();
  await seedPvcTypes();

  await ensureUser({
    name: process.env.SEED_ADMIN_NAME ?? "Admin",
    email: requireEnv("SEED_ADMIN_EMAIL"),
    password: requireEnv("SEED_ADMIN_PASSWORD"),
    role: "admin",
  });
  await ensureUser({
    name: process.env.SEED_MANAGER_NAME ?? "Manager",
    email: requireEnv("SEED_MANAGER_EMAIL"),
    password: requireEnv("SEED_MANAGER_PASSWORD"),
    role: "manager",
  });
  await ensureUser({
    name: process.env.SEED_CUTTER_NAME ?? "Cutter",
    email: requireEnv("SEED_CUTTER_EMAIL"),
    password: requireEnv("SEED_CUTTER_PASSWORD"),
    role: "raspil",
  });
  await ensureUser({
    name: process.env.SEED_PVC_NAME ?? "PVC Worker",
    email: requireEnv("SEED_PVC_EMAIL"),
    password: requireEnv("SEED_PVC_PASSWORD"),
    role: "pvh",
  });

  const customerPhone = normalizePhone(requireEnv("SEED_CUSTOMER_PHONE"));
  await ensureUser({
    name: process.env.SEED_CUSTOMER_NAME ?? "Test Client",
    email: `${customerPhone}@customers.workshop.local`,
    phone: customerPhone,
    password: requireEnv("SEED_CUSTOMER_PASSWORD"),
    role: "customer",
  });

  console.log("\n✅ Seed complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
