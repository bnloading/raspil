import { customerOrderBreakdown } from "../lib/customerOrderBreakdown";
import { formatMoney } from "../lib/money";
import type { Order } from "../types/domain";

/**
 * What an order is made of and what is still owed on it, as the customer reads it — every
 * material line at its own price, the charges around them, then the sum, what was paid and what
 * is left (lib/customerOrderBreakdown.ts). Used on the customer's order page and in the drill-down
 * of their «Қарыз» page.
 */
export function CustomerOrderBreakdown({
  order,
  paidTiyn,
  showMoney = true,
}: {
  order: Order;
  /** What came in, from the order's own payments; the order's stored figure when not given. */
  paidTiyn?: number;
  /** False while the shop has not priced the order yet — the lines alone, no sums. */
  showMoney?: boolean;
}) {
  const { lines, extras } = customerOrderBreakdown(order);
  const paid = paidTiyn ?? order.paidTiyn;
  const left = order.totalTiyn - paid;

  return (
    <div className="cob">
      <ul className="cob-lines">
        {lines.map((row) => (
          <li key={row.key}>
            <span className="cob-title">
              {row.title}
              {/* No prices at all until the shop has priced the order — not even per line. */}
              {(showMoney ? row.detail : row.quantity) && <small>{showMoney ? row.detail : row.quantity}</small>}
            </span>
            {showMoney && <strong>{formatMoney(row.amountTiyn)}</strong>}
          </li>
        ))}
        {showMoney && extras.map((row) => (
          <li key={row.key} className={row.amountTiyn < 0 ? "is-discount" : "is-extra"}>
            <span className="cob-title">{row.title}</span>
            <strong>{row.amountTiyn < 0 ? `−${formatMoney(-row.amountTiyn)}` : formatMoney(row.amountTiyn)}</strong>
          </li>
        ))}
      </ul>
      {showMoney ? (
        <dl className="cob-totals">
          <div>
            <dt>Барлығы</dt>
            <dd>{formatMoney(order.totalTiyn)}</dd>
          </div>
          <div className="is-paid">
            <dt>Төленді</dt>
            <dd>{formatMoney(paid)}</dd>
          </div>
          <div className={left > 0 ? "is-debt" : left < 0 ? "is-over" : "is-clear"}>
            <dt>{left < 0 ? "Артық төленді" : "Қарыз"}</dt>
            <dd>{left === 0 ? "жоқ" : formatMoney(Math.abs(left))}</dd>
          </div>
        </dl>
      ) : (
        <p className="cob-pending">Бағасын менеджер есептеп жатыр</p>
      )}
    </div>
  );
}
