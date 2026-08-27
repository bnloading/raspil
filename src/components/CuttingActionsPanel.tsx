import { useState } from "react";
import type { User } from "firebase/auth";
import { db } from "../firebase";
import { completeCutting, startCutting, updateCuttingEstimate } from "../lib/orderStatus";
import { formatDateTimeDMY } from "../lib/dates";
import type { Order, UserDoc } from "../types/domain";
import { DurationPicker } from "./DurationPicker";

type Actor = { user: User; userData: UserDoc };
type Mode = "idle" | "start" | "reestimate";

/**
 * Cutter's "Распилді бастау" / "Распил дайын" action block — shared by CutterDashboard's cards
 * and ProductionOrderDetail so the same 40-ish lines of duration-picker/confirm/idempotency
 * handling isn't copy-pasted in both places. Renders nothing once the order has moved past
 * cutting_started (nothing left for a cutter to do there).
 */
export function CuttingActionsPanel({
  order,
  actor,
  needsPvc,
  onToast,
}: {
  order: Order;
  actor: Actor;
  needsPvc: boolean;
  onToast: (msg: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);
  const [confirmedSheets, setConfirmedSheets] = useState(String(order.confirmedSheets ?? order.estimatedSheets));

  if (order.productionStatus === "cutting_queue") {
    if (mode === "start") {
      return (
        <DurationPicker
          confirmLabel="Бастау"
          busy={busy}
          onCancel={() => setMode("idle")}
          onConfirm={async (minutes) => {
            setBusy(true);
            try {
              await startCutting(db, actor, order, minutes);
              onToast(`✅ Распил басталды (шамамен ${minutes} мин)`);
              setMode("idle");
            } catch (err: unknown) {
              onToast("Қате: " + (err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
      );
    }
    return (
      <button className="btn btn-primary btn-full" onClick={() => setMode("start")}>
        🔪 Распилді бастау
      </button>
    );
  }

  if (order.productionStatus === "cutting_started") {
    if (mode === "reestimate") {
      return (
        <DurationPicker
          confirmLabel="Сақтау"
          busy={busy}
          onCancel={() => setMode("idle")}
          onConfirm={async (minutes) => {
            setBusy(true);
            try {
              await updateCuttingEstimate(db, actor, order, minutes);
              onToast(`⏱ Жаңа мерзім: ${minutes} мин`);
              setMode("idle");
            } catch (err: unknown) {
              onToast("Қате: " + (err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
      );
    }

    const handleComplete = async () => {
      const sheets = parseInt(confirmedSheets, 10);
      if (!Number.isFinite(sheets) || sheets <= 0) {
        onToast("Расталған лист санын дұрыс енгізіңіз");
        return;
      }
      if (!confirm(`${order.orderNumber} тапсырысын Распил дайын деп белгілейсіз бе? Расталған лист: ${sheets}`)) {
        return;
      }
      setBusy(true);
      try {
        const result = await completeCutting(db, actor, order, sheets, needsPvc);
        onToast(result.alreadyConsumed ? "Бұл заказ бұрын аяқталған" : "✅ Распил аяқталды");
      } catch (err: unknown) {
        onToast("Қате: " + (err as Error).message);
      } finally {
        setBusy(false);
      }
    };

    return (
      <div className="cutting-actions-panel">
        {order.cuttingExpectedCompletionAt && (
          <div className="track-card-meta-row">
            <span>Аяқталу мерзімі: {formatDateTimeDMY(order.cuttingExpectedCompletionAt)}</span>
          </div>
        )}
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
          <button className="btn btn-primary" disabled={busy} onClick={handleComplete}>
            ✅ Распил дайын
          </button>
          <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => setMode("reestimate")}>
            ⏱ Мерзімді өзгерту
          </button>
        </div>
      </div>
    );
  }

  return null;
}
