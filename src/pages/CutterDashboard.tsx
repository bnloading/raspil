import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { Spinner, Toast } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { CuttingActionsPanel } from "../components/CuttingActionsPanel";
import { OrderProgress } from "../components/OrderProgress";
import { PaymentStatusBadge } from "../components/StatusBadge";
import { WorkerSalaryTeaser } from "../components/WorkerSalaryTeaser";
import { useCutterOrders } from "../hooks/useOrders";
import { useToast } from "../hooks";
import { dayKey, formatDateDMY } from "../lib/dates";
import { materialSummary } from "../lib/journal";
import { formatMoney } from "../lib/money";
import type { Order } from "../types/domain";

/**
 * "Распил панелі" — the cutting worker's whole job on one screen: how much work is waiting and
 * one card per order to act on. There used to be a separately-styled "Қазіргі заказ" panel for
 * whichever order was in progress, spotlighted above the queue in a different layout — but every
 * field it carried (order number, materials, payment, progress) already lives on the plain job
 * card too, and the per-line action rows already make plain which order is actually being worked.
 * One list, one card shape: an order in progress simply shows its lines already started.
 *
 * Each card carries its total and payment badge, at the owner's request: the cutter reads the
 * same card the office does, so a row that is still a debt is visible before the saw starts on it.
 * Customer contact details and other roles' controls stay out.
 */
export default function CutterDashboard() {
  const { user, userData } = useAuth();
  const navigate = useNavigate();
  const { orders, loading } = useCutterOrders(user?.uid);
  const { message, visible, showToast } = useToast();

  const queued = useMemo(
    () => orders.filter((o) => o.productionStatus === "cutting_queue").sort((a, b) => a.priority - b.priority),
    [orders],
  );
  const inProgress = useMemo(() => orders.filter((o) => o.productionStatus === "cutting_started"), [orders]);
  const doneToday = useMemo(() => {
    const today = dayKey(new Date());
    return orders.filter((o) => o.cuttingCompletedAt && dayKey(o.cuttingCompletedAt.toDate()) === today);
  }, [orders]);

  // Whatever is already started surfaces first — that is the actual work in hand — then the
  // queue in its own priority order.
  const active = useMemo(() => [...inProgress, ...queued], [inProgress, queued]);

  if (!user || !userData) return <Spinner />;
  const actor = { user, userData };

  return (
    <AppShell
      title="Распил панелі"
      subtitle={`Сәлем, ${userData.name}`}
      actions={<span className="worker-shift-badge">● Бүгін: Жұмыста</span>}
    >
      <div className="worker-stat-row">
        <div className="worker-stat-card">
          <span className="worker-stat-icon">⏳</span>
          <div>
            <div className="worker-stat-num">{queued.length}</div>
            <div className="worker-stat-cap">Кезекте</div>
          </div>
        </div>
        <div className="worker-stat-card is-blue">
          <span className="worker-stat-icon">▶</span>
          <div>
            <div className="worker-stat-num">{inProgress.length}</div>
            <div className="worker-stat-cap">Қазір</div>
          </div>
        </div>
        <div className="worker-stat-card is-green">
          <span className="worker-stat-icon">✓</span>
          <div>
            <div className="worker-stat-num">{doneToday.length}</div>
            <div className="worker-stat-cap">Бүгін дайын</div>
          </div>
        </div>
        <WorkerSalaryTeaser uid={user.uid} orders={orders} />
      </div>

      {loading ? (
        <Spinner />
      ) : active.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📭</div>
          <p>Кезекте заказ жоқ</p>
        </div>
      ) : (
        <div className="job-card-list">
          {active.map((o) => (
            <JobCard
              key={o.id}
              order={o}
              actor={actor}
              onToast={showToast}
              onOpen={() => navigate(`/cutting/order/${o.id}`)}
            />
          ))}
        </div>
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

/**
 * One order as the cutter sees it: order and date, customer and total, what is to be cut and
 * whether it is paid, how far along the shop it is, and a start/finish row per material line.
 *
 * Finishing is not offered as a single flat action here: each line's own sheet count is confirmed
 * against the order's real parts, which "⊞ Размерлер" (and CuttingActionsPanel itself) load in full.
 */
function JobCard({
  order,
  actor,
  onToast,
  onOpen,
}: {
  order: Order;
  actor: { user: import("firebase/auth").User; userData: import("../types/domain").UserDoc };
  onToast: (m: string) => void;
  onOpen: () => void;
}) {
  return (
    <article className="ocard job-card">
      <div className="ocard-top">
        <span className="otable-num">{order.orderNumber}</span>
        <span className="otable-sub">{order.createdAt ? formatDateDMY(order.createdAt) : "—"}</span>
      </div>
      <div className="ocard-mid">
        <span className="otable-strong">{order.customerName}</span>
        <span className="otable-money">{formatMoney(order.totalTiyn)}</span>
      </div>
      <div className="ocard-meta">
        <span className="otable-sub">
          №{(order.priority ?? 0) + 1} · {materialSummary(order)} · {order.materialSnapshot.name}
        </span>
        <PaymentStatusBadge status={order.paymentStatus} />
      </div>
      <OrderProgress order={order} />

      <div className="job-card-actions">
        <button className="btn btn-outline btn-sm" onClick={onOpen}>
          ⊞ Размерлер
        </button>
      </div>
      {/* One row per material — a merged order's ЛДСП and ХДФ each start and finish on their
          own, so this is never collapsed into a single "Бастау"/"Аяқтау" button. */}
      <CuttingActionsPanel order={order} actor={actor} onToast={onToast} />
    </article>
  );
}
