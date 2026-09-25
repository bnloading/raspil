import { jobsOf } from "../lib/orderLines";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { doc, updateDoc } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { Spinner, Toast } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { PvcLineActions } from "../components/PvcActionsPanel";
import { WorkerHistoryCard } from "../components/WorkerHistoryCard";
import { WorkerSalaryTeaser } from "../components/WorkerSalaryTeaser";
import { MaterialThumb } from "../components/MaterialThumb";
import { WorkerHistorySummary } from "../components/WorkerMaterialSummary";
import { workerJobs } from "../lib/workerQuantities";
import { usePvcOrders } from "../hooks/useOrders";
import { useOrderParts } from "../hooks/useOrderParts";
import { useMaterials, usePvcTypes } from "../hooks/useMaterials";
import { useToast } from "../hooks";
import { dayKey, formatDateDMY } from "../lib/dates";
import { computePvcBreakdown, edgeLengthMm } from "../lib/pricing";
import { EDGE_KEYS } from "../types/domain";
import type { EdgeKey, Order, PvcType, UserDoc } from "../types/domain";

type Actor = { user: User; userData: UserDoc };

/**
 * "ПВХ панелі" — the PVC worker's screen. Shows the order they're on with its colour/thickness,
 * total metres and per-edge counts, plus the upcoming queue including orders still being cut
 * (shown as "Распил күтілуде" so the worker can see what's coming). No money anywhere.
 */
