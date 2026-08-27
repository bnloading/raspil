# Цех Трекер — Furniture Cutting Workshop Management System

React 19 + TypeScript + Vite SPA, backed entirely by Firebase (Firestore + Auth). No custom
server — RBAC and atomicity are enforced by `firestore.rules` and Firestore client transactions
(see [Architecture assumptions](#architecture-assumptions--limitations) for why, and what that
trades off against a Cloud Functions backend).

## Install & run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build       # tsc + vite build -> dist/
npm run preview     # serve the production build locally
```

## Environment variables

Copy `.env.example` to `.env.local` and fill in your Firebase project's web config (Firebase
Console → Project Settings → Web App). The app falls back to the original hardcoded config if
these are absent, so it keeps working without any `.env.local` — but set them for a project of
your own. `.env.local` is gitignored; never commit real values other than the (non-secret)
Firebase web config.

## Firebase project setup

This repo now ships `firestore.rules` and `firestore.indexes.json`, which were **not** deployed as
part of this change (deploying touches your live project, so it's left to you):

```bash
npm install -g firebase-tools   # if not already installed
firebase login
firebase use --add              # pick your Firebase project, alias it e.g. "default"
firebase deploy --only firestore:rules,firestore:indexes
```

**Do this before anyone uses the app for real** — without the rules deployed, Firestore falls back
to whatever rules are already configured in your project (likely wide open, since none were in
this repo before). Once deployed, all the RBAC/data-isolation behavior described below is enforced
server-side, not just hidden in the UI.

## Seeding reference data & test accounts

```bash
npm install -g firebase-tools  # for the emulator, optional
# 1. Download a service account key: Firebase Console > Project Settings > Service Accounts
# 2. Fill out .env.local per .env.example (FIREBASE_SERVICE_ACCOUNT_PATH + SEED_* vars)
node --env-file=.env.local scripts/seed.mjs
```

This seeds: payment methods (Нал, Kaspi, Pay, Нұр, Бәлім, Аралас), `applicationSettings/global`,
two sample materials with costs, three PVC types, and one account per role — **change the
SEED_*_PASSWORD values before running against a real project.**

| Role | Sign in with | Home route |
|---|---|---|
| Admin (Админ) | `SEED_ADMIN_EMAIL` / password | `/admin` |
| Manager (Менеджер) | `SEED_MANAGER_EMAIL` / password | `/manager` |
| Cutter (Распилшик) | `SEED_CUTTER_EMAIL` / password | `/cutting` |
| PVC (ПВХ жабыстырушы) | `SEED_PVC_EMAIL` / password | `/pvc` |
| Customer (Клиент) | `SEED_CUSTOMER_PHONE` / password | `/dashboard` |

Customers can also self-register at `/register` with just name + phone + password — no seeding
needed for that role.

## Tests

```bash
npm test           # Vitest — pricing/PVC-metres/payment-status/statuses/dashboardStats unit tests
npm run lint        # ESLint
npm run test:rules  # Firestore security-rules tests against the local emulator (needs Java)
```

`test:rules` wraps Vitest with `firebase emulators:exec`, spins up a local Firestore emulator, and
asserts the RBAC rules directly — customer isolation, the payment gate (unpaid/partially-paid
orders can never enter the cutting queue, Admin-only override), cutter/PVC never seeing unpaid
orders, cutter blocked from payments, PVC blocked from warehouse, Manager blocked from user
management/audit-log reading/payment reversal, the cutting-consumption transaction's exact required
shape (including the cutter's reservation lookup), blocked users losing access, etc. Verified
passing (37/37) in this environment; requires a JRE on your machine (the emulator is a Java
process) — none of the other npm scripts need Java.

## Data model & migration notes

There's no SQL migration step — Firestore is schemaless, and `firestore.indexes.json` declares the
composite indexes the app's queries need (deployed via the command above; Firestore will also
offer a direct console link if a query ever needs an index that's missing).

**If this project already has orders in the old flat schema** (`clientName`, `items[]`,
`raspilDone`/`pvhDone`, no `orderNumber`/`productionStatus`/pricing) from before this change: they
are not compatible with the new UI, which expects the schema in `src/types/domain.ts`. Nothing in
this change reads or writes the old shape anymore. Back up and clear the `orders` collection (and
the old `sheets` collection, replaced by `materials`) before treating this as production-ready, or
write a one-off migration script if that history needs to be preserved — not included here, since
the actual field mapping (customer identity, pricing, PVC edges) doesn't exist in the old data.

## Architecture assumptions & limitations

Documented here per the "safest standard option" principle — these are the concrete trade-offs of
building this on Firestore rules + client transactions instead of a Cloud Functions backend (a
deliberate choice — Cloud Functions require upgrading the Firebase project off the free Spark plan
to pay-as-you-go Blaze billing, which isn't something to enable without asking):

- **No true adversarial server-side price validation.** A customer's own `draft`/`submitted` order
  totals are computed client-side (shared `src/lib/pricing.ts`). The trust boundary is Admin
  approval: the moment Admin acts on an order, Admin's own recalculation (same pricing engine)
  overwrites the customer's numbers, and `firestore.rules` then blocks the customer from touching
  financial fields at all. A customer could in principle submit a manipulated total on their own
  unapproved draft — it can't reach payment or production without Admin's own numbers replacing it.
- **Stock-consumption idempotency is real and tested** (`consumeForCutting` in
  `src/lib/warehouse.ts`, backed by a Firestore transaction with a `cuttingConsumedAt` guard, and
  by `firestore.rules` restricting the cutter's write to that exact `cutting → cut` transition).
  What Firestore rules can't fully close, absent server code: a compromised/malicious *staff*
  account could still call the Firestore SDK directly to forge `cuttingConsumedAt` without the
  matching stock movement existing — mitigated by the immutable `inventoryMovements` ledger being
  admin-auditable and cross-checkable, but not physically prevented. Closing this fully needs
  Cloud Functions holding sole write access to those fields.
- **Purchase price is hidden from customers** by splitting it into a separate `materialCosts`
  collection (admin-only), since Firestore rules can't redact individual fields within one document
  for different readers.
- **Customer auth uses phone + password**, not Firebase's SMS phone-auth (that also needs Blaze).
  Registration synthesizes a stable, deterministic fake email (`<phone>@customers.workshop.local`)
  as the Auth identifier; this is also what gives duplicate-phone registration its rejection, for
  free, via Firebase Auth's own email-uniqueness constraint. Customers without a real email on file
  can't self-service a password reset — they contact Admin.
- **No PDF generation** — the spec allows this when the project doesn't already have it. Order
  specs are "exported" via the browser's native print (`window.print()` + a print stylesheet).
  CSV/XLSX export are real (native CSV, `xlsx`/SheetJS for `.xlsx`).
- **Charts are hand-rolled inline SVG** (`src/components/BarChart.tsx`), not a charting library —
  there were only a handful of bar charts to justify.
- **Discount is a flat ₸ amount**, not a percentage — the spec didn't specify which, and a flat
  amount is the simpler, less error-prone default.
- **Cutting service price is a single configurable per-sheet rate** (`applicationSettings.global.
  cuttingPricePerSheetTiyn`, editable only by directly editing that Firestore doc today — there's
  no settings UI for it yet), not a per-material or per-part rate.
- **Audit log omits IP address** — there's no server to observe the real client IP.
- **Skeleton loaders are simplified to a spinner** (`src/components.tsx`'s `Spinner`) throughout,
  rather than per-page bespoke skeletons.
- **Drag-and-drop queue reorder is implemented** (native HTML5 drag events, see `QueueReorder` in
  `src/pages/admin/AdminOrders.tsx`, visible when filtering orders to "Кезекте").
- **The existing UI is a bottom-tab mobile-first layout, not a sidebar admin panel** — that's kept
  as-is (preserving the existing design) rather than introducing an unrelated sidebar/drawer
  pattern the spec describes only as one possible option ("Responsive sidebar. Mobile drawer.").
- **Leaderboard is gated to Admin only; Reports/audit-log are Admin+Manager** — the original app's
  Leaderboard was a fully public, unauthenticated page listing every customer's order activity;
  under the RBAC model that's exactly the cross-customer data exposure the rest of this change
  closes elsewhere (`/` used to be a public, unauthenticated listing of every order — now it's an
  authenticated, per-customer dashboard). Manager can view Reports (spec: Manager sees its own
  payment history) but not the Audit Log itself (spec explicitly withholds that from Manager) or
  user/staff management (`/setup` degrades to read-only for Manager — `firestore.rules` blocks the
  writes, not just the UI).
- **Four pre-existing orders predate this schema entirely** (`clientName`/`items[]`/`queue` fields,
  no `orderNumber`/`productionStatus`) — real customer records from before this rewrite. They're
  defensively skipped everywhere (`isCurrentSchemaOrder` guards in `useOrders.ts`/`useOrderDetail.ts`)
  so they can't crash any list/detail view, but they are **not migrated, archived, or visible
  anywhere in the new UI** — that's a decision for whoever owns that data (migrate the four orders
  by hand, or confirm they're safe to discard) that this change deliberately didn't make unasked.
- **The invoice PDF binary is generated on demand, not stored remotely.** `renderInvoicePdf()`
  produces a real `.pdf` file in the browser via pdfmake; what Firestore holds is the immutable
  invoice *snapshot*, not the bytes. Persisting the file itself would need Firebase Storage, which
  requires leaving the Spark plan. Because every figure in the snapshot is frozen, regenerating
  always yields the same document — the customer's download and the Manager's are the same
  invoice. The UI never claims the binary is stored remotely. Nothing claims to send email or
  WhatsApp either, because no such integration is configured.
- **Salary mode is MANUAL by default, deliberately.** The engine measures work and attendance but
  computes a zero base until you supply the real formula; the amount is an audited Admin
  adjustment. The other six modes are implemented and unit-tested but not switched on for anyone.
- **Windows-1251 CSV encoding is offered in the template UI but not implemented** — re-encoding
  arbitrary Unicode into a single-byte codepage needs a fully-verified 256-entry table with no
  native browser API to lean on; getting one entry wrong would silently corrupt Cyrillic text,
  which is worse than not supporting the option. It currently falls back to UTF-8-with-BOM, which
  modern Excel on Windows opens correctly anyway (`src/lib/exportTable.ts`'s `exportCuttingCsv`).

## What's genuinely wired end-to-end (not mocked)

Real Firestore reads/writes and real Firebase Auth throughout: customer registration/login
(phone-based) and staff login (email-based), the 4-step order builder (material → parts → PVC
edges → confirm) with live PVC-metres and totals computed by the same engine used for confirmation,
draft save / submit / duplicate / cancel, Admin approve/reject/assign/reprioritize/status-override/
print, the cutter and PVC production queues with start/estimate/complete actions, the atomic
once-only stock-consumption transaction on "Кесілді", manual receipts/corrections/leftover-piece
tracking in the warehouse, payments (including reversal) with automatically computed payment status
and debt, in-app notifications (order status, assignment, low stock) with read/unread state, the
admin-only audit log, and the reports/dashboard tab (dynamic day/week/month bucketing — no
hardcoded calendar) with CSV/XLSX export.

## Strict 16-status workflow (Draft → Delivered)

`src/types/domain.ts`'s `ProductionStatus` and `src/lib/statuses.ts`/`src/lib/orderStatus.ts` are
the source of truth: `draft → submitted → manager_review → price_calculated → waiting_payment →
partially_paid/paid → cutting_queue → cutting_started → cutting_completed → pvc_queue → pvc_started
→ pvc_completed → ready → delivered` (plus `cancelled`). `paymentStatus` is a separate,
always-derived field (`computePaymentStatus`), never set directly.

**The payment gate is enforced twice**: client-side (`canEnterCuttingQueue`) and, authoritatively,
in `firestore.rules` (`enteringCuttingQueue()`/`paymentGateOk()` on the `orders` update rule) — a
Manager's `updateDoc` to `cutting_queue` on an unpaid/partially-paid order is rejected by Firestore
itself, not just hidden in the UI. Only Admin's unconditional branch may override it, and the app
requires a typed reason before attempting that write, which is then stored on the order
(`paymentGateOverride`/`paymentGateOverrideReason`) and as a dedicated `auditLogs` entry.

Every status change is written through `src/lib/orderStatus.ts`, which appends an immutable
`orders/{id}/statusHistory` entry (previous/new status, actor, timestamp, optional comment/estimate)
and an `auditLogs` entry for price/payment/override actions — nothing updates `productionStatus`
via a bare `updateDoc` outside that module except the two owner-only draft/cancel paths in
`OrderBuilder.tsx`/`OrderDetail.tsx`/`CustomerOrders.tsx`, which `firestore.rules` restricts to
`draft/submitted → cancelled` only.

## Manager order journal — "ЛДСП — ТАПСЫРЫС ЖУРНАЛЫ"

`/manager/journal` (`src/pages/manager/ManagerJournal.tsx`) is the Manager's primary working
surface: a dense 23-column spreadsheet ledger rather than a dashboard. Layout notes:

- The table fills the working area via a column flexbox on `.app-content.full` — the toolbar,
  pagination row and summary bar keep their natural height and the table body absorbs the rest, so
  there are no magic pixel offsets to drift when the header or nav changes height.
- `№` and `Клиент аты` are frozen (`position: sticky; left`) while the money columns scroll;
  verified still on screen after scrolling ~900px right.
- Column groups are tinted by meaning (`--jt-tint-material` / `-pvc` / `-total` / `-pay` / `-debt`)
  and row height/cell padding/font come from `--jt-*` tokens, so density is tunable in one place.
- On phones (<768px) the table is replaced outright by compact cards (`.journal-cards`) that open
  the full-screen order editor — a 23-column grid is never squeezed onto a phone, and the page
  never scrolls sideways.

**Arithmetic** lives in `src/lib/journal.ts` as pure functions (`computeJournalRowTotals`,
`netPaidTiyn`, `paidByMethod`, `computeCustomerDebts`), so a row's live preview while editing and
the value actually written to Firestore come from the same code path — a cell can never display one
total and save another. Covered by 23 tests in `src/lib/journal.test.ts`, including the reference
design's own row (37 лист × 16 500 ₸ + 625 м × 270 ₸ = 779 250 ₸).

**Walk-in orders**: the highlighted new row creates an order with no customer account, keyed to the
customer by phone for debt roll-up. `firestore.rules` lets a Manager create orders but only with
`paidTiyn == 0` and only into a pre-production status — so a Manager can neither mint an order that
is already paid (every tenge still goes through the transactional, audited `recordPayment`) nor
drop one straight into the cutting queue, bypassing the payment gate.

## Public workshop board ("Цех жұмысы")

Every signed-in customer sees a live board of everything currently on the shop floor:
`Заказ № · Кезек · Распил · ПВХ · Дайын · Уақыт`, with completed stages turning green and the
viewer's own rows tagged "Сіздің заказыңыз".

Privacy is structural, not cosmetic. The board reads a separate `workshopActivity` collection
whose documents carry **only** order number, stage, queue position, needs-PVC and an estimate —
no customerId, name, phone, price, debt or dimensions. A customer recognises their own row by
matching order numbers they already own, so ownership needs no field on the shared document at
all. `firestore.rules` allows any signed-in user to read it and only staff to write it, and a
rules test asserts that no identifying field is present on a board row.

Rows are kept in sync by `syncWorkshopBoard()` in `src/lib/workshopActivity.ts`, called from every
transition in `lib/orderStatus.ts`. An order joins the board when it enters the cutting queue and
leaves when it is delivered or cancelled. Orders that were already in production before the board
existed are backfilled by `node --env-file=.env.local scripts/backfill-workshop-board.mjs`.

## Debt ("Қарыз")

Derived, never stored. `computeCustomerDebts()` in `src/lib/journal.ts` folds orders into
per-customer balances, so the Manager ledger (`/manager/debt`), the customer's own page
(`/debt`), the journal and the order detail can never disagree with each other. Two details worth
knowing:

- Cancelled and draft orders are excluded — a cancelled order owes nothing.
- An overpaid order does **not** offset a different order's real debt; only positive per-order
  balances add up. Netting them would understate what is genuinely outstanding.
- Walk-in orders (no customer account) are keyed by phone number, so they roll up onto the same
  customer card as that customer's online orders.

## Invoices ("Накладной")

`/invoice/:orderId`. A Manager issues an invoice, which writes an **immutable financial snapshot**
to the `invoices` collection — frozen copies of the line items and totals, never live references,
so reprinting an old invoice shows what was actually agreed at the time. Issuing again creates a
new version rather than editing the previous one; `firestore.rules` lets an update touch only the
`sentToCustomer` flag and forbids deletion outright.

"Клиентке жіберу" publishes it to the customer's account and raises an in-app notification. Until
then the invoice is a draft the customer cannot read — enforced by the rule, which requires both
`customerId == uid()` and `sentToCustomer == true`.

**PDF**: the invoice is a styled document inside `.print-area`, so "PDF жүктеу / Басып шығару"
uses the browser's own print → "Save as PDF". See Limitations for why there is no server-rendered
PDF binary.

## Attendance and salary

`/admin/attendance` is the daily register (Келді / Кешікті / Келмеді / Демалыс / Ауырып қалды plus
check-in/check-out times) with a monthly per-employee summary. Records are keyed
`${userId}_${date}`, so re-marking a day updates it instead of creating a duplicate.

`/admin/salary` configures each worker's rule and recalculates a month from measured work.
**The default mode is MANUAL and stays MANUAL until you provide the real formula** — MANUAL
measures the work honestly (sheets cut, PVC metres, orders, days, hours) but computes a base of
zero, so nothing is invented; the amount is entered as an Admin adjustment, which always requires
a reason and is immutable once written. The other modes (FIXED_MONTHLY, PER_SHEET, PER_PVC_METER,
PER_ORDER, HOURLY, MIXED) are implemented and tested, ready to switch on per worker.

Work is credited by **completion date** (`cuttingCompletedAt` / `pvcCompletedAt`), never by order
creation or payment date — so a January order finished in February counts in February, and new
months appear on their own with no calendar list to maintain.

Workers see only their own pay and attendance (`/salary`, `/my-attendance`); the queries are
uid-scoped and `firestore.rules` refuses anyone else's documents — a Manager cannot read a
worker's salary either.

## Dimensions & bulk PVC editor

`src/components/BulkPartsEditor.tsx`, used as step 2 of the customer order builder. Dimensions and
PVC edges are **one** step, not two: marking edges for many parts at once is the point, so a
separate per-part pass afterwards would reintroduce exactly the one-at-a-time workflow it replaces.

Built for 100–200 parts:

- **Windowed rendering** — only the visible rows plus a small overscan are in the DOM. Verified
  with 200 parts on a 375px viewport: **13 DOM rows**, recycling as you scroll (`ROW_H` in the
  component must stay in sync with `.bulk-row`'s height in `index.css`).
- **Multi-select** with "Барлығын таңдау", which acts on the *currently visible* rows so it
  composes with search and filtering instead of silently reaching hidden ones.
- **Bulk actions**: 4 жағына · Ұзын 2 жағына · Қысқа 2 жағына · ПВХ жоқ · Алдыңғы қатардан көшіру,
  plus PVC type application, duplicate and delete.
- **Per-row A/B/C/D buttons** for direct edge toggling; tapping a row expands it for name, size,
  quantity and grain.
- **Search** by name or dimensions (`720x450`, `720 × 450`, or either number) and a PVC-state filter.
- **Autosave** to `localStorage`, offered back on return; cleared once the order is submitted.

All edge logic lives in `src/lib/pvcBulk.ts` as pure functions (30 tests). Edge geometry follows
`lib/pricing.ts`'s convention exactly — A/C run along the width, B/D along the length — so "Ұзын 2
жағына" picks B/D on a tall part and A/C on a wide one, and the PVC metre totals stay correct.

## CSV / Excel export for the cutting program

**Multiple named templates**, managed by Admin at `/admin/csv-settings`
(`src/pages/admin/AdminCsvSettings.tsx`, collection `csvTemplates`) — one per saw or program, e.g.
"Cutting негізгі", "Пила №1", "Excel формат". Create, rename, edit, duplicate, set default,
archive and delete, with a live preview against the most recent real order.

Each template stores: name · column set and order · per-column custom header names · delimiter
(`,`/`;`) · encoding · headers on/off · **dimension unit** (мм/см/м) · **length/width order** ·
**PVC column mapping** (four A/B/C/D columns, or one combined `"A,B,D"` column).

Two behaviours worth knowing:

- **Length/width order swaps the column headings, never the values.** A part's length stays its
  length; only which heading it prints under changes. Swapping the numbers would silently corrupt
  every cut.
- **PVC thickness always stays in millimetres**, even when parts export in metres — edging is
  universally specified in mm (0.4/1/2) and converting it would mislead the operator.

Managers pick a template before exporting from the order detail page
(`src/components/CuttingExportPanel.tsx`: CSV жүктеу · Excel жүктеу · Размерлерді көшіру · Алдын
ала қарау). Every cell is escaped, and any value starting with `=`, `+`, `-`, `@` is prefixed with
an apostrophe to prevent formula injection — including custom header names, and in every template
mode (20 tests in `src/lib/exportTable.test.ts`). Default output is UTF-8 with BOM.

## Invoice PDF

`src/lib/invoicePdf.ts` produces a **real downloadable `.pdf`** via pdfmake, loaded on demand so
~1 MB stays out of the main bundle.

pdfmake's built-in fonts are Latin-only, so Noto Sans (SIL OFL) is bundled in
`src/assets/fonts/` and registered explicitly. This is what makes **Ә Ғ Қ Ң Ө Ұ Ү Һ І**, Russian
Cyrillic and **₸** render as real glyphs rather than blank boxes — nothing depends on a font being
installed on the viewer's machine. `scripts/verify-invoice-pdf.mjs` checks the embedded font and
asserts every one of those codepoints is present in the PDF's ToUnicode map.

Manager buttons: **Накладной PDF жасау · PDF жүктеу · Клиентке жіберу · Басып шығару**.
"Клиентке жіберу" attaches the invoice record to the customer's account and raises an in-app
notification; the customer can then download the identical PDF themselves. See Limitations for
where the binary does and does not live.

## Mobile bottom navigation

Fixed in this change: `src/components/layout/icons.tsx`'s shared SVG props now set explicit
`width="24" height="24"` (previously unset, so icons fell back to the browser's ~300×150px default
intrinsic SVG size), and `src/index.css`'s `.bottom-nav-item`/`.bottom-nav-icon`/`.track-fab` were
rewritten with real pixel sizing and 44×44px minimum touch targets. A separate mobile-only bug —
any `.detail-layout` page (order detail, for every role) blowing out past the viewport width on
narrow screens because a grid item's automatic minimum size followed its content's (the parts
table's) intrinsic width — is fixed via `.detail-layout > * { min-width: 0; }`; the table itself
already scrolls locally inside `.parts-table-wrap{overflow-x:auto}`. Verified at 375px for
customer/manager/cutter order-detail pages with `document.documentElement.scrollWidth` matching the
viewport width exactly (no horizontal scroll).

## Build & test status (last verified in this environment)

- `npm run build` — passes
- `npx tsc --noEmit` — no errors
- `npm run lint` — no errors
- `npm test` (Vitest, 112 tests: journal arithmetic/mixed payments/customer debt/salary engine/attendance/pricing/PVC-metres/payment-status/statuses/dashboardStats/money/phone/date-bucketing) — all pass
- `npm run test:rules` (71 Firestore-rules tests against the local emulator) — all pass, covering
  the payment gate, customer isolation, board anonymity, invoice delivery, and salary/attendance
  per-worker scoping
- Full manual walkthrough via browser automation of one real order through the entire non-PVC
  lifecycle (customer submits → manager reviews/prices/publishes → customer sees price → manager
  records payment → payment gate opens → manager queues → cutter starts with a 5-minute estimate →
  customer sees the live ETA → cutter completes → stock decrements exactly once → customer sees
  "Дайын") as Test Client / Test Manager / Test Cutter, on both desktop and 375px mobile widths.
