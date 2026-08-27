import { useState } from "react";
import type { User } from "firebase/auth";
import { db } from "../firebase";
import { completePvc, startPvc, updatePvcEstimate } from "../lib/orderStatus";
import { formatDateTimeDMY } from "../lib/dates";
import type { Order, UserDoc } from "../types/domain";
import { DurationPicker } from "./DurationPicker";

type Actor = { user: User; userData: UserDoc };
type Mode = "idle" | "start" | "reestimate";

/**
 * PVC worker's "ПВХ жұмысын бастау" / "ПВХ дайын" action block — mirror of
 * CuttingActionsPanel, minus the confirmed-sheets input (PVC work doesn't consume warehouse
 * stock, so completePvc needs no quantity, just a confirmation).
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
  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);

  if (order.productionStatus === "pvc_queue") {
    if (mode === "start") {
      return (
        <DurationPicker
          confirmLabel="Бастау"
          busy={busy}
          onCancel={() => setMode("idle")}
          onConfirm={async (minutes) => {
            setBusy(true);
            try {
              await startPvc(db, actor, order, minutes);
              onToast(`✅ ПВХ жұмысы басталды (шамамен ${minutes} мин)`);
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
        🧩 ПВХ жұмысын бастау
      </button>
    );
  }

  if (order.productionStatus === "pvc_started") {
    if (mode === "reestimate") {
      return (
        <DurationPicker
          confirmLabel="Сақтау"
          busy={busy}
          onCancel={() => setMode("idle")}
          onConfirm={async (minutes) => {
            setBusy(true);
            try {
              await updatePvcEstimate(db, actor, order, minutes);
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
      if (!confirm(`${order.orderNumber} тапсырысын ПВХ дайын деп белгілейсіз бе?`)) return;
      setBusy(true);
      try {
        const result = await completePvc(db, actor, order);
        onToast(result.alreadyCompleted ? "Бұл заказ бұрын аяқталған" : "✅ ПВХ жұмысы аяқталды, заказ дайын");
      } catch (err: unknown) {
        onToast("Қате: " + (err as Error).message);
      } finally {
        setBusy(false);
      }
    };

    return (
      <div className="cutting-actions-panel">
        {order.pvcExpectedCompletionAt && (
          <div className="track-card-meta-row">
            <span>Аяқталу мерзімі: {formatDateTimeDMY(order.pvcExpectedCompletionAt)}</span>
          </div>
        )}
        <div className="wizard-actions">
          <button className="btn btn-primary" disabled={busy} onClick={handleComplete}>
            ✅ ПВХ дайын
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
