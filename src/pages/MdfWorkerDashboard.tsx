import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { doc, updateDoc } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { Spinner, Toast } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { MdfStageActionsPanel } from "../components/MdfStageActionsPanel";
import { OrderProgress } from "../components/OrderProgress";
import { PaymentStatusBadge } from "../components/StatusBadge";
import { WorkerSalaryTeaser } from "../components/WorkerSalaryTeaser";
import { useMdfOrders } from "../hooks/useOrders";
import { useToast } from "../hooks";
import { ROLE_TO_MDF_STAGE } from "../lib/rbac";
import { dayKey, formatDateDMY } from "../lib/dates";
import { formatMoney } from "../lib/money";
import { formatMdfArea } from "../lib/mdfJournal";
import { MDF_STAGES, MDF_STAGE_LABELS } from "../types/domain";
import type { MdfStage, Order, UserDoc } from "../types/domain";

type Actor = { user: User; userData: UserDoc };

/**
 * The shared МДФ worker screen — ЧПУ/Шкурка/Краска/Вакуум are the same operation repeated, so one
 * page (stage derived from the signed-in role) stands in for what would otherwise be 4 near-copies
 * of CutterDashboard/PvcDashboard. Mirrors PvcDashboard's layout: current job, upcoming queue
 * (including orders still on an earlier station, so a worker can see what's coming).
 */
export default function MdfWorkerDashboard() {
  const { user, userData } = useAuth();
  const navigate = useNavigate();
  const { orders, loading } = useMdfOrders();
  const { message, visible, showToast } = useToast();

  const stage: MdfStage | undefined = userData ? ROLE_TO_MDF_STAGE[userData.role] : undefined;
  const stageIndex = stage ? MDF_STAGES.indexOf(stage) : -1;

  const mine = useMemo(
    () => orders.filter((o) => o.productionStatus === "mdf_production" && o.mdfStage === stage),
    [orders, stage],
  );
  const queued = useMemo(
    () => mine.filter((o) => !o.mdfStageJobs?.[stage!]?.startedAt).sort((a, b) => a.priority - b.priority),
    [mine, stage],
  );
  const inProgress = useMemo(() => mine.filter((o) => o.mdfStageJobs?.[stage!]?.startedAt), [mine, stage]);
  /** Orders still on an earlier station — visible early so the worker can plan, same as PvcDashboard's "awaitingCutting". */
  const upcoming = useMemo(
    () =>
      orders.filter(
        (o) => o.productionStatus === "mdf_production" && o.mdfStage && MDF_STAGES.indexOf(o.mdfStage) < stageIndex,
      ),
    [orders, stageIndex],
  );
  const doneToday = useMemo(() => {
    const today = dayKey(new Date());
    return orders.filter((o) => {
      const completedAt = o.mdfStageJobs?.[stage!]?.completedAt;
      return completedAt && dayKey(completedAt.toDate()) === today;
    });
  }, [orders, stage]);

  const current: Order | undefined = inProgress[0] ?? queued[0];
  const upNext = useMemo(
    () => [...queued.filter((o) => o.id !== current?.id), ...upcoming],
    [queued, current, upcoming],
  );

  if (!user || !userData) return <Spinner />;
  if (!stage) return <Spinner />; // signed in as a non-МДФ role — RouteGuard already prevents this
  const actor: Actor = { user, userData };
  const label = MDF_STAGE_LABELS[stage];

  return (
    <AppShell
      title={`${label} панелі`}
      subtitle={`Сәлем, ${userData.name}`}
      actions={<span className="worker-shift-badge">● Бүгін: Жұмыста</span>}
    >
      <div className="worker-stat-row">
        <div className="worker-stat-card">
          <span className="worker-stat-icon">🕐</span>
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
      ) : !current ? (
        <div className="empty-state">
          <div className="icon">📭</div>
          <p>{label} кезегінде заказ жоқ</p>
        </div>
      ) : (
        <CurrentMdfOrder
          order={current}
          stage={stage}
          actor={actor}
          onToast={showToast}
          onOpen={() => navigate(`/${userData.role}/order/${current.id}`)}
        />
      )}

      {upNext.length > 0 && (
        <section className="panel-card">
          <div className="panel-head">
            <h3>Келесі заказдар (кезек)</h3>
          </div>
          <div className="job-card-list">
            {upNext.map((o) => (
              <MdfJobCard key={o.id} order={o} stage={stage} actor={actor} onToast={showToast} />
            ))}
          </div>
        </section>
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

/** A queued order as this station's worker sees it — same card shape CutterDashboard/PvcDashboard
 *  use. Still on an earlier station ("{Кезең} күтілуде"), or ready for this one. */
function MdfJobCard({
  order,
  stage,
  actor,
  onToast,
}: {
  order: Order;
  stage: MdfStage;
  actor: Actor;
  onToast: (m: string) => void;
}) {
  const waitingForEarlierStage = order.mdfStage !== stage;
  const waitingLabel = order.mdfStage ? MDF_STAGE_LABELS[order.mdfStage] : "";

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
          №{(order.priority ?? 0) + 1} · {formatMdfArea(order.mdfAreaM2)} · {order.mdfFilmColor || "—"}
        </span>
        <PaymentStatusBadge status={order.paymentStatus} />
      </div>
      <OrderProgress order={order} />

      {waitingForEarlierStage ? (
        <div className="job-card-actions">
          <span className="jt-pill jt-tone-muted">{waitingLabel} күтілуде</span>
        </div>
      ) : (
        <MdfStageActionsPanel order={order} stage={stage} actor={actor} onToast={onToast} />
      )}
    </article>
  );
}

function CurrentMdfOrder({
  order,
  stage,
  actor,
  onToast,
  onOpen,
}: {
  order: Order;
  stage: MdfStage;
  actor: Actor;
  onToast: (m: string) => void;
  onOpen: () => void;
}) {
  const [note, setNote] = useState(order.productionNote ?? "");

  const saveNote = async () => {
    if (note === (order.productionNote ?? "")) return;
    try {
      await updateDoc(doc(db, "orders", order.id), { productionNote: note });
      onToast("✅ Ескертпе сақталды");
    } catch (err: unknown) {
      onToast("Қате: " + (err as Error).message);
    }
  };

  return (
    <section className="panel-card worker-current">
      <div className="panel-head">
        <h3>Қазіргі заказ</h3>
      </div>

      <div className="worker-current-num">{order.orderNumber}</div>

      <div className="worker-pvc-headline">
        {order.mdfFilmColor || "Пленка көрсетілмеген"} · {formatMdfArea(order.mdfAreaM2)}
      </div>

      {order.adminNote && <div className="worker-manager-note">📋 Менеджер: {order.adminNote}</div>}

      <div className="worker-current-links">
        <button className="btn btn-outline btn-sm" onClick={onOpen}>
          ⊞ Заказ детальдарын көру
        </button>
      </div>

      <div className="form-group">
        <input
          className="form-input"
          placeholder="Өндіріс ескертпесі..."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
        />
      </div>

      <MdfStageActionsPanel order={order} stage={stage} actor={actor} onToast={onToast} />
    </section>
  );
}
