import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { Spinner } from "../components";
import { useAllOrders } from "../hooks/useOrders";
import { ledgerTotals, materialLedger, type LedgerEntry, type LedgerKind } from "../lib/materialLedger";
import { dayKey, formatDateDMY, inRange, startOfMonthAlmaty } from "../lib/dates";
import type { InventoryMovement, Material } from "../types/domain";

type Filter = "all" | LedgerKind;
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Барлығы" },
  { key: "receipt", label: "Қабылдау" },
  { key: "cut", label: "Кесу" },
  { key: "return", label: "Қайтару" },
  { key: "correction", label: "Түзету" },
];
/** Entries shown before «Тағы»; a material cut every day has hundreds. */
const STEP = 40;

const timeFmt = new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit" });
const shortDateTime = (ms: number) => `${formatDateDMY(ms).slice(0, 5)} ${timeFmt.format(ms)}`;

/** What became of the sheets on a cut, in words. */
function CutLine({ entry }: { entry: LedgerEntry }) {
  const c = entry.cut;
  if (!c) return null;
  switch (c.state) {
    case "done":
      return (
        <div className="mlg-cut is-done">
          ✓ Кесілді{c.byName ? ` · ${c.byName}` : ""} · {shortDateTime(c.atMs)}
          {c.sheets !== -entry.qty ? ` · ${c.sheets} лист кесілді` : ""}
        </div>
      );
    case "cutting":
      return <div className="mlg-cut is-cutting">⏳ Қазір кесіліп жатыр{c.byName ? ` · ${c.byName}` : ""}</div>;
    case "queued":
      return <div className="mlg-cut is-queued">Распил кезегінде — әлі кесілмеді</div>;
    case "without":
      return <div className="mlg-cut is-without">Распилсіз берілді — станокқа түспеді</div>;
    case "cancelled":
      return <div className="mlg-cut is-off">{c.merged ? "Басқа заказға біріктірілді" : "Заказ өшірілді — лист қоймаға қайтарылды"}</div>;
    default:
      return <div className="mlg-cut is-off">Заказ табылмады</div>;
  }
}

function EntryTitle({ entry, orderPath }: { entry: LedgerEntry; orderPath: string }) {
  const icon = entry.kind === "receipt" ? "📦" : entry.kind === "cut" ? "🪚" : entry.kind === "return" ? "↩" : "✏";
  if (entry.order && (entry.kind === "cut" || entry.kind === "return")) {
    return (
      <span className="mlg-title">
        {icon}{" "}
        <Link to={`${orderPath}/${entry.order.id}`} className="mlg-order">{entry.order.code}</Link>
        {entry.order.customerName ? <> · {entry.order.customerName}</> : null}
        {entry.kind === "return" && <small> — қайтарылды</small>}
      </span>
    );
  }
  return <span className="mlg-title">{icon} {entry.label}</span>;
}

/**
 * «Тарих» — one material's every movement, as the owner asked for it (06.11): how many came in and
 * who took them, and for each order the sheets left for — whose it was and how it was cut (on the
 * saw by whom and when, still queued, or handed over whole). Opened from the row's «Тарих».
 */
export function MaterialLedgerModal({ material, onClose }: { material: Material; onClose: () => void }) {
  const { userData } = useAuth();
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const { orders } = useAllOrders();

  useEffect(() => {
    const q = query(collection(db, "inventoryMovements"), where("materialId", "==", material.id), orderBy("createdAt", "desc"));
    return onSnapshot(
      q,
      (snap) => {
        const list: InventoryMovement[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<InventoryMovement, "id">) }));
        setMovements(list);
        setLoading(false);
      },
      () => setLoading(false),
    );
  }, [material.id]);

  const entries = useMemo(() => materialLedger(movements, orders), [movements, orders]);
  return (
    <MaterialLedgerView
      material={material}
      entries={entries}
      loading={loading}
      orderPath={userData?.role === "admin" ? "/admin/order" : "/manager/order"}
      onClose={onClose}
    />
  );
}

/** The list itself, from entries already read (lib/materialLedger.ts). */
export function MaterialLedgerView({
  material,
  entries,
  loading,
  orderPath,
  onClose,
}: {
  material: Pick<Material, "name" | "qtyOnHand">;
  entries: readonly LedgerEntry[];
  loading: boolean;
  /** Where an order code links to — the Admin's or the Manager's order page. */
  orderPath: string;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(STEP);
  const [monthStart] = useState(() => startOfMonthAlmaty(new Date()));
  const [today] = useState(() => dayKey(new Date()));
  const month = useMemo(() => ledgerTotals(entries.filter((e) => inRange(e.atMs, monthStart))), [entries, monthStart]);
  const filtered = useMemo(() => (filter === "all" ? entries : entries.filter((e) => e.kind === filter)), [entries, filter]);
  const visible = filtered.slice(0, shown);
  const days = useMemo(() => {
    const out: { day: string; entries: LedgerEntry[] }[] = [];
    for (const e of visible) {
      const last = out[out.length - 1];
      if (last && last.day === e.day) last.entries.push(e);
      else out.push({ day: e.day, entries: [e] });
    }
    return out;
  }, [visible]);

  return (
    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal mlg" role="dialog" aria-modal="true" aria-labelledby="mlg-title">
        <div className="modal-handle" />
        <h2 id="mlg-title">📜 {material.name}</h2>
        <div className="mlg-summary">
          <span>Қоймада қазір <b>{material.qtyOnHand} лист</b></span>
          <span>Осы ай: қабылданды <b className="is-in">+{month.received}</b> · кесуге <b className="is-out">−{month.cut}</b></span>
        </div>

        <div className="mlg-filters" role="tablist" aria-label="Түрі бойынша">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" role="tab" aria-selected={filter === f.key}
              className={`mlg-filter${filter === f.key ? " is-active" : ""}`}
              onClick={() => { setFilter(f.key); setShown(STEP); }}>
              {f.label}
            </button>
          ))}
        </div>

        {loading ? (
          <Spinner />
        ) : days.length === 0 ? (
          <p className="mlg-empty">Мұнда жазба жоқ</p>
        ) : (
          <div className="mlg-days">
            {days.map((d) => (
              <div key={d.day} className="mlg-day">
                <div className="mlg-day-head">
                  {formatDateDMY(new Date(`${d.day}T12:00:00+05:00`))}{d.day === today ? " · бүгін" : ""}
                </div>
                <ul className="mlg-list">
                  {d.entries.map((e) => (
                    <li key={e.id} className={`mlg-row is-${e.kind}`}>
                      <div className="mlg-top">
                        <EntryTitle entry={e} orderPath={orderPath} />
                        <strong className={e.qty >= 0 ? "is-in" : "is-out"}>{e.qty > 0 ? "+" : e.qty < 0 ? "−" : ""}{Math.abs(e.qty)} лист</strong>
                      </div>
                      <CutLine entry={e} />
                      <div className="mlg-meta">
                        {e.userName}{e.kind === "cut" ? " кезекке қосты" : ""} · {timeFmt.format(e.atMs)} · қоймада {e.balanceBefore} → {e.balanceAfter}
                      </div>
                      {e.shortBy ? <div className="mlg-warn">⚠ Қоймада {e.shortBy} лист жетіспеді</div> : null}
                      {e.note && <div className="mlg-note">💬 {e.note}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {filtered.length > visible.length && (
          <button type="button" className="btn btn-outline btn-full" onClick={() => setShown((n) => n + STEP)}>
            Тағы ({filtered.length - visible.length})
          </button>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Жабу</button>
        </div>
      </div>
    </div>
  );
}