export default function PvcDashboard() {
  const { user, userData } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") ?? "queue";
  const { materials } = useMaterials(false);
  const { orders, loading } = usePvcOrders(user?.uid);
  const { pvcTypes } = usePvcTypes(true);
  const { message, visible, showToast } = useToast();
  const [search, setSearch] = useState("");

  const pvcTypesById = useMemo(() => new Map(pvcTypes.map((p) => [p.id, p])), [pvcTypes]);
  const pvcOrders = useMemo(() => orders.filter((o) => o.pvcMetersTotal > 0), [orders]);

  const queued = useMemo(
    () => pvcOrders.filter((o) => o.productionStatus === "pvc_queue").sort((a, b) => a.priority - b.priority),
    [pvcOrders],
  );
  const inProgress = useMemo(() => pvcOrders.filter((o) => o.productionStatus === "pvc_started"), [pvcOrders]);
  /** Paid orders still on the saw — visible early so the worker can plan, per spec. */
  const awaitingCutting = useMemo(
    () =>
      pvcOrders.filter((o) => o.productionStatus === "cutting_queue" || o.productionStatus === "cutting_started"),
    [pvcOrders],
  );
  const doneToday = useMemo(() => {
    const today = dayKey(new Date());
    return pvcOrders.filter(o => jobsOf(o).some(j => j.pvcByUid === user?.uid && j.pvcCompletedAt && dayKey(j.pvcCompletedAt.toDate()) === today));
  }, [pvcOrders, user?.uid]);
  /** "Бүгін дайын: 186 м" — the metres actually banded today, not the order count. Counted per
   *  line, so a two-material order this worker only finished half of contributes only that half. */
  const metersToday = useMemo(() => {
    const today = dayKey(new Date());
    return pvcOrders.reduce((sum, o) => sum + jobsOf(o).reduce((s, j) =>
      j.pvcByUid === user?.uid && j.pvcCompletedAt && dayKey(j.pvcCompletedAt.toDate()) === today
        ? s + (j.pvcMeters ?? 0) : s, 0), 0);
  }, [pvcOrders, user?.uid]);

  if (!user || !userData) return <Spinner />;
  const actor: Actor = { user, userData };

  const history = pvcOrders.filter(o => workerJobs(o, "pvc", user.uid, true).length > 0);
  const matches = (o: Order) => {
    const q = search.trim().toLowerCase();
    return !q || o.customerName.toLowerCase().includes(q) || o.orderNumber.toLowerCase().includes(q);
  };
  // Three bands, not one list: the order being worked on is the headline, what is coming is a
  // list to scan, and what finished today is a receipt. The owner's mockup reads top to bottom
  // in exactly that order.
  const heroRows = inProgress.filter(matches);
  const nextRows = [...queued, ...awaitingCutting].filter(matches);
  // Deduped against the bands above: a two-material order with one side banded today and the
  // other still open belongs to both, and would otherwise be drawn twice under one key.
  const shownIds = new Set([...heroRows, ...nextRows].map(o => o.id));
  const finishedRows = doneToday.filter(o => !shownIds.has(o.id) && matches(o));
  const mineRows = pvcOrders.filter(o => workerJobs(o, "pvc", user.uid, false).length > 0 && matches(o));

  /** The colour and thickness this line is banded with, as the card names it. */
  const pvcFaceOf = (order: Order, index: number) => {
    const line = (order.items ?? [])[index];
    const type = line?.pvcTypeId ? pvcTypesById.get(line.pvcTypeId) : undefined;
    const colour = line?.pvcColorName || type?.colorName || "ПВХ";
    return { type, label: type?.thicknessMm ? `${colour} • ${type.thicknessMm} мм` : colour };
  };

  const heroCard = (order: Order) => {
    const jobs = jobsOf(order).filter(j => (j.pvcMeters ?? 0) > 0);
    return <article key={order.id} className="station-hero" aria-label={`${order.customerName} — қазір жұмыста`}>
      <div className="station-hero-head">
        <div>
          <span className="station-job-eyebrow">Қазір жұмыста</span>
          <strong className="station-hero-customer">{order.customerName}</strong>
          <button className="station-order-link" onClick={() => navigate(`/pvc/order/${order.id}`)}>{order.orderNumber}</button>
        </div>
        <span className="station-state is-working">🕐 Жұмыста</span>
      </div>
      <div className={`station-hero-cut${order.productionStatus.startsWith("cutting") ? "" : " is-done"}`}>
        {order.productionStatus.startsWith("cutting") ? "◷ Распил күтілуде" : "✅ Распил дайын"}
      </div>
      {jobs.map(job => {
        const face = pvcFaceOf(order, job.index);
        return <div className="station-hero-face" key={job.index}>
          <MaterialThumb material={face.type} />
          <span className="station-hero-face-name">{face.label}</span>
          <b className="station-hero-meters">{job.pvcMeters} м</b>
        </div>;
      })}
      {jobs.map(job => job.pvcCompletedAt ? null : (
        <PvcLineActions key={`a${job.index}`} order={order} job={job} actor={actor} onToast={showToast} layout="hero" />
      ))}
      <button className="btn btn-outline station-hero-more" onClick={() => navigate(`/pvc/order/${order.id}`)}>
        Толығырақ
      </button>
      <details className="worker-details"><summary>Бөлшектер, жиектер және ескертпе</summary>
        <CurrentPvcOrder order={order} pvcTypesById={pvcTypesById} onToast={showToast} /></details>
    </article>;
  };

  /** "Айбек · #1043 — Дуб Вотан • 1 мм — 42 м ›" — a line to scan, not a card to read. */
  const queueRow = (order: Order, done = false) => {
    const job = jobsOf(order).find(j => (j.pvcMeters ?? 0) > 0);
    const face = pvcFaceOf(order, job?.index ?? 0);
    return <button key={order.id} className={`station-next-row${done ? " is-done" : ""}`}
      onClick={() => navigate(`/pvc/order/${order.id}`)}>
      <MaterialThumb material={face.type} />
      <span className="station-next-who">
        <strong>{order.customerName} · {order.orderNumber}</strong>
        <small>{done ? "✓ Бүгін бітті" : face.label}</small>
      </span>
      <b className="station-next-meters">{job?.pvcMeters ?? order.pvcMetersTotal} м</b>
      <span className="station-next-chev" aria-hidden="true">›</span>
    </button>;
  };

  return <AppShell variant="station" title="ПВХ панелі" subtitle={`${userData.name} • ${formatDateDMY(new Date())}`} contentWidth="narrow"
    search={{ value: search, onChange: setSearch, placeholder: "Клиент немесе заказ №" }}>
    {/* One segmented row — count and filter together, per the owner's mockup — replacing the old
        stats-then-tabs pair. "Тарих" stays out of it (historyInNav already puts that in the side/
        bottom nav instead), so these three read as "Кезек → Жұмыста → Дайын", the worker's own
        order of the day. */}
    <div className="station-segmented" role="tablist" aria-label="Тапсырмалар сүзгісі">
      <button type="button" role="tab" aria-selected={view === "queue"}
        className={`station-segmented-btn${view === "queue" ? " is-active" : ""}`}
        onClick={() => setParams({})}>
        <span>Кезек</span><b>{queued.length}</b>
      </button>
      <button type="button" role="tab" aria-selected={view === "mine"}
        className={`station-segmented-btn${view === "mine" ? " is-active" : ""}`}
        onClick={() => setParams({ view: "mine" })}>
        <span>Жұмыста</span><b>{inProgress.length}</b>
      </button>
      <button type="button" role="tab" aria-selected={view === "history"}
        className={`station-segmented-btn${view === "history" ? " is-active" : ""}`}
        onClick={() => setParams({ view: "history" })}>
        <span>Дайын</span><b>{doneToday.length}</b>
      </button>
    </div>
    {view === "queue" && <WorkerSalaryTeaser uid={user.uid} orders={orders} />}
    {view === "history" && <WorkerHistorySummary orders={orders} materials={materials} stage="pvc" uid={user.uid} />}
    {loading ? <Spinner /> : view === "history" ? (
      history.length === 0 ? <div className="empty-state"><p>Бұл тізімде тапсырма жоқ</p></div> :
      <div className="station-history-list">
        {history.map(order => <WorkerHistoryCard key={order.id} order={order} stage="pvc" uid={user.uid} materials={materials} to={`/pvc/order/${order.id}`} />)}
      </div>
    ) : view === "mine" ? (
      mineRows.length === 0 ? <div className="empty-state"><p>Қолыңызда тапсырма жоқ</p></div> :
      <>{mineRows.map(heroCard)}</>
    ) : (
      <>
        {heroRows.map(heroCard)}
        {nextRows.length > 0 && (
          <section className="station-next">
            <div className="station-next-head">
              <h3>Келесі заказдар</h3>
              <span>{nextRows.length} заказ</span>
            </div>
            {nextRows.map(o => queueRow(o))}
          </section>
        )}
        {finishedRows.length > 0 && (
          <section className="station-next is-done-section">
            <div className="station-next-head">
              <h3>Бүгін бітті</h3>
              <span>{finishedRows.length} заказ</span>
            </div>
            {finishedRows.map(o => queueRow(o, true))}
          </section>
        )}
        {heroRows.length === 0 && nextRows.length === 0 && finishedRows.length === 0 && (
          <div className="empty-state"><p>Бұл тізімде тапсырма жоқ</p></div>
        )}
      </>
    )}
    {/* The day's own line, at the foot of the list where a shift ends — the segmented row up top
        counts orders, this counts the metres the worker is actually paid on. */}
    {metersToday > 0 && (
      <div className="station-day-foot">
        <span>Бүгін дайын</span>
        <strong>{metersToday.toLocaleString("kk-KZ", { maximumFractionDigits: 1 })} м</strong>
      </div>
    )}
    <Toast message={message} visible={visible} />
  </AppShell>;
}

