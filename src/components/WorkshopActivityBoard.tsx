import { Link } from "react-router-dom";
import { useWorkshopActivity } from "../hooks/useWorkshopActivity";
import { boardProgress, boardSummary } from "../lib/boardProgress";
import { formatMoney } from "../lib/money";
import type { Order, WorkshopActivityEntry } from "../types/domain";

/** What each state draws in its circle — mirrors OrderProgress so the two strips read alike. */
const GLYPH: Record<string, string> = { done: "✓", active: "", problem: "!", pending: "", skipped: "–" };

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
 * "Цех жұмысы" — the live workshop board every signed-in customer can see, as cards with the same
 * progress strip the order lists use.
 *
 * The board itself is anonymous by construction: WorkshopActivityEntry carries no name, phone,
 * price or dimensions, so a row about someone else's order can only ever show a short public code
 * and which stage it is at. The viewer's OWN rows are matched by order number against orders they
 * already hold, and only those are enriched with the sum and sheet count — data they own anyway.
 * That is why `myOrders` is passed in rather than the board fetching anything richer.
 */
export function WorkshopActivityBoard({ myOrders = [] }: { myOrders?: Order[] }) {
  const { entries, loading } = useWorkshopActivity();
  const mineByNumber = new Map(myOrders.map((o) => [o.orderNumber, o]));

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
        <div className="ocards workshop-cards">
          {entries.map((e) => {
            const own = mineByNumber.get(e.orderNumber);
            const steps = boardProgress(e.stage, e.needsPvc);
            const mins = remainingMinutes(e);
            const card = (
              <>
                <div className="ocard-top">
                  <span className="otable-num">{own ? own.orderNumber : publicCode(e.orderNumber)}</span>
                  <span className="otable-sub">{mins === null ? "" : `${mins} мин`}</span>
                </div>

                {/* Only the viewer's own rows carry money and sheet counts. */}
                {own && (
                  <div className="ocard-mid">
                    <span className="otable-strong">
                      {own.confirmedSheets ?? own.estimatedSheets ?? 0} лист
                      {own.pvcMetersTotal > 0 && ` · ${Number(own.pvcMetersTotal.toFixed(2))} м ПВХ`}
                    </span>
                    <span className="otable-money">{formatMoney(own.totalTiyn)}</span>
                  </div>
                )}

                <div className="ocard-meta">
                  <span className="otable-sub">{boardSummary(e.stage, e.queuePosition)}</span>
                  {own && <span className="workshop-mine-tag">Сіздің заказыңыз</span>}
                </div>

                <div className="oprog">
                  {steps.map((step, i) => (
                    <div className="oprog-step" key={step.key}>
                      {i > 0 && <span className={`oprog-line is-${steps[i - 1].state}`} aria-hidden="true" />}
                      <span className={`oprog-dot is-${step.state}`}>{GLYPH[step.state]}</span>
                      <span className="oprog-label">{step.label}</span>
                    </div>
                  ))}
                </div>
              </>
            );

            // Someone else's row is not a link — there is nothing the viewer may open.
            return own ? (
              <Link key={e.id} to={`/order/${own.id}`} className="ocard is-mine">
                {card}
                <span className="ocard-chev" aria-hidden="true">›</span>
              </Link>
            ) : (
              <div key={e.id} className="ocard">{card}</div>
            );
          })}
        </div>
      )}

    </section>
  );
}
