import { useSearchParams, useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { Spinner, Toast } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { MdfStageActionsPanel } from "../components/MdfStageActionsPanel";
import { IconUsers } from "../components/layout/icons";
import { WorkerDashboardHeader } from "../components/WorkerDashboardHeader";
import { WorkerHistoryCard } from "../components/WorkerHistoryCard";
import { WorkerSalaryTeaser } from "../components/WorkerSalaryTeaser";
import { PaymentStatusBadge } from "../components/StatusBadge";
import { useMdfOrders } from "../hooks/useOrders";
import { useToast } from "../hooks";
import { ROLE_TO_MDF_STAGE } from "../lib/rbac";
import { dayKey } from "../lib/dates";
import { formatMdfArea } from "../lib/mdfJournal";
import { MDF_STAGES, MDF_STAGE_LABELS } from "../types/domain";

export default function MdfWorkerDashboard() {
  const { user, userData } = useAuth();
  const { orders, loading } = useMdfOrders();
  const { message, visible, showToast } = useToast();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const view = params.get("view") ?? "queue";
  const stage = userData ? ROLE_TO_MDF_STAGE[userData.role] : undefined;
  if (!user || !userData || !stage) return <Spinner />;
  const actor = { user, userData };
  const label = MDF_STAGE_LABELS[stage];
  const relevant = orders.filter((o) => o.productionStatus === "mdf_production" && o.mdfStage === stage);
  const active = relevant.filter((o) => o.mdfStageJobs?.[stage]?.startedAt);
  const queue = relevant.filter((o) => !o.mdfStageJobs?.[stage]?.startedAt).sort((a,b) => a.priority - b.priority);
  const upcoming = orders.filter((o) => o.productionStatus === "mdf_production" && o.mdfStage && MDF_STAGES.indexOf(o.mdfStage) < MDF_STAGES.indexOf(stage));
  const history = orders.filter((o) => o.mdfStageJobs?.[stage]?.byUid === user.uid && o.mdfStageJobs[stage]?.completedAt)
    .sort((a,b) => (b.mdfStageJobs?.[stage]?.completedAt?.seconds ?? 0) - (a.mdfStageJobs?.[stage]?.completedAt?.seconds ?? 0));
  const doneToday = history.filter((o) => dayKey(o.mdfStageJobs![stage]!.completedAt!.toDate()) === dayKey(new Date()));
  const rows = view === "history" ? history : view === "mine" ? active.filter((o) => o.mdfStageJobs?.[stage]?.byUid === user.uid) : [...active, ...queue, ...upcoming];

  return <AppShell variant="station" title={label} subtitle={userData.name} navKey={view === "history" ? "mdf-history" : "mdf-home"} contentWidth="narrow">
    <WorkerDashboardHeader historyInNav queued={queue.length} active={active.length} done={doneToday.length} view={view} onView={(next) => setParams(next === "queue" ? {} : { view: next })} />
    {view === "queue" && <WorkerSalaryTeaser uid={user.uid} orders={orders} />}
    {view === "history" && <h2>Тарих</h2>}
    {loading ? <Spinner /> : rows.length === 0 ? <div className="empty-state"><p>{view === "history" ? "Аяқталған жұмыс жоқ" : "Бұл тізімде тапсырма жоқ"}</p></div> :
      <div className={view === "history" ? "station-history-list" : "station-job-list"}>{rows.map((order) => {
        if (view === "history") return <WorkerHistoryCard key={order.id} order={order} stage={stage} uid={user.uid} to={`/${userData.role}/order/${order.id}`} />;
        const job = order.mdfStageJobs?.[stage];
        const completed = !!job?.completedAt;
        const current = order.mdfStage === stage && order.productionStatus === "mdf_production";
        const started = current && !!job?.startedAt;
        return <article key={order.id} className={`station-job ${started ? "is-active" : ""}`}>
          <div className="station-job-status"><span className={`station-state ${started ? "is-active" : completed ? "is-done" : ""}`}>{completed ? "ДАЙЫН" : started ? "ЖҰМЫСТА" : "КЕЗЕКТЕ"}</span><span>№{order.priority || 1}</span></div>
          <button className="station-order-link" onClick={() => navigate(`/${userData.role}/order/${order.id}`)}>{order.orderNumber}</button>
          <div className="station-customer"><IconUsers />{order.customerName}</div>
          <div className="station-facts"><span>{formatMdfArea(order.mdfAreaM2)}</span><span>{order.mdfFilmColor || "Түс көрсетілмеген"}</span></div>
          <div className="station-status-line"><PaymentStatusBadge status={order.paymentStatus} /><span>{completed ? `${label} дайын` : started ? `${label} басталды` : current ? "Кезекте" : `${order.mdfStage ? MDF_STAGE_LABELS[order.mdfStage] : "Алдыңғы кезең"} күтілуде`}</span></div>
          {order.adminNote && <p className="station-note">{order.adminNote}</p>}
          {order.productionNote && <p className="station-note">{order.productionNote}</p>}
          {current && <MdfStageActionsPanel order={order} stage={stage} actor={actor} onToast={showToast} />}
        </article>;
      })}</div>}
    <Toast message={message} visible={visible} />
  </AppShell>;
}