function CurrentPvcOrder({
  order,
  pvcTypesById,
  onToast,
}: {
  order: Order;
  pvcTypesById: Map<string, PvcType>;
  onToast: (m: string) => void;
}) {
  const { parts, loading } = useOrderParts(order.id);
  const [note, setNote] = useState(order.productionNote ?? "");

  const breakdown = useMemo(() => computePvcBreakdown(parts, pvcTypesById), [parts, pvcTypesById]);
  const partCount = parts.reduce((sum, p) => sum + p.qty, 0);

  /** Metres of edging per side, so the worker knows where the tape actually goes. */
  const edgeMeters = useMemo(() => {
    const totals: Record<EdgeKey, number> = { A: 0, B: 0, C: 0, D: 0 };
    for (const part of parts) {
      for (const edge of EDGE_KEYS) {
        if (part.edges[edge]?.pvc) totals[edge] += (edgeLengthMm(part, edge) * part.qty) / 1000;
      }
    }
    return totals;
  }, [parts]);

  const cuttingDone = order.productionStatus !== "cutting_queue" && order.productionStatus !== "cutting_started";

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
        <span className={`jt-pill jt-tone-${cuttingDone ? "green" : "muted"}`}>
          {cuttingDone ? "Распил дайын ✓" : "Распил күтілуде"}
        </span>
      </div>

      <div className="worker-current-num">{order.orderNumber}</div>

      <div className="worker-pvc-headline">
        {breakdown.length > 0
          ? breakdown.map((b) => `${b.colorName} ПВХ · ${b.thicknessMm} мм`).join(" · ")
          : "ПВХ"}{" "}
        · {order.pvcMetersTotal} м
      </div>
      <div className="worker-field-label">{loading ? "…" : `${partCount} бөлшек`}</div>

      <div className="worker-edge-row">
        <span className="worker-field-label">Қыр жиектері</span>
        <div className="worker-edge-chips">
          {EDGE_KEYS.map((edge) => (
            <span key={edge} className={`worker-edge-chip${edgeMeters[edge] > 0 ? " is-on" : ""}`}>
              <b>{edge}</b> {edgeMeters[edge].toFixed(1)} м
            </span>
          ))}
        </div>
      </div>

      {breakdown.length > 0 && (
        <div className="worker-pvc-breakdown">
          {breakdown.map((b) => (
            <div key={b.key}>
              <span>
                {b.colorName} · {b.thicknessMm} мм
              </span>
              <strong>{b.meters.toFixed(2)} м</strong>
            </div>
          ))}
        </div>
      )}

      {order.adminNote && <div className="worker-manager-note">📋 Менеджер: {order.adminNote}</div>}

      {/* No "detalьдарын көру" link: the part list it opened is the cutter's sheet, not the edge
          bander's — what this station works from is the colour, the thickness and the metres,
          all of which are already on the card. The order number at the top still opens the order
          for anyone who does need it. */}

      <div className="form-group">
        <input
          className="form-input"
          placeholder="Өндіріс ескертпесі..."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
        />
      </div>

      {/* No action buttons in here: the card above already carries one per material. This drawer
          is for the part list, the edges and the note — the things you open it to read. */}
    </section>
  );
}
