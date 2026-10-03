// A cutter's pay for what the saw actually cut, settled the way the owner settles распил
// (2026-10-03): from one order number on — «№234-тен бастап» — counting only the lines that were
// cut, never what a journal row merely says, and never a struck-off row.
//
//   node --env-file=.env.local scripts/cutter-pay.mjs 234         # №234 onward (this year's numbers)
//   node --env-file=.env.local scripts/cutter-pay.mjs 234 328     # №234–№328
//
// Read-only: writes nothing.
//
// Counted: each line of a live ЛДСП-journal order in the range that the saw confirmed
// (cuttingCompletedAt), at its confirmed count, for whoever cut it, in the shop's three groups
// (lib/salary.ts cutCounts) — лист (ЛДСП, черновой, МДФ, сырттан келетін, Эггер, остаток), ХДФ and
// столешница — each at that cutter's own rate from salaryRules (lib/salary.ts pieceRateLines).
//
// Not counted, but printed so nothing is left out or let in unseen:
//   - struck-off, merged and draft rows, with a ⚠ for one that was cut
//   - lines in the range not cut yet
//   - lines of an earlier order cut after the range's first cut: №231's 5 sheets were cut on 28.09
//     at 18:22, after that Monday's payout, and are owed only if that payout left them out
//   - Касса expenses in the cutter's name, in those weeks, that are not on his payslip as advances
//
// Then the advances filed against the weeks the cuts fall in, and what is left to hand over.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const [fromArg, toArg] = process.argv.slice(2);
const FROM = Number(fromArg);
const TO = toArg === undefined ? Infinity : Number(toArg);
if (!Number.isInteger(FROM) || FROM < 1 || (toArg !== undefined && !(Number.isInteger(TO) && TO >= FROM))) {
  console.error("Қолданылуы: node --env-file=.env.local scripts/cutter-pay.mjs <№басы> [№соңы]");
  process.exit(1);
}

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

