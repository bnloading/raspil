import type { ReactNode } from "react";
import type { Material, Order, OrderLineJob } from "../types/domain";
import { jobsOf, needsPvc as jobNeedsPvc } from "../lib/orderLines";
import { isCountertopJob, jobQuantities, workerJobs, type FloorStage } from "../lib/workerQuantities";

const number = (n: number) => n.toLocaleString("kk-KZ", { maximumFractionDigits: 2 });
export function WorkerHistorySummary({ orders, materials, stage, uid }: { orders: Order[]; materials: Material[]; stage: FloorStage; uid: string }) {
  const jobsWithQuantities = orders.flatMap(
    order => workerJobs(order, stage, uid, true).map(job => ({ job, q: jobQuantities(order, job, materials) })),
  );
  // Split apart, same as WorkerHistoryCard's own badge — a столешница is a different unit of work
  // from a board, so folding both into one "лист" total answered a question nobody was asking.
  const sheets = jobsWithQuantities.reduce((sum, { job, q }) => sum + (isCountertopJob(job, materials) ? 0 : q.sheets), 0);
  const countertops = jobsWithQuantities.reduce((sum, { job, q }) => sum + (isCountertopJob(job, materials) ? q.sheets : 0), 0);
  // Raspil is paid per sheet, not per m² — area only matters (and is only shown) on the ПВХ station.
  const showArea = stage !== "cutting";
  const area = jobsWithQuantities.some(({ q }) => q.area === null)
    ? null
    : jobsWithQuantities.reduce((sum, { q }) => sum + (q.area ?? 0), 0);
  const pvc = jobsWithQuantities.reduce((sum, { q }) => sum + q.pvcMeters, 0);
  return <section className="worker-history-summary"><h2>Мен орындаған жұмыс</h2><p>{orders.filter(o => workerJobs(o, stage, uid, true).length).length} тапсырыс · {jobsWithQuantities.length} материал</p><div className="worker-quantities"><span><b>{number(sheets)}</b> лист</span>{countertops > 0 && <span><b>{number(countertops)}</b> столеш</span>}{showArea && <span><b>{area === null ? "—" : number(area)}</b> м² лист</span>}<span><b>{number(pvc)}</b> м ПВХ</span></div>{showArea && area === null && <small>Кейбір материалдардың лист өлшемі көрсетілмеген</small>}</section>;
}
export function WorkerMaterialSummary({ order, materials, stage, uid, history = false, action }: {
  order: Order; materials: readonly Material[]; stage: FloorStage; uid: string; history?: boolean;
  /** Per-material control (e.g. the cutter's "Бастау" button) rendered inside that material's own card. */
  action?: (job: OrderLineJob) => ReactNode;
}) {
  // The ПВХ station only ever handles lines that actually carry edging. A merged order's ХДФ or
  // МДФ row has no ПВХ on it at all — listing it here put materials on the edge-bander's card
  // that were never their job, and left them looking for tape to stick on a sheet that needs none.
  // The cutter, by contrast, cuts every line, so nothing is filtered there.
  const jobs = history
    ? workerJobs(order, stage, uid, true)
    : jobsOf(order).filter((job) => stage !== "pvc" || jobNeedsPvc(job));
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
        {/* Manager-set on the journal line (ManagerJournal.tsx). This is an instruction to run an
            extra pass on the machine, not a label — as a small pill among the metres it was being
            read straight past, so it gets a band of its own directly above the button that starts
            the work. */}
        {stage === "pvc" && job.pvcJointed && (
          <div className="worker-material-jointed">⚠️ ПРИФУГОВКА КЕРЕК</div>
        )}
        {status && <small>{status}</small>}
        {action?.(job)}
      </div>;
    })}
  </div>;
}
