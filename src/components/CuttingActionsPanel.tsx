import { useState } from "react";
import type { User } from "firebase/auth";
import { db } from "../firebase";
import { completeCuttingLine, startCuttingLine, updateCuttingEstimateLine } from "../lib/orderStatus";
import { jobsOf, needsPvc as jobNeedsPvc } from "../lib/orderLines";
import { formatDateTimeDMY } from "../lib/dates";
import type { Order, OrderLineJob, UserDoc } from "../types/domain";
import { DurationPicker } from "./DurationPicker";

type Actor = { user: User; userData: UserDoc };
type Mode = "idle" | "start" | "reestimate";

/**
 * Cutter's "Распилді бастау" / "Распил дайын" action block — one row per material line, each with
 * its own start/finish. A merged order ("10 лист ЛДСП Ақ + 3 лист ХДФ") is two jobs on the shop
 * floor, and the cutter starts and confirms whichever one is on the saw first — the two lines do
 * not have to be worked in order, or finished together.
 *
 * Renders nothing once the order has moved past cutting entirely (every line already confirmed —
 * see lib/orderLines.allCuttingDone, which is what advances the order past cutting_started).
 */
export function CuttingActionsPanel({
  order,
  actor,
  onToast,
}: {
  order: Order;
  actor: Actor;
  onToast: (msg: string) => void;
}) {
  if (order.productionStatus !== "cutting_queue" && order.productionStatus !== "cutting_started") return null;

  const jobs = jobsOf(order);
  return (
    <div className="cutting-actions-panel">
      {jobs.map((job) => (
        <CuttingLineRow key={job.index} order={order} job={job} actor={actor} onToast={onToast} />
      ))}
    </div>
  );
}

function CuttingLineRow({
  order,
  job,
  actor,
  onToast,
}: {
  order: Order;
  job: OrderLineJob;
  actor: Actor;
  onToast: (msg: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);
  const [confirmedSheets, setConfirmedSheets] = useState(String(job.confirmedSheets ?? job.sheetQty));

  const meta = `${job.sheetQty} лист${jobNeedsPvc(job) ? ` · ${job.pvcMeters} м ПВХ` : ""}`;

  if (job.cuttingCompletedAt) {
    return (
      <div className="cutting-line-row is-done">
        <span className="cutting-line-material">{job.materialName}</span>
        <span className="jt-pill jt-tone-green">✓ Кесілді — {job.confirmedSheets} лист</span>
      </div>
    );
  }

  if (!job.cuttingStartedAt) {
    if (mode === "start") {
      return (
        <div className="cutting-line-row">
          <span className="cutting-line-material">{job.materialName} · {meta}</span>
          <DurationPicker
            confirmLabel="Бастау"
            busy={busy}
            onCancel={() => setMode("idle")}
            onConfirm={async (minutes) => {
              setBusy(true);
              try {
                await startCuttingLine(db, actor, order, job.index, minutes);
                onToast(`✅ ${job.materialName} — распил басталды`);
              } catch (err: unknown) {
                onToast("Қате: " + (err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
        </div>
      );
    }
    return (
      <div className="cutting-line-row">
        <span className="cutting-line-material">{job.materialName} · {meta}</span>
        <button className="btn btn-primary btn-sm" onClick={() => setMode("start")}>
          🔪 Бастау
        </button>
      </div>
    );
  }

  if (mode === "reestimate") {
    return (
      <div className="cutting-line-row">
        <span className="cutting-line-material">{job.materialName}</span>
        <DurationPicker
          confirmLabel="Сақтау"
          busy={busy}
          onCancel={() => setMode("idle")}
          onConfirm={async (minutes) => {
            setBusy(true);
            try {
              await updateCuttingEstimateLine(db, actor, order, job.index, minutes);
              onToast(`⏱ ${job.materialName}: жаңа мерзім ${minutes} мин`);
              setMode("idle");
            } catch (err: unknown) {
              onToast("Қате: " + (err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>
    );
  }

  const handleComplete = async () => {
    const sheets = parseInt(confirmedSheets, 10);
    if (!Number.isFinite(sheets) || sheets <= 0) {
      onToast("Расталған лист санын дұрыс енгізіңіз");
      return;
    }
    if (!confirm(`${job.materialName}: ${sheets} лист кесілді деп белгілейсіз бе?`)) return;
    setBusy(true);
    try {
      const result = await completeCuttingLine(db, actor, order, job.index, sheets);
      onToast(result.alreadyCompleted ? "Бұл материал бұрын аяқталған" : `✅ ${job.materialName} — распил аяқталды`);
    } catch (err: unknown) {
      onToast("Қате: " + (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cutting-line-row is-active">
      <div className="cutting-line-head">
        <span className="cutting-line-material">{job.materialName}</span>
        {job.cuttingExpectedCompletionAt && (
          <span className="otable-sub">Мерзімі: {formatDateTimeDMY(job.cuttingExpectedCompletionAt)}</span>
        )}
      </div>
      <div className="form-group">
        <label>Расталған лист саны</label>
        <input
          type="number"
          className="form-input"
          min={1}
          value={confirmedSheets}
          onChange={(e) => setConfirmedSheets(e.target.value)}
        />
      </div>
      <div className="wizard-actions">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={handleComplete}>
          ✅ Дайын
        </button>
        <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => setMode("reestimate")}>
          ⏱ Мерзімді өзгерту
        </button>
      </div>
    </div>
  );
}
