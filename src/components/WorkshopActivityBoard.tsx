import { useState } from "react";
import { Link } from "react-router-dom";
import { useWorkshopActivity } from "../hooks/useWorkshopActivity";
import { boardProgress, boardSummary, customersAhead } from "../lib/boardProgress";
import { formatMdfArea } from "../lib/mdfJournal";
import { StageIcon } from "./StageIcon";
import { sheetSummary } from "../lib/journalColumns";
import { linesOf } from "../lib/orderMerge";
import { customerOrderCode } from "../lib/orderCode";
import type { Order } from "../types/domain";

type Line = "cutting" | "mdf_wrap";

/**
 * Fallback display code — the trailing digits only.
 *
 * Used for rows written before the board carried names, which have none until their next status
 * change re-syncs them. It also keeps the board from advertising how many orders the shop has
 * taken this year.
 */
function publicCode(orderNumber: string): string {
  const digits = orderNumber.match(/(\d+)$/)?.[1];
  return digits ? `#A-${digits.slice(-3)}` : orderNumber;
}

/**
 * "Цех жұмысы" — the live workshop board every signed-in customer can see.
 *
 * A compact list, one line per order. It used to be a column of full-height cards, each with a
 * labelled four-step strip, and a phone showed three of them: a customer scrolled past a wall of
 * anonymous codes without finding their own. Their own rows now carry their name and what the
 * order is made of — "6 лист · Ақ 6 · ХДФ 5" — which is the line that answers "which one is
 * mine" at a glance.
 *
 * Every row is named, at the shop's request — the board is the whiteboard on the workshop wall,
 * and a wall says names. The feed is readable by any signed-in user (firestore.rules:
 * `allow read: if isSignedIn()` on /workshopActivity), so that is every customer seeing every
 * other customer's name against a stage; nothing further is exposed, and the rule's comment says
 * so. What the viewer OWNS is still enriched client-side from `myOrders` — their sheet counts and
 * ПВХ metres — because that is data they already hold and the board never carries it.
 */
export function WorkshopActivityBoard({ myOrders = [] }: { myOrders?: Order[] }) {
  const { entries: allEntries, loading } = useWorkshopActivity();
  const [line, setLine] = useState<Line>("cutting");
  const mineByNumber = new Map(myOrders.map((o) => [o.orderNumber, o]));

  if (loading) return null;

  // Rows written before orderKind existed default to "cutting" — same default Order.orderKind
  // itself uses, so an old row and a new распил row land in the same tab.
  const entries = allEntries.filter((e) => (e.orderKind ?? "cutting") === line);

  const counts: { label: string; count: number; tone?: "blue" | "amber" | "green" }[] =
    line === "cutting"
      ? [
          { label: "Кезекте", count: entries.filter((e) => e.stage === "queue").length },
          { label: "Распилде", count: entries.filter((e) => e.stage === "cutting").length, tone: "blue" },
          { label: "ПВХ-да", count: entries.filter((e) => e.stage === "pvc_wait" || e.stage === "pvc").length, tone: "amber" },
          { label: "Дайын", count: entries.filter((e) => e.stage === "ready").length, tone: "green" },
        ]
      : [
          { label: "Өндірісте", count: entries.filter((e) => e.stage === "mdf").length, tone: "blue" },
          { label: "Дайын", count: entries.filter((e) => e.stage === "ready").length, tone: "green" },
        ];

  return (
    <section className="panel-card workshop-board">
      <div className="panel-head">
        <h3>Цех жұмысы</h3>
        <span className="workshop-board-live">● Деректер автоматты жаңарады</span>
      </div>

      <div className="status-filter-row">
        <button className={`status-filter-btn${line === "cutting" ? " active" : ""}`} onClick={() => setLine("cutting")}>
          <span>ЛДСП</span>
        </button>
        <button className={`status-filter-btn${line === "mdf_wrap" ? " active" : ""}`} onClick={() => setLine("mdf_wrap")}>
          <span>МДФ</span>
        </button>
      </div>

      <div className="workshop-board-counts">
        {counts.map(({ label, count, tone }) => (
          <div key={label} className={`workshop-count${tone ? ` is-${tone}` : ""}`}>
            <b>{count}</b><span>{label}</span>
          </div>
        ))}
      </div>

      {entries.length === 0 ? (
        <p className="workshop-board-empty">Қазір цехта белсенді заказ жоқ.</p>
      ) : (
        <ul className="workshop-list">
          {entries.map((e) => {
            const own = mineByNumber.get(e.orderNumber);
            const steps = boardProgress(e.stage, e.needsPvc, e.orderKind);
            const sheets = own && line === "cutting" ? sheetSummary(linesOf(own)) : null;

            const row = (
              <>
                <span className="workshop-row-id">
                  {own ? customerOrderCode(own.orderNumber) : publicCode(e.orderNumber)}
                </span>

                {/* Named for everyone. A row synced before the name was added has none — it keeps
                    its code above and simply says nothing here, rather than showing a blank. */}
                {!own && e.customerName && (
                  <span className="workshop-row-name">{e.customerName}</span>
                )}

                <span className="workshop-row-stage">
                  <StageIcon stage={e.stage} className="workshop-row-stage-icon" />
                  {boardSummary(e.stage, e.queuePosition)}
                </span>

                {/* Only the viewer's own rows are named and itemised — everything here is theirs.
                    On its own line, because "Дин · 11 лист · Ақ 6 · ХДФ 5" does not fit beside a
                    code and a stage on a 390px phone, and this is the line they came to read. */}
                {own && (
                  <span className="workshop-row-what">
                    <b>{own.customerName}</b>
                    {own.orderKind === "mdf_wrap" ? (
                      <span className="workshop-row-detail"> · {formatMdfArea(own.mdfAreaM2)} · {own.mdfFilmColor || "—"}</span>
                    ) : (
                      <>
                        {sheets && sheets.headline !== "—" && (
                          <>
                            {" · "}
                            {sheets.headline}
                            {sheets.detail && <span className="workshop-row-detail"> · {sheets.detail}</span>}
                          </>
                        )}
                        {own.pvcMetersTotal > 0 && (
                          <span className="workshop-row-detail"> · {Math.round(own.pvcMetersTotal)} м ПВХ</span>
                        )}
                      </>
                    )}
                  </span>
                )}

                {/* How many people are in front of you — counted in customers, not in orders, so
                    one person waiting with two jobs is one wait. Only on your own queued row:
                    it is the question you opened the page with. */}
                {own && e.stage === "queue" && (
                  <span className="workshop-row-ahead">
                    {(() => {
                      const ahead = customersAhead(entries, e);
                      return ahead === 0
                        ? "🎉 Кезектің басындасыз"
                        : `Сіздің алдыңызда ${ahead} клиент`;
                    })()}
                  </span>
                )}

                {/* The same four steps as before, as a slim bar: a whole labelled strip per row is
                    what made the list unreadable on a phone. The stage is written out above it. */}
                <span className="workshop-row-bar" aria-hidden="true">
                  {steps.map((step) => (
                    <i key={step.key} className={`is-${step.state}`} />
                  ))}
                </span>
              </>
            );

            // Someone else's row is not a link — there is nothing the viewer may open.
            return (
              <li key={e.id} className={`workshop-row${own ? " is-mine" : ""}`}>
                {own ? (
                  <Link to={`/order/${own.id}`} className="workshop-row-inner">
                    {row}
                    <span className="workshop-row-chev" aria-hidden="true">›</span>
                  </Link>
                ) : (
                  <div className="workshop-row-inner">{row}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
