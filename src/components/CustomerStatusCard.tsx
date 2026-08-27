import type { Order, ProductionStatus } from "../types/domain";
import { OrderProgressStepper } from "./OrderProgressStepper";

/** A production order takes roughly this long on average once it reaches the front of the
 *  cutting queue — there's no real per-order duration forecast before cutting actually starts, so
 *  "Болжамды бастау" (estimated start) is a heuristic (queue position × this constant), not a
 *  promise. Revisit if real historical duration data becomes available. */
const AVG_MINUTES_PER_QUEUED_ORDER = 15;

/**
 * Maps the full 16-value internal ProductionStatus down to the small set of customer-facing
 * phrases from the spec's "happy path" list, plus a graceful extra line for "cancelled" (not in
 * the spec's list, but an order can land there and must not render blank/crash).
 *
 * `needsPvc` decides whether `cutting_completed` (a brief transitional state that either heads to
 * pvc_queue or straight to ready — see lib/statuses.ts getNextProductionStatuses) should ever show
 * a PVC-labeled stage: an order with no PVC never passes through pvc_queue/pvc_started, so for it
 * `cutting_completed` falls back to the cutting-stage phrase instead of an inapplicable PVC one.
 */
export function getCustomerStageLabel(status: ProductionStatus, needsPvc: boolean): string {
  switch (status) {
    case "draft":
    case "submitted":
      return "Заказ қабылданды";
    case "manager_review":
    case "price_calculated":
      return "Баға есептеліп жатыр";
    case "waiting_payment":
    case "partially_paid":
      return "Төлем күтілуде";
    case "paid":
    case "cutting_queue":
      return "Распил кезегінде";
    case "cutting_started":
      return "Распил басталды";
    case "cutting_completed":
      return needsPvc ? "ПВХ жасалып жатыр" : "Распил басталды";
    case "pvc_queue":
    case "pvc_started":
      return "ПВХ жасалып жатыр";
    case "pvc_completed":
    case "ready":
      return "Заказ дайын";
    case "delivered":
      return "Клиентке берілді";
    case "cancelled":
      return "Бас тартылды";
  }
}

function minutesFromNow(expectedCompletionAt: { toMillis(): number } | undefined): number | null {
  if (!expectedCompletionAt) return null;
  return Math.max(0, Math.round((expectedCompletionAt.toMillis() - Date.now()) / 60000));
}

/** Rough heuristic estimated-start clock time for a queued order — see AVG_MINUTES_PER_QUEUED_ORDER. */
function computeEstimatedStart(aheadCount: number): Date {
  return new Date(Date.now() + aheadCount * AVG_MINUTES_PER_QUEUED_ORDER * 60000);
}

interface CustomerStatusCardProps {
  order: Order;
}

/**
 * Top-of-page card for a customer's OWN order — compact status header (order #, big status pill,
 * queue position when relevant) plus the "Заказдың жолы" progress stepper. Does NOT expose the
 * internal 16-status machine, worker notes, audit history, or purchase costs — those stay in
 * OrderView/admin-only views.
 */
export function CustomerStatusCard({ order }: CustomerStatusCardProps) {
  const isReady = order.productionStatus === "ready" || order.productionStatus === "delivered";
  const isCancelled = order.productionStatus === "cancelled";
  const needsPvc = order.pvcMetersTotal > 0;
  const stageLabel = getCustomerStageLabel(order.productionStatus, needsPvc);

  let etaLine: string | null = null;
  if (order.productionStatus === "cutting_started") {
    const minutes = minutesFromNow(order.cuttingExpectedCompletionAt);
    if (minutes !== null) etaLine = `Распил шамамен ${minutes} минутта аяқталады.`;
  } else if (order.productionStatus === "pvc_started") {
    const minutes = minutesFromNow(order.pvcExpectedCompletionAt);
    if (minutes !== null) etaLine = `ПВХ жұмысы шамамен ${minutes} минутта аяқталады.`;
  }

  const isQueued = order.productionStatus === "cutting_queue" || order.productionStatus === "pvc_queue";
  const aheadCount = order.priority ?? 0;
  const estimatedStart = isQueued ? computeEstimatedStart(aheadCount) : null;

  return (
    <div className="panel-card customer-status-hero-card">
      <div className="customer-status-header-row">
        <span className="customer-status-order-number">{order.orderNumber}</span>
        <span
          className={`customer-status-pill ${
            isCancelled ? "is-cancelled" : isReady ? "is-ready" : "is-pending"
          }`}
        >
          {isCancelled ? "Бас тартылды" : isReady ? "Дайын" : "Дайын емес"}
        </span>
      </div>

      {isQueued && (
        <div className="customer-status-queue-info">
          <p>
            Распил кезегіндегі орны: <strong>№{aheadCount + 1}</strong>
          </p>
          <p>
            {aheadCount > 0 ? (
              <>
                Алдыңызда: <strong>{aheadCount} заказ</strong>
              </>
            ) : (
              <strong>Кезектің басында тұрсыз</strong>
            )}
          </p>
          {estimatedStart && (
            <p>
              Болжамды бастау:{" "}
              <strong>
                {estimatedStart.toLocaleTimeString("kk-KZ", { hour: "2-digit", minute: "2-digit" })}
              </strong>
            </p>
          )}
        </div>
      )}

      {!isQueued && !isCancelled && <div className="customer-status-stage">{stageLabel}</div>}
      {etaLine && <div className="customer-status-eta">{etaLine}</div>}

      {order.pricePublished ? null : (
        <div className="customer-status-eta">Баға есептелуде...</div>
      )}

      <div className="customer-status-stepper-wrap">
        <h3>Заказдың жолы</h3>
        <OrderProgressStepper order={order} />
      </div>
    </div>
  );
}