// Asia/Almaty is UTC+5 all year (no DST), so shifting the clock is exact.
const local = (date) => new Date(date.getTime() + 5 * 3600e3);
const when = (date) => local(date).toISOString().slice(0, 16).replace("T", " ");
const dayMonth = (isoDay) => `${isoDay.slice(8, 10)}.${isoDay.slice(5, 7)}`;
/** The Monday opening the Almaty week a moment falls in — lib/dates.ts weekKey. */
const weekKey = (date) => {
  const d = local(date);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const weekDays = (monday) => Array.from({ length: 7 }, (_, i) => {
  const d = new Date(`${monday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
});
const tenge = (tiyn) => `${(tiyn / 100).toLocaleString("ru-RU")} ₸`;
// The counter restarts every year (lib/orderNumber.ts), so a bare «№234» is this year's.
const YEAR = local(new Date()).getUTCFullYear();
const parseNumber = (orderNumber) => {
  const m = /^ORD-(\d{4})-(\d+)$/.exec(orderNumber ?? "");
  return m ? { year: Number(m[1]), n: Number(m[2]) } : null;
};

// --- what a line is (lib/lineCategory.ts) and what it pays (lib/salary.ts)
const categoryById = new Map();
for (const d of (await db.collection("materials").get()).docs) {
  if (d.data().category) categoryById.set(d.id, d.data().category);
}
const words = (text) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** The catalogue's category; for a material since deleted, the name the line was typed under. */
function lineCategory(line) {
  const known = categoryById.get(line.materialId);
  if (known) return known;
  const name = line.materialName ?? "";
  if (/столешниц/i.test(name)) return "countertop";
  const named = words(name);
  return named.includes("хдф") || named.includes("hdf") ? "hdf" : "ldsp";
}
/** measureWork's four kinds: anything not ХДФ, столешница or МДФ is paid as ЛДСП. */
const kindOf = (line) => {
  const c = lineCategory(line);
  return c === "hdf" || c === "countertop" || c === "mdf" ? c : "ldsp";
};
const noKinds = () => ({ ldsp: 0, mdf: 0, hdf: 0, countertop: 0 });

const rules = new Map((await db.collection("salaryRules").get()).docs.map((d) => [d.data().userId, d.data()]));
/** Each kind at its own rate, falling back to the sheet rate — pieceRateLines. */
function ratesOf(rule) {
  const base = rule?.perSheetTiyn ?? 0;
  return { ldsp: base, mdf: rule?.perMdfSheetTiyn ?? base, hdf: rule?.perHdfSheetTiyn ?? base, countertop: rule?.perCountertopTiyn ?? base };
}
const payOf = (kinds, rates) => Object.keys(kinds).reduce((s, k) => s + kinds[k] * rates[k], 0);
/** МДФ shares the «Лист» line while it is cut for the sheet rate, as the shop counts it. */
function payLines(kinds, rates) {
  const boards = rates.mdf === rates.ldsp
    ? [["Лист", kinds.ldsp + kinds.mdf, rates.ldsp]]
    : [["ЛДСП", kinds.ldsp, rates.ldsp], ["МДФ", kinds.mdf, rates.mdf]];
  return [...boards, ["ХДФ", kinds.hdf, rates.hdf], ["Столешница", kinds.countertop, rates.countertop]];
}

// --- an order's lines and their saw jobs (lib/orderMerge.ts linesOf, lib/orderLines.ts jobsOf)
const linesOf = (o) => (o.items?.length ? o.items : [{
  materialId: o.materialId, materialName: o.materialSnapshot?.name ?? "", sheetQty: o.confirmedSheets ?? o.estimatedSheets ?? 0,
}]);
/** The order's own line jobs, or derived for an order older than them (buildLineJobs). */
function jobsOf(o) {
  if (o.lineJobs?.length) return o.lineJobs;
  const lines = linesOf(o);
  return lines.map((l) => ({
    materialId: l.materialId, materialName: l.materialName, sheetQty: l.sheetQty,
    ...(o.cuttingCompletedAt ? {
      cuttingCompletedAt: o.cuttingCompletedAt, cuttingByUid: o.assignedCutterId, cuttingByName: o.assignedCutterName,
      confirmedSheets: lines.length === 1 ? (o.confirmedSheets ?? l.sheetQty) : l.sheetQty,
    } : {}),
  }));
}
const sheetsOf = (job) => job.confirmedSheets ?? job.sheetQty ?? 0;
const struckOff = (o) =>
  o.productionStatus === "cancelled" ? "өшірілген"
  : o.mergedIntoOrderId ? "біріктірілген"
  : o.productionStatus === "draft" ? "draft"
  : null;

const orders = (await db.collection("orders").get()).docs
  .map((d) => ({ id: d.id, ...d.data(), num: parseNumber(d.data().orderNumber) }))
  .filter((o) => o.num && o.orderKind !== "mdf_wrap") // the МДФ journal has no saw lines
  .sort((a, b) => a.num.year - b.num.year || a.num.n - b.num.n);
const inRange = orders.filter((o) => o.num.year === YEAR && o.num.n >= FROM && o.num.n <= TO);
const earlier = orders.filter((o) => o.num.year < YEAR || (o.num.year === YEAR && o.num.n < FROM));
if (inRange.length === 0) {
  console.log(`№${FROM}${TO === Infinity ? "" : `–№${TO}`} (${YEAR}): заказ жоқ.`);
  process.exit(0);
}
const lastNumber = inRange.at(-1).num.n;

// --- the range
const cutters = new Map();
const cutterOf = (uid, name) => {
  if (!cutters.has(uid)) cutters.set(uid, { name: name ?? uid ?? "Кескені белгісіз", kinds: noKinds(), weeks: new Set(), first: null, last: null, orders: new Set(), late: [] });
  return cutters.get(uid);
};
const offRows = [];
const notCut = [];
for (const o of inRange) {
  const off = struckOff(o) ?? (o.cutWorkVoided ? "cutWorkVoided" : null);
  if (off) {
    offRows.push({ o, off, cut: jobsOf(o).filter((j) => j.cuttingCompletedAt) });
    continue;
  }
  for (const job of jobsOf(o)) {
    if (!job.cuttingCompletedAt) {
      if (sheetsOf(job) > 0) notCut.push({ o, job });
      continue;
    }
    const c = cutterOf(job.cuttingByUid, job.cuttingByName);
    const at = job.cuttingCompletedAt.toDate();
    c.kinds[kindOf(job)] += sheetsOf(job);
    c.weeks.add(weekKey(at));
    c.orders.add(o.num.n);
    if (!c.first || at < c.first) c.first = at;
    if (!c.last || at > c.last) c.last = at;
  }
}
for (const o of earlier) {
  if (struckOff(o) || o.cutWorkVoided) continue;
  for (const job of jobsOf(o)) {
    const c = job.cuttingCompletedAt && cutters.get(job.cuttingByUid);
    if (c && job.cuttingCompletedAt.toDate() >= c.first) c.late.push({ o, job });
  }
}

const advances = (await db.collection("advances").get()).docs.map((d) => d.data()).filter((a) => !a.reversed);
const expenses = (await db.collection("expenses").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const expenseById = new Map(expenses.map((e) => [e.id, e]));

console.log(`\n№${FROM}–№${TO === Infinity ? lastNumber : TO} (${YEAR}), ЛДСП журналы — тек кесілгені`);
for (const [uid, c] of cutters) {
  const rule = rules.get(uid);
  const rates = ratesOf(rule);
  const earned = payOf(c.kinds, rates);
  console.log(`\n━━ ${c.name} ━━  ${when(c.first)} – ${when(c.last)}, ${c.orders.size} заказ`);
  if (!rule || !rule.perSheetTiyn) console.log("  ⚠ Айлық ережесінде лист бағасы жоқ — сомалар 0 болып шығады");
  else if (rule.mode !== "PER_SHEET" && rule.mode !== "MIXED") console.log(`  ⚠ Айлық ережесі ${rule.mode}, лист бойынша емес`);
  for (const [label, qty, rate] of payLines(c.kinds, rates)) {
    console.log(`  ${label.padEnd(11)} ${String(qty).padStart(4)} × ${tenge(rate).padStart(7)} = ${tenge(qty * rate).padStart(11)}`);
  }
  console.log(`  ${"Барлығы".padEnd(30)} ${tenge(earned).padStart(11)}`);

  const weeks = [...c.weeks].sort();
  const mine = advances
    .filter((a) => a.userId === uid && c.weeks.has(a.periodKey))
    // The Касса day the cash left, for one paid from there — paidAt is when it was put on the payslip.
    .map((a) => {
      const at = a.paidAt ?? a.createdAt;
      return { ...a, day: expenseById.get(a.expenseId)?.date ?? (at ? local(at.toDate()).toISOString().slice(0, 10) : a.periodKey) };
    })
    .sort((a, b) => a.day.localeCompare(b.day));
  const given = mine.reduce((s, a) => s + a.amountTiyn, 0);
  console.log(`  Аванс (апта ${weeks.map(dayMonth).join(", ")}):${mine.length ? "" : " жоқ"}`);
  for (const a of mine) console.log(`    ${dayMonth(a.day)}  ${tenge(a.amountTiyn).padStart(11)}  ${a.note ?? ""}`);
  console.log(`  ${"Берілгені".padEnd(30)} ${tenge(given).padStart(11)}`);
  const left = earned - given;
  console.log(`  ${(left >= 0 ? "ҚАЛДЫҚ — беру керек" : "АРТЫҚ АЛҒАН").padEnd(30)} ${tenge(Math.abs(left)).padStart(11)}`);

  if (c.late.length) {
    console.log(`  ⚠ №${FROM}-ден бұрынғы заказ, бірақ ${when(c.first)}-ден кейін кесілген — санға кірмеді.`);
    console.log("    Алдыңғы төлемге кірмесе, қосыңыз:");
    for (const { o, job } of c.late) {
      const kind = kindOf(job);
      console.log(`    №${o.num.n} ${o.customerName} — ${job.materialName} ×${sheetsOf(job)} — ${when(job.cuttingCompletedAt.toDate())} — ${tenge(sheetsOf(job) * rates[kind])}`);
    }
  }
  const firstName = words(c.name)[0];
  const days = new Set(weeks.flatMap(weekDays));
  const unlinked = expenses.filter((e) => !e.advanceId && days.has(e.date)
    && (e.paidToUid === uid || (firstName && words(`${e.name ?? ""} ${e.comment ?? ""}`).includes(firstName))));
  if (unlinked.length) {
    console.log(`  ⚠ Кассада «${c.name}» атымен, бірақ айлыққа аванс болып жазылмаған — санға кірмеді.`);
    console.log("    Алдыңғы апта төлемі болса, ескермеңіз; осы аптаның ақшасы болса, шегеріңіз:");
    for (const e of unlinked.sort((a, b) => a.date.localeCompare(b.date))) {
      console.log(`    ${dayMonth(e.date)}  ${tenge(e.amountTiyn).padStart(11)}  ${e.name}${e.comment ? ` · ${e.comment}` : ""}`);
    }
  }
}

console.log("\nӨшірілген / біріктірілген жолдар — санға кірмеді:");
if (offRows.length === 0) console.log("  жоқ");
for (const { o, off, cut } of offRows) {
  const lines = linesOf(o).filter((l) => l.sheetQty > 0).map((l) => `${l.materialName} ×${l.sheetQty}`).join(", ") || "бос жол";
  const sheets = cut.reduce((s, j) => s + sheetsOf(j), 0);
  const state = cut.length === 0 ? "кесілмеген"
    : o.cutWorkVoided ? "кесілген, бірақ қайта жазылған — екі рет есептелмейді"
    : `⚠ ${sheets} лист кесілген — санға кірмеді, бірақ қолданбаның Айлық бетінде бар`;
  console.log(`  №${o.num.n} ${o.customerName} [${off}] ${lines} — ${state}`);
}

console.log("\nӘлі кесілмеген — санға кірмеді:");
if (notCut.length === 0) console.log("  жоқ");
const waiting = noKinds();
for (const { o, job } of notCut) {
  waiting[kindOf(job)] += sheetsOf(job);
  console.log(`  №${o.num.n} ${o.customerName} [${o.productionStatus}] ${job.materialName} ×${sheetsOf(job)}`);
}
if (notCut.length) {
  const only = cutters.size === 1 ? ratesOf(rules.get([...cutters.keys()][0])) : null;
  const sum = [["лист", waiting.ldsp + waiting.mdf], ["ХДФ", waiting.hdf], ["столешница", waiting.countertop]]
    .filter(([, q]) => q > 0).map(([l, q]) => `${q} ${l}`).join(" · ");
  console.log(`  Барлығы: ${sum}${only ? ` — кесілсе +${tenge(payOf(waiting, only))}` : ""}`);
}
