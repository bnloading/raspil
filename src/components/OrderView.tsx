import type { ReactNode } from "react";
import { EDGE_KEYS, MDF_PATTERN_LABELS } from "../types/domain";
import type { CuttingPart, Order, Payment, StatusHistoryEntry } from "../types/domain";
import { ProductionStatusBadge, PaymentStatusBadge } from "./StatusBadge";
import { formatMoney } from "../lib/money";
import { formatMdfArea } from "../lib/mdfJournal";
import { formatDateDMY, formatDateTimeDMY } from "../lib/dates";
import { PRODUCTION_STATUS_LABELS } from "../lib/statuses";
import { formatPhone } from "../lib/phone";

const GRAIN_LABELS: Record<string, string> = { vertical: "Тік", horizontal: "Көлденең", any: "Маңызды емес" };

export function OrderView({
  order,
  parts,
  statusHistory,
  payments,
  showCustomerInfo = true,
  showFinancials = true,
  showQueueInfo = true,
  actions,
}: {
  order: Order;
  parts: CuttingPart[];
  statusHistory: StatusHistoryEntry[];
  payments: Payment[];
  showCustomerInfo?: boolean;
  showFinancials?: boolean;
  /** The customer order-detail page shows its own queue-position header (CustomerStatusCard) —
   *  set false there so "Кезектегі орны"/"Дайын болу мерзімі" isn't repeated. */
  showQueueInfo?: boolean;
  actions?: ReactNode;
}) {
  return (
    <div className="order-view print-area">
      <div className="order-view-header">
        <div>
          <h2>{order.orderNumber}</h2>
          {order.createdAt && <span className="order-view-date">Құрылды: {formatDateDMY(order.createdAt)}</span>}
        </div>
        <div className="order-view-badges">
          <ProductionStatusBadge status={order.productionStatus} />
          <PaymentStatusBadge status={order.paymentStatus} />
        </div>
      </div>

      {actions && <div className="order-view-actions no-print">{actions}</div>}

      {showQueueInfo &&
        (order.productionStatus === "cutting_queue" ||
        order.productionStatus === "pvc_queue" ||
        order.productionStatus === "cutting_started" ||
        order.productionStatus === "pvc_started") && (
        <section className="order-view-section">
          <h3>Мерзім</h3>
          {(order.productionStatus === "cutting_queue" || order.productionStatus === "pvc_queue") && (
            <>
              <p>Кезектегі орны: <strong>№{(order.priority ?? 0) + 1}</strong></p>
              <p>
                {order.queueAheadOrderNumber ? (
                  <>Алдыңғы заказ: <strong>{order.queueAheadOrderNumber}</strong></>
                ) : (
                  <strong>Кезектің басында тұрсыз</strong>
                )}
              </p>
            </>
          )}
          {order.productionStatus === "cutting_started" && (
            <>
              {order.cuttingEstimatedMinutes !== undefined && (
                <p>Болжамды уақыт: <strong>{order.cuttingEstimatedMinutes} минут</strong></p>
              )}
              {order.cuttingExpectedCompletionAt && (
                <p>Дайын болу мерзімі: <strong>{formatDateDMY(order.cuttingExpectedCompletionAt)}</strong></p>
              )}
            </>
          )}
          {order.productionStatus === "pvc_started" && (
            <>
              {order.pvcEstimatedMinutes !== undefined && (
                <p>Болжамды уақыт: <strong>{order.pvcEstimatedMinutes} минут</strong></p>
              )}
              {order.pvcExpectedCompletionAt && (
                <p>Дайын болу мерзімі: <strong>{formatDateDMY(order.pvcExpectedCompletionAt)}</strong></p>
              )}
            </>
          )}
        </section>
      )}

      {showCustomerInfo && (
        <section className="order-view-section">
          <h3>Клиент</h3>
          <p>
            {order.customerName} · {formatPhone(order.customerPhone)}
          </p>
        </section>
      )}

      {order.orderKind === "mdf_wrap" ? (
        // A МДФ order has no material catalogue line at all — a panel breakdown (when measured
        // that way, see types/domain.ts's MdfPanel) or just an area, plus a wrap film colour.
        <section className="order-view-section">
          <h3>МДФ</h3>
          <p>
            {order.mdfFilmColor || "Пленка көрсетілмеген"} · {formatMdfArea(order.mdfAreaM2)}
          </p>
          {order.mdfPanels && order.mdfPanels.length > 0 && (
            <div className="parts-table-wrap">
              <table className="parts-table order-view-parts-table">
                <thead>
                  <tr>
                    <th>Өлшемі</th>
                    <th>Саны</th>
                    <th>Өрнек</th>
                    <th>Аудан</th>
                  </tr>
                </thead>
                <tbody>
                  {order.mdfPanels.map((p) => (
                    <tr key={p.id}>
                      <td>{p.lengthMm}×{p.widthMm} мм</td>
                      <td>{p.qty}</td>
                      <td>{MDF_PATTERN_LABELS[p.pattern]}</td>
                      <td>{formatMdfArea((p.lengthMm / 1000) * (p.widthMm / 1000) * p.qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <>
          <section className="order-view-section">
            <h3>Материал</h3>
            {order.materialSource === "customer" ? (
              // A customer-supplied sheet has no catalogue entry, so colour/thickness/sheet size are
              // all zero — printing them would read as "() · 0 мм · 0×0 мм". Show the name they gave
              // and say plainly whose sheet it is, which is what the Manager needs in order to price it.
              <>
                <p>{order.customerMaterialName || order.materialSnapshot.name}</p>
                <p className="order-view-own-material">Клиенттің өз листі — бағасын менеджер есептейді</p>
              </>
            ) : (
              <p>
                {order.materialSnapshot.name} ({order.materialSnapshot.color}) · {order.materialSnapshot.thicknessMm} мм ·{" "}
                {order.materialSnapshot.sheetLengthMm}×{order.materialSnapshot.sheetWidthMm} мм
              </p>
            )}
            <p>
              Болжамды лист: {order.estimatedSheets}
              {order.confirmedSheets !== undefined && <> · Расталған лист: {order.confirmedSheets}</>}
            </p>
          </section>

          <section className="order-view-section">
            <h3>Бөлшектер ({parts.length})</h3>
            <div className="parts-table-wrap">
              <table className="parts-table order-view-parts-table">
                <thead>
                  <tr>
                    <th>Атауы</th>
                    <th>Өлшемі</th>
                    <th>Саны</th>
                    <th>Талшық</th>
                    <th>ПВХ жиектер</th>
                    <th>Ескертпе</th>
                  </tr>
                </thead>
                <tbody>
                  {parts.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td>{p.lengthMm}×{p.widthMm} мм</td>
                      <td>{p.qty}</td>
                      <td>{GRAIN_LABELS[p.grainDirection] ?? p.grainDirection}</td>
                      <td>{EDGE_KEYS.filter((e) => p.edges[e]?.pvc).join(", ") || "—"}</td>
                      <td>{p.note || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>ПВХ жалпы: {order.pvcMetersTotal.toFixed(2)} м</p>
          </section>
        </>
      )}

      {showFinancials && (
        <section className="order-view-section">
          <h3>Қаржы</h3>
          <div className="confirm-summary">
            {order.orderKind === "mdf_wrap" ? (
              <div className="confirm-row">
                <span>Аудан ({formatMdfArea(order.mdfAreaM2)})</span>
                <strong>{formatMoney(Math.round((order.mdfAreaM2 ?? 0) * (order.mdfPricePerM2Tiyn ?? 0)))}</strong>
              </div>
            ) : (
              <>
                <div className="confirm-row"><span>Материал</span><strong>{formatMoney(order.materialCostTiyn)}</strong></div>
                <div className="confirm-row"><span>Кесу</span><strong>{formatMoney(order.cuttingCostTiyn)}</strong></div>
                <div className="confirm-row"><span>ПВХ</span><strong>{formatMoney(order.pvcCostTiyn)}</strong></div>
              </>
            )}
            {order.extraServicesTiyn > 0 && (
              <div className="confirm-row"><span>Қосымша қызмет</span><strong>{formatMoney(order.extraServicesTiyn)}</strong></div>
            )}
            {order.deliveryCostTiyn > 0 && (
              <div className="confirm-row"><span>Жеткізу</span><strong>{formatMoney(order.deliveryCostTiyn)}</strong></div>
            )}
            {order.discountTiyn > 0 && (
              <div className="confirm-row"><span>Жеңілдік</span><strong>-{formatMoney(order.discountTiyn)}</strong></div>
            )}
            <div className="confirm-row confirm-total"><span>Барлығы</span><strong>{formatMoney(order.totalTiyn)}</strong></div>
            <div className="confirm-row"><span>Төленді</span><strong>{formatMoney(order.paidTiyn)}</strong></div>
            <div className="confirm-row"><span>Қарыз</span><strong>{formatMoney(order.debtTiyn)}</strong></div>
          </div>
        </section>
      )}

      {showFinancials && payments.length > 0 && (
        <section className="order-view-section no-print">
          <h3>Төлемдер</h3>
          <div className="data-list">
            {payments.map((p) => (
              <div key={p.id} className={`data-row${p.reversed ? " blocked" : ""}`}>
                <div className="data-row-main">
                  <strong>{formatMoney(p.amountTiyn)} · {p.methodName}</strong>
                  <span>{p.recordedByName} · {p.paymentDate ? formatDateTimeDMY(p.paymentDate) : ""}</span>
                  {p.comment && <span>{p.comment}</span>}
                  {p.reversed && <span>❌ Қайтарылды: {p.reversalReason}</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {order.customerNote && (
        <section className="order-view-section">
          <h3>Клиент ескертпесі</h3>
          <p>{order.customerNote}</p>
        </section>
      )}

      {statusHistory.length > 0 && (
        <section className="order-view-section no-print">
          <h3>Статус тарихы</h3>
          <div className="status-timeline">
            {statusHistory.map((h, i) => (
              <div key={h.id} className="status-timeline-row">
                <span className={`status-timeline-dot ${i === statusHistory.length - 1 ? "is-current" : "is-done"}`}>
                  {i === statusHistory.length - 1 ? "🕐" : "✓"}
                </span>
                <div>
                  <strong>
                    {h.field === "production"
                      ? PRODUCTION_STATUS_LABELS[h.newStatus as keyof typeof PRODUCTION_STATUS_LABELS] ?? h.newStatus
                      : h.newStatus}
                  </strong>
                  <span> — {h.userName}{h.comment ? `: ${h.comment}` : ""}</span>
                  <div className="status-timeline-date">{h.createdAt ? formatDateTimeDMY(h.createdAt) : ""}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
