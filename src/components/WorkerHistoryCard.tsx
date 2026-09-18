import { Link } from "react-router-dom";
import type { Material, MdfStage, Order } from "../types/domain";
import { workerJobs, type FloorStage } from "../lib/workerQuantities";
import { formatDateDMY } from "../lib/dates";
import { formatMdfArea } from "../lib/mdfJournal";
import { WorkerMaterialSummary } from "./WorkerMaterialSummary";

/** Personal history is a compact record; production controls belong in the queue. */
export function WorkerHistoryCard({ order, stage, uid, to, materials = [] }: {
  order: Order; stage: FloorStage | MdfStage; uid: string; to: string; materials?: Material[];
}) {
  const floor = stage === "cutting" || stage === "pvc";
  const jobs = floor ? workerJobs(order, stage, uid, true) : [];
  const completedAt = floor
    ? jobs.map(j => stage === "cutting" ? j.cuttingCompletedAt : j.pvcCompletedAt).filter(t => !!t).sort((a, b) => b.seconds - a.seconds)[0]
    : order.mdfStageJobs?.[stage]?.completedAt;
  const sheets = jobs.reduce((sum, j) => sum + (j.confirmedSheets ?? j.sheetQty), 0);
  const meters = jobs.reduce((sum, j) => sum + j.pvcMeters, 0);
  const quantity = floor ? `${sheets.toLocaleString("kk-KZ")} лист${stage === "pvc" ? ` · ${meters.toLocaleString("kk-KZ", { maximumFractionDigits: 1 })} м` : ""}` : formatMdfArea(order.mdfAreaM2);
  return <details className="station-history-card">
    <summary>
      <span className="station-history-check" aria-hidden="true">✓</span>
      <span className="station-history-identity"><strong>{order.orderNumber}</strong><span>{order.customerName}</span></span>
      <span className="station-history-volume"><strong>{quantity}</strong><time>{completedAt ? formatDateDMY(completedAt) : "Орындалды"}</time></span>
      <span className="station-history-chevron" aria-hidden="true">⌄</span>
    </summary>
    <div className="station-history-details">
      {floor ? <WorkerMaterialSummary order={order} stage={stage} materials={materials} uid={uid} history /> : <p>{order.mdfFilmColor || "Түс көрсетілмеген"} · {quantity}</p>}
      <Link to={to} className="station-detail-link">Тапсырысты ашу <span aria-hidden="true">→</span></Link>
    </div>
  </details>;
}
