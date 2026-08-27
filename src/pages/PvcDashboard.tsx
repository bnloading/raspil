import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { doc, updateDoc } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { Spinner, Toast } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { PvcActionsPanel } from "../components/PvcActionsPanel";
import { WorkerSalaryTeaser } from "../components/WorkerSalaryTeaser";
import { usePvcOrders } from "../hooks/useOrders";
import { useOrderParts } from "../hooks/useOrderParts";
import { usePvcTypes } from "../hooks/useMaterials";
import { useToast } from "../hooks";
import { dayKey } from "../lib/dates";
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
  const { orders, loading } = usePvcOrders(user?.uid);
  const { pvcTypes } = usePvcTypes(true);
  const { message, visible, showToast } = useToast();

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
    return pvcOrders.filter((o) => o.pvcCompletedAt && dayKey(o.pvcCompletedAt.toDate()) === today);
  }, [pvcOrders]);

  const current: Order | undefined = inProgress[0] ?? queued[0];
  const upNext = useMemo(
    () => [...queued.filter((o) => o.id !== current?.id), ...awaitingCutting],
    [queued, current, awaitingCutting],
  );

  if (!user || !userData) return <Spinner />;
  const actor: Actor = { user, userData };

  return (
    <AppShell
      title="ПВХ панелі"
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
        <WorkerSalaryTeaser uid={user.uid} />
      </div>

      {loading ? (
        <Spinner />
      ) : !current ? (
        <div className="empty-state">
          <div className="icon">📭</div>
          <p>ПВХ кезегінде заказ жоқ</p>
        </div>
      ) : (
        <CurrentPvcOrder
          order={current}
          actor={actor}
          pvcTypesById={pvcTypesById}
          onToast={showToast}
          onOpen={() => navigate(`/pvc/order/${current.id}`)}
        />
      )}

      {upNext.length > 0 && (
        <section className="panel-card">
          <div className="panel-head">
            <h3>Келесі заказдар (кезек)</h3>
          </div>
          <div className="data-table-wrap">
            <table className="data-table worker-queue-table">
              <thead>
                <tr>
                  <th>Заказ</th>
                  <th>ПВХ</th>
                  <th>Кезек</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {upNext.map((o) => {
                  const waitingForSaw =
                    o.productionStatus === "cutting_queue" || o.productionStatus === "cutting_started";
                  return (
                    <tr key={o.id} onClick={() => navigate(`/pvc/order/${o.id}`)} className="is-clickable">
                      <td>{o.orderNumber}</td>
                      <td>{o.pvcMetersTotal} м</td>
                      <td>№{(o.priority ?? 0) + 1}</td>
                      <td>
                        {waitingForSaw ? (
                          <span className="jt-pill jt-tone-muted">Распил күтілуде</span>
                        ) : (
                          <span className="jt-pill jt-tone-amber">ПВХ кезегінде</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

function CurrentPvcOrder({
  order,
  actor,
  pvcTypesById,
  onToast,
  onOpen,
}: {
  order: Order;
  actor: Actor;
  pvcTypesById: Map<string, PvcType>;
  onToast: (m: string) => void;
  onOpen: () => void;
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

      <div className="worker-current-links">
        <button className="btn btn-outline btn-sm" onClick={onOpen}>
          ⊞ ПВХ детальдарын көру
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

      <PvcActionsPanel order={order} actor={actor} onToast={onToast} />
    </section>
  );
}
