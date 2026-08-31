// Firebase Auth "Authorized domains" — the list of hosts allowed to sign users in.
//
// Sign-in is refused on any host not on this list, so a fresh Vercel domain locks everyone out of
// the deployed app until it is added. The Firebase CLI has no command for it: the list lives in
// the Identity Toolkit admin API, which is what the Console's Authentication → Settings →
// Authorized domains page writes to. This script talks to that API directly so the deployment can
// be checked and fixed from the repo rather than by remembering a Console page.
//
//   node --env-file=.env.local scripts/auth-domains.mjs
//   node --env-file=.env.local scripts/auth-domains.mjs --add raspil-flagman.vercel.app
//
// Adding is idempotent and never removes anything: the existing list is read, the missing entries
// are appended, and the result is read back. Removing a domain is deliberately not offered —
// taking a host off the list signs its users out of the ability to log in at all, and that should
// be a considered click in the Console, not a flag on a script.

import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
const projectId = sa.project_id;

const addIndex = process.argv.indexOf("--add");
const toAdd =
  addIndex === -1 ? [] : process.argv.slice(addIndex + 1).filter((a) => !a.startsWith("--"));

const auth = new GoogleAuth({
  credentials: sa,
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
const { token } = await (await auth.getClient()).getAccessToken();

const base = `https://identitytoolkit.googleapis.com/admin/v2/projects/${projectId}/config`;

async function call(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`\n✖ HTTP ${res.status} — ${url}`);
    console.error(body.slice(0, 900));
    if (res.status === 403) {
      console.error(
        "\nThe service account lacks permission for the Identity Toolkit admin API. Grant it the\n" +
          '"Firebase Authentication Admin" role in the Google Cloud console (IAM), or add the domain\n' +
          "by hand: Firebase Console → Authentication → Settings → Authorized domains.",
      );
    }
    process.exit(1);
  }
  return JSON.parse(body);
}

const before = (await call(base)).authorizedDomains ?? [];
console.log(`Project: ${projectId}`);
console.log("\nAuthorized domains:");
for (const d of before) console.log("  •", d);

if (toAdd.length === 0) {
  console.log("\n(no --add given — nothing changed)");
  process.exit(0);
}

const missing = toAdd.filter((d) => !before.includes(d));
if (missing.length === 0) {
  console.log("\n✅ Already authorized — nothing to add.");
  process.exit(0);
}

await call(`${base}?updateMask=authorizedDomains`, {
  method: "PATCH",
  body: JSON.stringify({ authorizedDomains: [...before, ...missing] }),
});

const after = (await call(base)).authorizedDomains ?? [];
console.log(`\n✅ Added: ${missing.join(", ")}`);
console.log("\nAuthorized domains now:");
for (const d of after) console.log("  •", d);
