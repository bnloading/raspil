import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { Spinner, Toast } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { CuttingActionsPanel } from "../components/CuttingActionsPanel";
import { WorkerSalaryTeaser } from "../components/WorkerSalaryTeaser";
import { useCutterOrders } from "../hooks/useOrders";
import { useOrderParts } from "../hooks/useOrderParts";
import { useToast } from "../hooks";
import { dayKey } from "../lib/dates";
import { materialSummary } from "../lib/journal";
import { EDGE_KEYS } from "../types/domain";
import type { Order } from "../types/domain";

const GRAIN_LABELS: Record<string, string> = { vertical: "Тік", horizontal: "Көлденең", any: "Маңызды емес" };

/**
 * "Распил панелі" — the cutting worker's whole job on one screen: how much work is waiting, the
 * one order they're on right now with its start/finish controls, and the queue behind it.
 * Deliberately shows no money, no customer contact details and no other role's controls.
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

  // The order the worker is actually on: whatever they've started, else the front of the queue.
  const current: Order | undefined = inProgress[0] ?? queued[0];
  const upNext = useMemo(() => queued.filter((o) => o.id !== current?.id), [queued, current]);

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
      ) : !current ? (
        <div className="empty-state">
          <div className="icon">📭</div>
          <p>Кезекте заказ жоқ</p>
        </div>
      ) : (
        <CurrentCuttingOrder
          order={current}
          actor={actor}
          onToast={showToast}
          onOpen={() => navigate(`/cutting/order/${current.id}`)}
        />
      )}

      {upNext.length > 0 && (
        <section className="panel-card">
          <div className="panel-head">
            <h3>Кезек тізімі</h3>
          </div>
          <div className="data-table-wrap">
            <table className="data-table worker-queue-table">
              <thead>
                <tr>
                  <th>Заказ</th>
                  <th>Материалдар</th>
                  <th>Кезек</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {upNext.map((o) => (
                  <tr key={o.id} onClick={() => navigate(`/cutting/order/${o.id}`)} className="is-clickable">
                    <td>{o.orderNumber}</td>
                    <td>{materialSummary(o)}</td>
                    <td>№{(o.priority ?? 0) + 1}</td>
                    <td><span className="jt-pill jt-tone-amber">⏳ Кезекте</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

function CurrentCuttingOrder({
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
  const { parts, loading } = useOrderParts(order.id);
  const [note, setNote] = useState(order.productionNote ?? "");

  const needsPvc = parts.some((p) => EDGE_KEYS.some((e) => p.edges[e]?.pvc));
  const partCount = parts.reduce((sum, p) => sum + p.qty, 0);
  const grainLabel = useMemo(() => {
    const unique = [...new Set(parts.map((p) => p.grainDirection))];
    return unique.map((g) => GRAIN_LABELS[g] ?? g).join(", ");
  }, [parts]);

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
        <span className="jt-pill jt-tone-green">Төленді</span>
      </div>

      <div className="worker-current-num">{order.orderNumber}</div>

      <div className="worker-current-grid">
        <div>
          <span className="worker-field-label">Кезек</span>
          <strong>№{(order.priority ?? 0) + 1}</strong>
        </div>
        <div>
          <span className="worker-field-label">Материалдар</span>
          <strong>{materialSummary(order)}</strong>
        </div>
        <div>
          <span className="worker-field-label">Бөлшек саны</span>
          <strong>{loading ? "…" : `${partCount} бөлшек`}</strong>
        </div>
        <div>
          <span className="worker-field-label">Материал</span>
          <strong>
            {order.materialSnapshot.name} {order.materialSnapshot.thicknessMm} мм
          </strong>
        </div>
        {grainLabel && (
          <div>
            <span className="worker-field-label">Талшық бағыты</span>
            <strong>{grainLabel}</strong>
          </div>
        )}
      </div>

      {order.adminNote && <div className="worker-manager-note">📋 Менеджер: {order.adminNote}</div>}

      <div className="worker-current-links">
        <button className="btn btn-outline btn-sm" onClick={onOpen}>
          ⊞ Размерлерді көру
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

      <CuttingActionsPanel order={order} actor={actor} needsPvc={needsPvc} onToast={onToast} />
    </section>
  );
}
