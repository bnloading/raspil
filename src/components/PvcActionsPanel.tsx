import { useState } from "react";
import type { User } from "firebase/auth";
import { db } from "../firebase";
import { completePvcLine, startPvcLine, updatePvcEstimateLine } from "../lib/orderStatus";
import { jobsOf, needsPvc as jobNeedsPvc } from "../lib/orderLines";
import { formatDateTimeDMY } from "../lib/dates";
import type { Order, OrderLineJob, UserDoc } from "../types/domain";
import { DurationPicker } from "./DurationPicker";

type Actor = { user: User; userData: UserDoc };
type Mode = "idle" | "start" | "reestimate";

/**
 * PVC worker's "ПВХ жұмысын бастау" / "ПВХ дайын" action block — mirror of
 * CuttingActionsPanel, one row per banded material line. Lines with no ПВХ metres are never a
 * PVC worker's business and are skipped entirely (see lib/orderLines.needsPvc). PVC work consumes
 * no warehouse stock, so completion needs no quantity, just a confirmation.
 */
export function PvcActionsPanel({
  order,
  actor,
  onToast,
}: {
  order: Order;
  actor: Actor;
  onToast: (msg: string) => void;
}) {
  if (order.productionStatus !== "pvc_queue" && order.productionStatus !== "pvc_started") return null;

  const jobs = jobsOf(order).filter(jobNeedsPvc);
  if (jobs.length === 0) return null;

  return (
    <div className="cutting-actions-panel">
      {jobs.map((job) => (
        <PvcLineRow key={job.index} order={order} job={job} actor={actor} onToast={onToast} />
      ))}
    </div>
  );
}

function PvcLineRow({
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

  if (job.pvcCompletedAt) {
    return (
      <div className="cutting-line-row is-done">
        <span className="cutting-line-material">{job.materialName}</span>
        <span className="jt-pill jt-tone-green">✓ ПВХ дайын</span>
      </div>
    );
  }

  if (!job.pvcStartedAt) {
    if (mode === "start") {
      return (
        <div className="cutting-line-row">
          <span className="cutting-line-material">{job.materialName} · {job.pvcMeters} м ПВХ</span>
          <DurationPicker
            confirmLabel="Бастау"
            busy={busy}
            onCancel={() => setMode("idle")}
            onConfirm={async (minutes) => {
              setBusy(true);
              try {
                await startPvcLine(db, actor, order, job.index, minutes);
                onToast(`✅ ${job.materialName} — ПВХ басталды`);
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
        <span className="cutting-line-material">{job.materialName} · {job.pvcMeters} м ПВХ</span>
        <button className="btn btn-primary btn-sm" onClick={() => setMode("start")}>
          🧩 Бастау
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
              await updatePvcEstimateLine(db, actor, order, job.index, minutes);
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
    if (!confirm(`${job.materialName}: ПВХ дайын деп белгілейсіз бе?`)) return;
    setBusy(true);
    try {
      const result = await completePvcLine(db, actor, order, job.index);
      onToast(result.alreadyCompleted ? "Бұл материал бұрын аяқталған" : `✅ ${job.materialName} — ПВХ аяқталды`);
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
        {job.pvcExpectedCompletionAt && (
          <span className="otable-sub">Мерзімі: {formatDateTimeDMY(job.pvcExpectedCompletionAt)}</span>
        )}
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
