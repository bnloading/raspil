import { useOrders, type Order } from "../hooks";
import { useMemo } from "react";
import { Spinner, TrackBottomNav } from "../components";

type LeaderboardEntry = [string, { count: number; last: number }];

// Leaderboard utility: group by clientName, count sheets from descriptions, sort desc
function getLeaderboard(orders: Order[], days = 30): LeaderboardEntry[] {
  const now = new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const map = new Map<string, { count: number; last: number }>();
  for (const o of orders) {
    if (!o.clientName) continue;
    if (o.createdAt && o.createdAt.seconds * 1000 < cutoff.getTime()) continue;
    const name = o.clientName.trim();
    if (!name) continue;
    if (!map.has(name)) map.set(name, { count: 0, last: 0 });
    const entry = map.get(name)!;
    // Count sheets from descriptions (e.g. "3 лист", "5 лист")
    if (o.items && Array.isArray(o.items)) {
      for (const item of o.items) {
        const desc = (item.description || "").toString();
        // Extract numbers from description
        const numbers = desc.match(/\d+/g);
        if (numbers && numbers.length > 0) {
          // Sum all numbers found (e.g., "3 лист ақ 5 лист хдф" -> 3 + 5 = 8)
          entry.count += numbers.reduce(
            (sum: number, num: string) => sum + parseInt(num, 10),
            0,
          );
        }
      }
    }
    if (o.createdAt) entry.last = Math.max(entry.last, o.createdAt.seconds);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last)
    .slice(0, 10);
}

export default function Leaderboard() {
  const { orders, loading } = useOrders();
  const leaderboard = useMemo(() => getLeaderboard(orders, 30), [orders]);

  return (
    <div className="figma-track-page">
      <div className="leaderboard-hero">
        <h1>🏆 Leaderboard</h1>
        <p>Ең көп заказ істеген клиенттер</p>
      </div>

      <div className="orders-section">
        {loading ? (
          <Spinner />
        ) : leaderboard.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📊</div>
            <p>Дерек жоқ</p>
          </div>
        ) : (
          <div className="leaderboard-list">
            {leaderboard.map(([name, { count }], i) => (
              <div className={`leaderboard-row rank-${i + 1}`} key={name}>
                <span className="leaderboard-rank">{i + 1}</span>
                <span className="leaderboard-name">{name}</span>
                <span className="leaderboard-count">{count}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="track-page-spacer" />
      <TrackBottomNav active="leaderboard" />
    </div>
  );
}
