import { useWorkshopActivity } from "../hooks/useWorkshopActivity";
import type { WorkshopActivityEntry, WorkshopBoardStage } from "../types/domain";

interface StageCell {
  label: string;
  tone: "green" | "blue" | "amber" | "muted";
}

/** Per-stage indicator for one board row. Completed stages go green, exactly as the spec requires. */
function cuttingCell(stage: WorkshopBoardStage): StageCell {
  switch (stage) {
    case "queue":
      return { label: "Кезекте", tone: "amber" };
    case "cutting":
      return { label: "Кесіліп жатыр", tone: "blue" };
    default:
      return { label: "Кесілді ✓", tone: "green" };
  }
}

function pvcCell(stage: WorkshopBoardStage, needsPvc: boolean): StageCell {
  if (!needsPvc) return { label: "ПВХ жоқ", tone: "muted" };
  switch (stage) {
    case "queue":
    case "cutting":
      return { label: "Распил күтілуде", tone: "muted" };
    case "pvc_wait":
      return { label: "ПВХ кезегінде", tone: "amber" };
    case "pvc":
      return { label: "ПВХ жасалып жатыр", tone: "blue" };
    default:
      return { label: "ПВХ дайын ✓", tone: "green" };
  }
}

function readyCell(stage: WorkshopBoardStage): StageCell {
  return stage === "ready" ? { label: "Дайын ✓", tone: "green" } : { label: "Дайын емес", tone: "amber" };
}

/** Remaining minutes for whichever stage is actually running, or null when nothing is in progress. */
function remainingMinutes(entry: WorkshopActivityEntry): number | null {
  if (entry.estimatedMinutes <= 0 || !entry.startedAt) return null;
  const elapsed = Math.floor((Date.now() - entry.startedAt.toMillis()) / 60000);
  return Math.max(0, entry.estimatedMinutes - elapsed);
}

/** Public display code — the trailing digits only, so the board never advertises volume or
 *  lets one customer infer anything about another's order beyond its position. */
function publicCode(orderNumber: string): string {
  const digits = orderNumber.match(/(\d+)$/)?.[1];
  return digits ? `#A-${digits.slice(-3)}` : orderNumber;
}

/**
 * "Цех жұмысы" — the live, anonymized workshop board every signed-in customer can see. Rows carry
 * no name/phone/price/dimensions (see WorkshopActivityEntry); the viewer's own orders are
 * highlighted purely by matching order numbers they already own, passed in via `myOrderNumbers`.
 */
export function WorkshopActivityBoard({ myOrderNumbers = [] }: { myOrderNumbers?: string[] }) {
  const { entries, loading } = useWorkshopActivity();
  const mine = new Set(myOrderNumbers);

  if (loading) return null;

  const counts = {
    queue: entries.filter((e) => e.stage === "queue").length,
    cutting: entries.filter((e) => e.stage === "cutting").length,
    pvc: entries.filter((e) => e.stage === "pvc_wait" || e.stage === "pvc").length,
    ready: entries.filter((e) => e.stage === "ready").length,
  };

  return (
    <section className="panel-card workshop-board">
      <div className="panel-head">
        <h3>Цех жұмысы</h3>
        <span className="workshop-board-live">● Деректер автоматты жаңарады</span>
      </div>

      <div className="workshop-board-counts">
        <div className="workshop-count"><b>{counts.queue}</b><span>Кезекте</span></div>
        <div className="workshop-count is-blue"><b>{counts.cutting}</b><span>Распилде</span></div>
        <div className="workshop-count is-amber"><b>{counts.pvc}</b><span>ПВХ-да</span></div>
        <div className="workshop-count is-green"><b>{counts.ready}</b><span>Дайын</span></div>
      </div>

      {entries.length === 0 ? (
        <p className="workshop-board-empty">Қазір цехта белсенді заказ жоқ.</p>
      ) : (
        <div className="workshop-board-scroll">
          <table className="workshop-board-table">
            <thead>
              <tr>
                <th>Заказ №</th>
                <th>Кезек</th>
                <th>Распил</th>
                <th>ПВХ</th>
                <th>Дайын</th>
                <th>Уақыт</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const isMine = mine.has(e.orderNumber);
                const cut = cuttingCell(e.stage);
                const pvc = pvcCell(e.stage, e.needsPvc);
                const ready = readyCell(e.stage);
                const mins = remainingMinutes(e);
                return (
                  <tr key={e.id} className={isMine ? "is-mine" : ""}>
                    <td>
                      <span className="workshop-code">{publicCode(e.orderNumber)}</span>
                      {isMine && <span className="workshop-mine-tag">Сіздің заказыңыз</span>}
                    </td>
                    <td>{e.stage === "queue" ? `№${e.queuePosition + 1}` : "—"}</td>
                    <td><span className={`jt-pill jt-tone-${cut.tone}`}>{cut.label}</span></td>
                    <td><span className={`jt-pill jt-tone-${pvc.tone}`}>{pvc.label}</span></td>
                    <td><span className={`jt-pill jt-tone-${ready.tone}`}>{ready.label}</span></td>
                    <td className="workshop-time">{mins === null ? "—" : `${mins} мин`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
