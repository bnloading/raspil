import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CustomerProductionProgress } from "./CustomerProductionProgress";
import { getCustomerStageLabel, getCustomerStageTone } from "./CustomerStatusCard";
import { IconLayers, IconOrders, IconPvc } from "./layout/icons";
import { formatMoney } from "../lib/money";
import { formatMdfArea } from "../lib/mdfJournal";
import { customerOrderCode } from "../lib/orderCode";
import { formatDayMonth } from "../lib/dates";
import { orderTiles } from "../lib/orderTiles";
import type { Order } from "../types/domain";

/**
 * The stage, in the customer's words, with the queue position when there is one.
 *
 * "Распил кезегінде" on its own leaves the obvious question unanswered, and the position is the
 * whole reason a customer opens this page while they are waiting.
 */
function stageLine(order: Order): string {
  const label = getCustomerStageLabel(order.productionStatus, order.pvcMetersTotal > 0, order.mdfStage);
  const queued = order.productionStatus === "cutting_queue" || order.productionStatus === "pvc_queue";
  return queued ? `${label} · №${(order.priority ?? 0) + 1}` : label;
}

/**
 * One of the customer's orders as a card — the same card on their home and on «Заказдарым».
 *
 * The whole summary is one link to the order; `actions` (repeat, cancel) sit outside it, since a
 * button nested inside an anchor is neither valid nor reliably clickable. The foot says what is
 * still owed on the order from the payments (hooks/useCustomerDebts.ts), not a stored badge.
 */
export function CustomerOrderCard({
  order,
  debtTiyn,
  actions,
}: {
  order: Order;
  /** Left to pay on this order; 0 when nothing is, or when it cannot be owed on. */
  debtTiyn: number;
  actions?: ReactNode;
}) {
  const tiles = orderTiles(order);
  const when = order.updatedAt ?? order.createdAt;
  const priced = order.pricePublished !== false;
  const closed = order.productionStatus === "draft" || order.productionStatus === "cancelled";

  return (
    <div className="ocard is-static corder-card">
      <Link to={`/order/${order.id}`} className="ocard-link">
        <div className="corder-head">
          <span className="otable-num">
            {customerOrderCode(order.orderNumber)}
            {order.orderKind === "mdf_wrap" && <span className="jt-pill jt-tone-muted"> МДФ</span>}
          </span>
          {/* Day and month right beside the code: scanning a list of orders, "which one is this"
              and "when" are the same question. */}
          {when && <span className="corder-date">{formatDayMonth(when)}</span>}
          <span className="corder-name">{order.customerName}</span>
          <span className={`corder-stage is-${getCustomerStageTone(order.productionStatus)}`}>{stageLine(order)}</span>
        </div>

        {order.orderKind === "mdf_wrap" ? (
          <div className="corder-tiles">
            <span className="corder-tile">
              <IconLayers className="corder-tile-icon" />
              <b>{formatMdfArea(order.mdfAreaM2)}</b>
              <small>{order.mdfFilmColor || order.mdfPatternName || "МДФ"}</small>
            </span>
          </div>
        ) : (
          // Sheets, edging and ХДФ as three figures rather than one run-on line: they are counted
          // separately in the shop, and ХДФ takes no edging at all.
          <div className="corder-tiles">
            <span className="corder-tile">
              <IconOrders className="corder-tile-icon" />
              <b>{tiles.sheets}</b>
              <small>лист</small>
            </span>
            <span className="corder-tile">
              <IconPvc className="corder-tile-icon" />
              <b>{tiles.pvcMeters} м</b>
              <small>ПВХ</small>
            </span>
            <span className="corder-tile">
              <IconLayers className="corder-tile-icon" />
              <b>{tiles.hdfSheets}</b>
              <small>ХДФ</small>
            </span>
          </div>
        )}

        <CustomerProductionProgress order={order} />

        <div className="corder-foot">
          {priced ? (
            <span className="corder-money">
              {formatMoney(order.totalTiyn)}
              {!closed && (debtTiyn > 0
                ? <span className="corder-owed">Қарыз {formatMoney(debtTiyn)}</span>
                : <span className="corder-paid">Төленді ✓</span>)}
            </span>
          ) : (
            // An online order the shop has not priced yet: its stored sum is 0 or a guess.
            <span className="corder-money is-pending">Бағасы есептелуде…</span>
          )}
        </div>
        <span className="ocard-chev" aria-hidden="true">›</span>
      </Link>
      {actions && <div className="track-card-actions">{actions}</div>}
    </div>
  );
}
