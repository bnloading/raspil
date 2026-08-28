// Switches existing customers from their phone-derived synthetic sign-in address
// (77XXXXXXXXX@customers.workshop.local) to the real email already stored on their user document.
//
// After this a migrated customer signs in with their email, NOT their phone number — Firebase Auth
// allows only one email per account, so this is a trade, not an addition. Customers with no email
// on file are left on the phone address and are unaffected.
//
// Passwords are untouched.
//
//   node --env-file=.env.local scripts/migrate-auth-emails.mjs          # dry run, changes nothing
//   node --env-file=.env.local scripts/migrate-auth-emails.mjs --apply  # actually migrate

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const APPLY = process.argv.includes("--apply");

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const auth = getAuth();

const SYNTHETIC = "@customers.workshop.local";

const users = await db.collection("users").get();
let migrated = 0;
let skipped = 0;

for (const doc of users.docs) {
  const u = doc.data();
  const realEmail = String(u.email ?? "").trim().toLowerCase();

  let authUser;
  try {
    authUser = await auth.getUser(doc.id);
  } catch {
    console.log(`  skip ${u.name}: no auth record`);
    skipped++;
    continue;
  }

  const current = String(authUser.email ?? "");
  if (!current.endsWith(SYNTHETIC)) {
    skipped++;
    continue; // already signs in with a real address
  }
  if (!realEmail || !realEmail.includes("@")) {
    console.log(`  skip ${u.name} (${u.phone}): no email on file — stays on phone sign-in`);
    skipped++;
    continue;
  }

  // Another account may already own this address; Auth would reject the update, so say why.
  const taken = await auth.getUserByEmail(realEmail).catch(() => null);
  if (taken && taken.uid !== doc.id) {
    console.log(`  skip ${u.name}: ${realEmail} already belongs to another account`);
    skipped++;
    continue;
  }

  console.log(`  ${APPLY ? "migrate" : "would migrate"} ${u.name}: ${current} -> ${realEmail}`);
  if (APPLY) {
    await auth.updateUser(doc.id, { email: realEmail });
    await doc.ref.set({ authEmail: realEmail }, { merge: true });
  }
  migrated++;
}

console.log(
  `\n${APPLY ? "migrated" : "would migrate"}: ${migrated}, unchanged: ${skipped}` +
    (APPLY ? "" : "\n(dry run — re-run with --apply to make the change)"),
);
process.exit(0);
