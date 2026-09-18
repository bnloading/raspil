import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { Spinner, Toast } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { CuttingLineActions } from "../components/CuttingActionsPanel";
import { WorkerHistoryCard } from "../components/WorkerHistoryCard";
import { IconUsers } from "../components/layout/icons";
import { WorkerDashboardHeader } from "../components/WorkerDashboardHeader";
import { jobsOf } from "../lib/orderLines";
import { WorkerMaterialSummary, WorkerHistorySummary } from "../components/WorkerMaterialSummary";
import { useMaterials } from "../hooks/useMaterials";
import type { Material } from "../types/domain";
import { useCutterOrders } from "../hooks/useOrders";
import { useToast } from "../hooks";
import { dayKey } from "../lib/dates";
import type { Order } from "../types/domain";

/**
 * "Распил панелі" — the cutting worker's whole job on one screen: how much work is waiting and
 * one card per order to act on. There used to be a separately-styled "Қазіргі заказ" panel for
 * whichever order was in progress, spotlighted above the queue in a different layout — but every
 * field it carried (order number, materials, payment, progress) already lives on the plain job
 * card too, and the per-line action rows already make plain which order is actually being worked.
 * One list, one card shape: an order in progress simply shows its lines already started.
 *
 * Payment status is deliberately withheld here, at the owner's request: the cutter's job is the
 * material and the sheet count, not whether the office has been paid yet. Customer contact details
 * and other roles' controls stay out too.
 */
export default function CutterDashboard() {
  const { user, userData } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") ?? "queue";
  const { materials } = useMaterials(false);
  const { orders, loading } = useCutterOrders(user?.uid);
  const { message, visible, showToast } = useToast();
  const [search, setSearch] = useState("");

  const queued = useMemo(
    () => orders.filter((o) => o.productionStatus === "cutting_queue").sort((a, b) => a.priority - b.priority),
    [orders],
  );
  const inProgress = useMemo(() => orders.filter((o) => o.productionStatus === "cutting_started"), [orders]);
  const doneToday = useMemo(() => {
    const today = dayKey(new Date());
    return orders.filter(o => jobsOf(o).some(j => j.cuttingByUid === user?.uid && j.cuttingCompletedAt && dayKey(j.cuttingCompletedAt.toDate()) === today));
  }, [orders, user?.uid]);

  // Whatever is already started surfaces first — that is the actual work in hand — then the
  // queue in its own priority order.
  const active = useMemo(() => [...inProgress, ...queued], [inProgress, queued]);

  if (!user || !userData) return <Spinner />;
  const actor = { user, userData };
  const byView = view === "mine" ? active.filter((o) => jobsOf(o).some((j) => j.cuttingByUid === user.uid && !j.cuttingCompletedAt)) : view === "history" ? orders.filter((o) => jobsOf(o).some((j) => j.cuttingByUid === user.uid && j.cuttingCompletedAt)) : active;
  const q = search.trim().toLocaleLowerCase();
  const shown = q
    ? byView.filter((o) => o.customerName.toLocaleLowerCase().includes(q) || o.orderNumber.toLocaleLowerCase().includes(q))
    : byView;

  return (
    <AppShell
      title="Распил"
      subtitle={userData.name}
      contentWidth="narrow"
      variant="station"
    >
      <WorkerDashboardHeader historyInNav queued={queued.length} active={inProgress.length} done={doneToday.length} view={view} onView={(next) => setParams(next === "queue" ? {} : {view: next})} />

    {view !== "history" && (
      <input
        className="form-input station-search"
        type="search"
        placeholder="Клиент немесе заказ №"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
    )}
    {view === "history" && <WorkerHistorySummary orders={orders} materials={materials} stage="cutting" uid={user.uid} />}
      {loading ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📭</div>
          <p>{view === "history" ? "Орындалған жұмыс жоқ" : "Бұл тізімде тапсырма жоқ"}</p>
        </div>
      ) : (
        <div className={view === "history" ? "station-history-list" : "station-job-list"}>
          {shown.map((o) => (
            view === "history" ? <WorkerHistoryCard key={o.id} order={o} stage="cutting" uid={user.uid} materials={materials} to={`/cutting/order/${o.id}`} /> : <JobCard
              key={o.id}
              order={o}
              materials={materials}
              history={view === "history"}
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
 * whether it is paid, how far along the shop it is, and a start/finish control right on each
 * material's own card — not a separate list, so "Бастау" always sits beside the material it
 * belongs to. Finishing is not offered as a single flat action: each line's own sheet count is
 * confirmed against the order's real parts, which the order link opens in full.
 */
function JobCard({
  order,
  actor,
  onToast,
  onOpen,
  materials,
  history,
}: {
  order: Order;
  materials: Material[];
  history: boolean;
  actor: { user: import("firebase/auth").User; userData: import("../types/domain").UserDoc };
  onToast: (m: string) => void;
  onOpen: () => void;
}) {
  return (
    <article className={`station-job ${order.productionStatus === "cutting_started" ? "is-active" : ""}`}>
      <div className="station-job-status"><span className={`station-state ${history ? "is-done" : order.productionStatus === "cutting_started" ? "is-active" : ""}`}>{history ? "ОРЫНДАЛДЫ" : order.productionStatus === "cutting_started" ? "ЖҰМЫСТА" : "КЕЗЕКТЕ"}</span><span>№{(order.priority ?? 0) + 1}</span></div>
      <button className="station-order-link" onClick={onOpen}>{order.orderNumber}</button>
      <div className="station-customer"><IconUsers />{order.customerName}</div>
      <WorkerMaterialSummary
        order={order}
        materials={materials}
        stage="cutting"
        uid={actor.user.uid}
        history={history}
        action={history ? undefined : (job) => <CuttingLineActions order={order} job={job} actor={actor} onToast={onToast} />}
      />
    </article>
  );
}
