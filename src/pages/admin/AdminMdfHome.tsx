import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../AuthContext";
import { Spinner } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { BarChart } from "../../components/BarChart";
import { IconLayers, IconOrders, IconWarehouse } from "../../components/layout/icons";
import { useAllOrders } from "../../hooks/useOrders";
import { useStaff } from "../../hooks/useStaff";
import { formatMoney } from "../../lib/money";
import { formatMdfArea } from "../../lib/mdfJournal";
import { formatDateDMY } from "../../lib/dates";
import {
  computeMdfBoard,
  computeMdfOverdue,
  computeMdfWeeklyOutput,
  computeMdfWorkerLoadToday,
} from "../../lib/mdfDashboardStats";
import { MDF_STAGES, MDF_STAGE_LABELS } from "../../types/domain";
import type { MdfStage } from "../../types/domain";

const STAGE_ROLE: Record<MdfStage, "cnc" | "sanding" | "painting" | "vacuum"> = {
  cnc: "cnc",
  sanding: "sanding",
  painting: "painting",
  vacuum: "vacuum",
};

/**
 * "МДФ өндірісі" — the admin's production board for the МДФ line, parallel to the "Өндіріс
 * барысы" strip on the main dashboard but scoped to орderKind "mdf_wrap": a kanban-style column
 * per station, per-worker today's load, weekly output, and orders running past their estimate.
 */
export default function AdminMdfHome() {
  const { userData } = useAuth();
  const navigate = useNavigate();
  const { orders, loading: ordersLoading } = useAllOrders();
  const { staff, loading: staffLoading } = useStaff();

  const loading = ordersLoading || staffLoading;
  const mdfOrders = useMemo(() => orders.filter((o) => o.orderKind === "mdf_wrap"), [orders]);

  const board = useMemo(() => computeMdfBoard(orders), [orders]);
  const overdue = useMemo(() => computeMdfOverdue(orders), [orders]);
  const weeklyOutput = useMemo(() => computeMdfWeeklyOutput(orders), [orders]);

  const inProduction = mdfOrders.filter((o) => o.productionStatus === "mdf_production").length;
  const ready = mdfOrders.filter((o) => o.productionStatus === "ready" || o.productionStatus === "delivered").length;
  const unpaidTiyn = mdfOrders.reduce((s, o) => s + (o.paymentStatus === "unpaid" ? o.totalTiyn : 0), 0);

  const workersByStage = useMemo(() => {
    const map = new Map<MdfStage, { name: string; load: number }[]>();
    for (const stage of MDF_STAGES) {
      const loadByName = computeMdfWorkerLoadToday(orders, stage);
      const workers = staff
        .filter((s) => s.role === STAGE_ROLE[stage])
        .map((s) => ({ name: s.name, load: loadByName.get(s.name) ?? 0 }));
      map.set(stage, workers);
    }
    return map;
  }, [orders, staff]);

  if (!userData) return <Spinner />;

  return (
    <AppShell title="МДФ өндірісі" subtitle={`Сәлем, ${userData.name}`}>
      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-card-icon"><IconLayers /></div>
              <div className="number">{mdfOrders.length}</div>
              <div className="label">Барлығы</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-icon"><IconOrders /></div>
              <div className="number">{inProduction}</div>
              <div className="label">Жұмыста</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-icon"><IconWarehouse /></div>
              <div className="number">{ready}</div>
              <div className="label">Дайын</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-icon"><IconOrders /></div>
              <div className="number">{formatMoney(unpaidTiyn)}</div>
              <div className="label">Төленбеген</div>
            </div>
          </div>

          {overdue.length > 0 && (
            <div className="empty-state" style={{ background: "var(--danger-light)" }}>
              <div className="icon">⚠️</div>
              <p>{overdue.length} заказ мерзімінен кешікті</p>
            </div>
          )}

          <section className="panel-card">
            <div className="panel-head">
              <h3>Өндіріс барысы</h3>
            </div>
            <div className="mdf-board">
              {board.map((col) => (
                <div key={col.key} className="mdf-board-col">
                  <div className="mdf-board-col-head">
                    <span>{col.label}</span>
                    <b>{col.count}</b>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="dashboard-grid">
            <div className="panel-card span-2">
              <div className="chart-card-head">
                <h3>Апталық өндіріс (м²)</h3>
              </div>
              <BarChart data={weeklyOutput} valueFormatter={(v) => `${v} м²`} />
            </div>

            <div className="panel-card span-2">
              <div className="panel-head">
                <h3>Жұмысшылар</h3>
              </div>
              <div className="worker-stat-row">
                {MDF_STAGES.map((stage) => (
                  <div key={stage} className="worker-stat-card">
                    <span className="worker-stat-icon"><IconLayers /></span>
                    <div>
                      <div className="worker-stat-cap">{MDF_STAGE_LABELS[stage]}</div>
                      {(workersByStage.get(stage) ?? []).length === 0 ? (
                        <div className="worker-stat-num" style={{ fontSize: "0.85rem" }}>—</div>
                      ) : (
                        (workersByStage.get(stage) ?? []).map((w) => (
                          <div key={w.name} className="track-card-meta-row">
                            <span>{w.name}</span>
                            <span>{w.load} заказ</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {overdue.length > 0 && (
            <section className="panel-card">
              <div className="panel-head">
                <h3>Мерзімінен кешіккен заказдар</h3>
              </div>
              <div className="orders-section">
                {overdue.map((o) => (
                  <div key={o.id} className="track-card" onClick={() => navigate(`/manager/order/${o.id}`)}>
                    <div className="track-card-header">
                      <span className="track-card-num">{o.orderNumber} · {o.customerName}</span>
                      <strong className="jt-debt">
                        {o.mdfStage ? MDF_STAGE_LABELS[o.mdfStage] : ""}
                      </strong>
                    </div>
                    <div className="track-card-meta-row">
                      <span>{formatMdfArea(o.mdfAreaM2)} · {o.mdfFilmColor || "—"}</span>
                      {o.createdAt && <span>{formatDateDMY(o.createdAt)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </AppShell>
  );
}
