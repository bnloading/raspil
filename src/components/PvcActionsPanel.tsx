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
 * PVC worker's "ПВХ жұмысын бастау" / "ПВХ дайын" action block for the order-detail page — one
 * row per banded material line, each labelled with what it is since nothing else on that page
 * lists the materials. The dashboard card gets the same per-line control straight from
 * PvcLineActions instead, threaded into WorkerMaterialSummary's `action` slot and unlabelled,
 * because the material card it sits in already says what it is — the same shape распил has.
 *
 * Lines with no ПВХ metres are never a PVC worker's business and are skipped entirely (see
 * lib/orderLines.needsPvc). PVC work consumes no warehouse stock, so completion needs no
 * quantity, just a confirmation.
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
        <PvcLineActions key={job.index} order={order} job={job} actor={actor} onToast={onToast} showLabel />
      ))}
    </div>
  );
}

export function PvcLineActions({
  order,
  job,
  actor,
  onToast,
  showLabel = false,
  layout = "row",
}: {
  order: Order;
  job: OrderLineJob;
  actor: Actor;
  onToast: (msg: string) => void;
  /** Include the material name — for a context, like the order-detail page, where nothing else
   *  already lists the materials. */
  showLabel?: boolean;
  /** "hero" is the ПВХ panel's headline card: the remaining time on its own line with a pencil to
   *  change it, and one full-width "ПВХ дайын" underneath. Same actions, laid out to be hit with
   *  a thumb rather than read off a row. */
  layout?: "row" | "hero";
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);

  const label = showLabel ? (
    <span className="cutting-line-material">
      {job.materialName}
      {job.pvcCompletedAt ? "" : ` · ${job.pvcMeters} м ПВХ`}
      {/* The order page lists materials itself, so the jointing instruction has to travel with
          the name here too — the dashboard's copy lives in WorkerMaterialSummary. */}
      {job.pvcJointed && <span className="jt-pill jt-tone-red"> Прифуговка</span>}
    </span>
  ) : null;

  if (job.pvcCompletedAt) {
    if (!showLabel) return null;
    return (
      <div className="cutting-line-row is-done">
        {label}
        <span className="jt-pill jt-tone-green">✓ ПВХ дайын</span>
      </div>
    );
  }

  if (!job.pvcStartedAt) {
    if (mode === "start") {
      return (
        <div className="cutting-line-row">
          {label}
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
        {label}
        <button className="btn btn-primary btn-sm" onClick={() => setMode("start")}>
          🧩 Бастау
        </button>
      </div>
    );
  }

  if (mode === "reestimate") {
    return (
      <div className="cutting-line-row">
        {label}
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

  if (layout === "hero") {
    // Minutes left rather than a clock time: "Мерзімі: 24.09.2026, 17:40" makes the worker do the
    // subtraction, and the answer they want is "how long have I got".
    const leftMin = job.pvcExpectedCompletionAt
      ? Math.round((job.pvcExpectedCompletionAt.toMillis() - Date.now()) / 60000)
      : null;
    return (
      <>
        {leftMin !== null && (
          <div className="station-hero-time">
            <span>🕐 Қалған уақыт: <b>{leftMin > 0 ? `${leftMin} мин` : "мерзімі өтті"}</b></span>
            <button type="button" className="station-hero-edit" disabled={busy}
              onClick={() => setMode("reestimate")} aria-label="Мерзімді өзгерту">✎</button>
          </div>
        )}
        <button className="btn btn-primary station-hero-done" disabled={busy} onClick={handleComplete}>
          ✓ ПВХ дайын
        </button>
      </>
    );
  }

  return (
    <div className="cutting-line-row is-active">
      {(label || job.pvcExpectedCompletionAt) && (
        <div className="cutting-line-head">
          {label}
          {job.pvcExpectedCompletionAt && (
            <span className="otable-sub">Мерзімі: {formatDateTimeDMY(job.pvcExpectedCompletionAt)}</span>
          )}
        </div>
      )}
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
