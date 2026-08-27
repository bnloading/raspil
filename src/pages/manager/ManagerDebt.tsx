import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../AuthContext";
import { Spinner } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { useAllOrders } from "../../hooks/useOrders";
import { computeCustomerDebts } from "../../lib/journal";
import { formatMoney } from "../../lib/money";
import { formatDateDMY } from "../../lib/dates";
import { formatPhone } from "../../lib/phone";
import { exportCsv } from "../../lib/exportTable";

/**
 * "Қарыз" ledger for Admin/Manager — one card per customer, every figure derived from orders via
 * computeCustomerDebts() rather than stored, so it can never disagree with the Manager journal,
 * an order's own detail page, or the reports.
 */
export default function ManagerDebt() {
  const { userData } = useAuth();
  const navigate = useNavigate();
  const { orders, loading } = useAllOrders();
  const [search, setSearch] = useState("");
  const [onlyOwing, setOnlyOwing] = useState(true);

  const debts = useMemo(() => computeCustomerDebts(orders), [orders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return debts.filter((d) => {
      if (onlyOwing && d.debtTiyn <= 0) return false;
      if (!q) return true;
      return d.customerName.toLowerCase().includes(q) || d.customerPhone.includes(q);
    });
  }, [debts, search, onlyOwing]);

  const totals = useMemo(
    () => ({
      debt: debts.reduce((s, d) => s + d.debtTiyn, 0),
      owing: debts.filter((d) => d.debtTiyn > 0).length,
      paid: debts.reduce((s, d) => s + d.paidTiyn, 0),
    }),
    [debts],
  );

  if (!userData) return <Spinner />;

  const handleExport = () =>
    exportCsv(
      "қарыздар",
      filtered.map((d) => ({
        Клиент: d.customerName,
        Телефон: d.customerPhone,
        "Жалпы заказ": d.orderTotalTiyn / 100,
        Төленді: d.paidTiyn / 100,
        Қарыз: d.debtTiyn / 100,
        "Төленбеген заказ": d.unpaidOrderCount,
        "Ең ескі қарыз": d.oldestDebtAtMs ? formatDateDMY(d.oldestDebtAtMs) : "",
      })),
    );

  return (
    <AppShell
      title="Қарыз"
      subtitle={`Сәлем, ${userData.name}`}
      search={{ value: search, onChange: setSearch, placeholder: "Клиент аты немесе телефон..." }}
      actions={
        <button className="btn btn-outline btn-sm" onClick={handleExport}>
          CSV жүктеу
        </button>
      }
    >
      <div className="stats-bar">
        <div className="stat-card">
          <div className="number">{formatMoney(totals.debt)}</div>
          <div className="label">Жалпы қарыз</div>
        </div>
        <div className="stat-card">
          <div className="number">{totals.owing}</div>
          <div className="label">Қарызы бар клиент</div>
        </div>
        <div className="stat-card">
          <div className="number">{formatMoney(totals.paid)}</div>
          <div className="label">Жалпы төленген</div>
        </div>
      </div>

      <div className="status-filter-row">
        <button className={`status-filter-btn${onlyOwing ? " active" : ""}`} onClick={() => setOnlyOwing(true)}>
          <span>Қарызы барлар</span>
          <b>{debts.filter((d) => d.debtTiyn > 0).length}</b>
        </button>
        <button className={`status-filter-btn${!onlyOwing ? " active" : ""}`} onClick={() => setOnlyOwing(false)}>
          <span>Барлық клиент</span>
          <b>{debts.length}</b>
        </button>
      </div>

      <div className="orders-section">
        {loading ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="icon">✅</div>
            <p>Қарызы бар клиент жоқ</p>
          </div>
        ) : (
          filtered.map((d) => (
            <div key={d.customerKey} className="track-card debt-card">
              <div className="track-card-header">
                <span className="track-card-num">{d.customerName}</span>
                <strong className={d.debtTiyn > 0 ? "jt-debt" : "jt-muted"}>{formatMoney(d.debtTiyn)}</strong>
              </div>
              <div className="track-card-meta-row">
                <span>{d.customerPhone ? formatPhone(d.customerPhone) : "—"}</span>
                <span>Заказ сомасы: {formatMoney(d.orderTotalTiyn)}</span>
              </div>
              <div className="track-card-meta-row">
                <span>Төленді: {formatMoney(d.paidTiyn)}</span>
                <span>Төленбеген: {d.unpaidOrderCount}</span>
                {d.oldestDebtAtMs && <span>Ең ескі: {formatDateDMY(d.oldestDebtAtMs)}</span>}
              </div>
              <div className="track-card-meta-row">
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => navigate(`/manager/journal?q=${encodeURIComponent(d.customerName)}`)}
                >
                  Заказдарын көру →
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </AppShell>
  );
}
