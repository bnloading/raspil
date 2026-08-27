import { useMemo } from "react";
import { useAllOrders } from "../hooks/useOrders";
import { Spinner } from "../components";
import { AppShell } from "../components/layout/AppShell";

type LeaderboardEntry = [string, { sheets: number; orders: number; lastSeconds: number }];

/**
 * Admin-only (see App.tsx route guard): ranking customers by real cut-sheet volume is exactly the
 * kind of cross-customer data the new RBAC model restricts to staff — a public/customer-facing
 * leaderboard would leak other customers' identities and order volume.
 */
function getLeaderboard(orders: ReturnType<typeof useAllOrders>["orders"], days = 30): LeaderboardEntry[] {
  const cutoffSeconds = Date.now() / 1000 - days * 24 * 60 * 60;
  const map = new Map<string, { sheets: number; orders: number; lastSeconds: number }>();
  for (const o of orders) {
    if (!o.customerName) continue;
    const created = o.createdAt?.seconds ?? 0;
    if (created < cutoffSeconds) continue;
    const entry = map.get(o.customerName) ?? { sheets: 0, orders: 0, lastSeconds: 0 };
    entry.sheets += o.confirmedSheets ?? o.estimatedSheets ?? 0;
    entry.orders += 1;
    entry.lastSeconds = Math.max(entry.lastSeconds, created);
    map.set(o.customerName, entry);
  }
  return [...map.entries()].sort((a, b) => b[1].sheets - a[1].sheets || b[1].lastSeconds - a[1].lastSeconds).slice(0, 10);
}

export default function Leaderboard() {
  const { orders, loading } = useAllOrders();
  const leaderboard = useMemo(() => getLeaderboard(orders, 30), [orders]);

  return (
    <AppShell title="Рейтинг" subtitle="Ең жақсы жұмысшылар">
      <div className="panel-card">
        <div className="panel-head">
          <h3>Ең көп лист тапсырыс берген клиенттер (соңғы 30 күн)</h3>
        </div>
        {loading ? (
          <Spinner />
        ) : leaderboard.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📊</div>
            <p>Дерек жоқ</p>
          </div>
        ) : (
          <div className="leaderboard-list">
            {leaderboard.map(([name, { sheets, orders: orderCount }], i) => (
              <div className={`leaderboard-row rank-${i + 1}`} key={name}>
                <span className="leaderboard-rank">{i + 1}</span>
                <span className="leaderboard-name">
                  {name} <small>({orderCount} заказ)</small>
                </span>
                <span className="leaderboard-count">{sheets}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
