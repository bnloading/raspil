import type { ReactNode } from "react";
import type { Material, Order, OrderLineJob } from "../types/domain";
import { jobsOf } from "../lib/orderLines";
import { jobQuantities, workerJobs, type FloorStage } from "../lib/workerQuantities";

const number = (n: number) => n.toLocaleString("kk-KZ", { maximumFractionDigits: 2 });
export function WorkerHistorySummary({ orders, materials, stage, uid }: { orders: Order[]; materials: Material[]; stage: FloorStage; uid: string }) {
  const totals = orders.flatMap(order => workerJobs(order, stage, uid, true).map(job => jobQuantities(order, job, materials)));
  const sheets = totals.reduce((sum, q) => sum + q.sheets, 0);
  // Raspil is paid per sheet, not per m² — area only matters (and is only shown) on the ПВХ station.
  const showArea = stage !== "cutting";
  const area = totals.some(q => q.area === null) ? null : totals.reduce((sum, q) => sum + (q.area ?? 0), 0);
  const pvc = totals.reduce((sum, q) => sum + q.pvcMeters, 0);
  return <section className="worker-history-summary"><h2>Мен орындаған жұмыс</h2><p>{orders.filter(o => workerJobs(o, stage, uid, true).length).length} тапсырыс · {totals.length} материал</p><div className="worker-quantities"><span><b>{number(sheets)}</b> лист</span>{showArea && <span><b>{area === null ? "—" : number(area)}</b> м² лист</span>}<span><b>{number(pvc)}</b> м ПВХ</span></div>{showArea && area === null && <small>Кейбір материалдардың лист өлшемі көрсетілмеген</small>}</section>;
}
export function WorkerMaterialSummary({ order, materials, stage, uid, history = false, action }: {
  order: Order; materials: readonly Material[]; stage: FloorStage; uid: string; history?: boolean;
  /** Per-material control (e.g. the cutter's "Бастау" button) rendered inside that material's own card. */
  action?: (job: OrderLineJob) => ReactNode;
}) {
  const jobs = history ? workerJobs(order, stage, uid, true) : jobsOf(order);
  // Raspil is paid per sheet, not per m² — area only matters (and is only shown) on the ПВХ station.
  const showArea = stage !== "cutting";
  return <div className="worker-materials" aria-label="Материалдар мен жұмыс көлемі">
    {jobs.map(job => {
      const q = jobQuantities(order, job, materials);
      const done = stage === "cutting" ? job.cuttingCompletedAt : job.pvcCompletedAt;
      // A no-op "Жоспарланған көлем" line on every not-yet-started material was pure filler — the
      // action button right below it already says "not done". Only worth a line when there is
      // something to actually report: it finished, or its area is unknown.
      const areaWarning = showArea && q.area === null ? "Лист өлшемі көрсетілмеген" : "";
      const status = done ? ["✓ Орындалды", areaWarning].filter(Boolean).join(" · ") : areaWarning;
      return <div className="worker-material" key={job.index}>
        <div className="worker-material-head">
          <strong>{job.materialName || "Материал"}</strong>
          <span className="worker-quantities">
            <span><b>{number(q.sheets)}</b> лист</span>
            {showArea && <span><b>{q.area === null ? "—" : number(q.area)}</b> м²</span>}
            {q.pvcMeters > 0 && <span><b>{number(q.pvcMeters)}</b> м ПВХ</span>}
          </span>
        </div>
        {/* Manager-set on the journal line (ManagerJournal.tsx) — a red flag telling the PVC
            worker to actually do the extra jointing pass on this material, not just a label. */}
        {stage === "pvc" && job.pvcJointed && <span className="jt-pill jt-tone-red">Прифуговка</span>}
        {status && <small>{status}</small>}
        {action?.(job)}
      </div>;
    })}
  </div>;
}
