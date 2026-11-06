import { useMemo, useState } from "react";
import { receiptsByDay, sheetsReceivedByPeriod, type StockReceipt } from "../lib/stockReceipts";
import { dayKey, formatDateDMY } from "../lib/dates";

/** How many days the history opens on; each tap on «Ертерек» shows as many again. */
const DAYS_STEP = 14;

const timeFmt = new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit" });

/** "2026-11-06" → "06.11.2026 · бүгін", read on the Almaty calendar day it names. */
function dayLabel(day: string, today: string, yesterday: string): string {
  const date = formatDateDMY(new Date(`${day}T12:00:00+05:00`));
  return day === today ? `${date} · бүгін` : day === yesterday ? `${date} · кеше` : date;
}

/**
 * «Қабылдау тарихы» on the Қойма page — how many sheets came in, of what, taken by whom and when,
 * and what the rack held before and after (the owner, 06.11: «қанша лист қалай қабылданды дегенді
 * шығар, көрсетіп тұратын істе қоймаға»). Each «+ Қабылдау» was already in the ledger, but only
 * one material at a time behind «Тарих»; here every delivery is in one list, a day to a heading.
 */
export function StockReceiptHistory({ receipts, loading }: { receipts: readonly StockReceipt[]; loading: boolean }) {
  const [materialId, setMaterialId] = useState("");
  const [daysShown, setDaysShown] = useState(DAYS_STEP);
  // Read once, when the page opens — the clock is not something to call on every render.
  const [{ today, yesterday, now }] = useState(() => {
    const at = new Date();
    return { today: dayKey(at), yesterday: dayKey(at.getTime() - 86_400_000), now: at };
  });

  // The materials that have ever been received, for the filter — most received first.
  const options = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; qty: number }>();
    for (const r of receipts) {
      const o = byId.get(r.materialId) ?? { id: r.materialId, name: r.materialName, qty: 0 };
      o.qty += r.qty;
      byId.set(r.materialId, o);
    }
    return [...byId.values()].sort((a, b) => b.qty - a.qty);
  }, [receipts]);

  const filtered = useMemo(
    () => (materialId ? receipts.filter((r) => r.materialId === materialId) : receipts),
    [receipts, materialId],
  );
  const totals = useMemo(() => sheetsReceivedByPeriod(filtered, now), [filtered, now]);
  const days = useMemo(() => receiptsByDay(filtered), [filtered]);
  const since = dayKey(now.getTime() - (daysShown - 1) * 86_400_000);
  const shown = days.filter((d) => d.day >= since);
  const older = days.length - shown.length;

  return (
    <section className="panel-card srh" aria-labelledby="srh-title">
      <div className="srh-head">
        <h2 id="srh-title">📦 Қабылдау тарихы</h2>
        <div className="srh-totals">
          <span>Осы апта <b>{totals.week} лист</b></span>
          <span>Осы ай <b>{totals.month} лист</b></span>
        </div>
      </div>

      {options.length > 1 && (
        <select className="form-input srh-filter" value={materialId} aria-label="Материал бойынша"
          onChange={(e) => setMaterialId(e.target.value)}>
          <option value="">Барлық материал</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      )}

      {loading ? null : shown.length === 0 ? (
        <p className="srh-empty">
          {days.length === 0
            ? "Әзірге қабылдау жоқ. Материалдың жанындағы «+ Қабылдау» басылғанда осында шығады."
            : `Соңғы ${daysShown} күнде қабылдау жоқ.`}
        </p>
      ) : (
        <div className="srh-days">
          {shown.map((d) => (
            <div key={d.day} className="srh-day">
              <div className="srh-day-head">
                <strong>{dayLabel(d.day, today, yesterday)}</strong>
                <span>+{d.qty} лист</span>
              </div>
              <ul className="srh-list">
                {d.receipts.map((r) => (
                  <li key={r.id}>
                    <div className="srh-row-top">
                      <span className="srh-name">{r.materialName}</span>
                      <strong className="srh-qty">+{r.qty} лист</strong>
                    </div>
                    <div className="srh-meta">
                      {r.userName} · {timeFmt.format(r.atMs)} · қоймада {r.balanceBefore} → {r.balanceAfter}
                    </div>
                    {r.note && <div className="srh-note">💬 {r.note}</div>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {older > 0 && (
        <button type="button" className="btn btn-outline btn-sm srh-more" onClick={() => setDaysShown((n) => n + DAYS_STEP)}>
          Ертерек ({older} күн)
        </button>
      )}
    </section>
  );
}
