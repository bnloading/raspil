import { useState } from "react";
import type { User } from "firebase/auth";
import { db } from "../firebase";
import { completeMdfStage, startMdfStage } from "../lib/mdfOrderStatus";
import { formatMdfArea } from "../lib/mdfJournal";
import { formatDateTimeDMY } from "../lib/dates";
import { MDF_STAGE_LABELS } from "../types/domain";
import type { MdfStage, Order, UserDoc } from "../types/domain";
import { DurationPicker } from "./DurationPicker";

type Actor = { user: User; userData: UserDoc };
type Mode = "idle" | "start";

/**
 * One worker station's "{Кезең} бастау" / "Дайын" action block for a МДФ order — the mirror of
 * CuttingActionsPanel/PvcActionsPanel, but ONE component parameterized by `stage` instead of one
 * hand-written pair per station, since a МДФ order is always a single job (no per-line loop needed)
 * and the 4 stations are genuinely the same operation repeated. Renders nothing once the order has
 * moved off this station — mdfStage already points elsewhere the instant this station completes.
 */
export function MdfStageActionsPanel({
  order,
  stage,
  actor,
  onToast,
}: {
  order: Order;
  stage: MdfStage;
  actor: Actor;
  onToast: (msg: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);

  if (order.productionStatus !== "mdf_production" || order.mdfStage !== stage) return null;
  const job = order.mdfStageJobs?.[stage];
  const label = MDF_STAGE_LABELS[stage];

  if (!job?.startedAt) {
    if (mode === "start") {
      return (
        <div className="cutting-line-row">
          <span className="cutting-line-material">
            {label} · {formatMdfArea(order.mdfAreaM2)}
          </span>
          <DurationPicker
            confirmLabel="Бастау"
            busy={busy}
            onCancel={() => setMode("idle")}
            onConfirm={async (minutes) => {
              setBusy(true);
              try {
                await startMdfStage(db, actor, order, stage, minutes);
                onToast(`✅ ${label} басталды`);
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
        <span className="cutting-line-material">
          {label} · {order.mdfAreaM2 ?? 0} м²
        </span>
        <button className="btn btn-primary btn-sm" onClick={() => setMode("start")}>
          🧩 Бастау
        </button>
      </div>
    );
  }

  const handleComplete = async () => {
    if (!confirm(`${label}: дайын деп белгілейсіз бе?`)) return;
    setBusy(true);
    try {
      await completeMdfStage(db, actor, order, stage);
      onToast(`✅ ${label} аяқталды`);
    } catch (err: unknown) {
      onToast("Қате: " + (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cutting-line-row is-active">
      <div className="cutting-line-head">
        <span className="cutting-line-material">{label}</span>
        {job.expectedCompletionAt && <span className="otable-sub">Мерзімі: {formatDateTimeDMY(job.expectedCompletionAt)}</span>}
      </div>
      <div className="wizard-actions">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={handleComplete}>
          ✅ Дайын
        </button>
      </div>
    </div>
  );
}
