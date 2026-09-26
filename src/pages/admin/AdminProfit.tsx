import { useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { doc, setDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { ProfitCard } from "../../components/ProfitCard";
import { DepositCard } from "../../components/DepositCard";
import { useToast } from "../../hooks";
import { useAllOrders } from "../../hooks/useOrders";
import { useMaterials, usePvcTypes } from "../../hooks/useMaterials";
import { useMaterialCosts } from "../../hooks/useMaterialCosts";
import { useDepartmentCashbox } from "../../hooks/useDepartmentCashbox";
import { logAudit } from "../../lib/audit";
import { formatMoney, parseMoneyInput } from "../../lib/money";
import { formatDateDMY } from "../../lib/dates";
import {
  computeOrderProfits,
  formatMeters,
  formatStartDate,
  pvcCostKey,
  PROFIT_START_DATE,
  PVC_DEFAULT_COST_KEY,
  signedMoney,
} from "../../lib/orderProfit";
import type { MaterialProfit, ProfitSummary, PvcProfit } from "../../lib/orderProfit";
import { departmentOf, departmentOfOrder } from "../../lib/rbac";
import type { Material, PvcType } from "../../types/domain";

/**
 * "Таза пайда" — the owner's own page: for every sheet and every ПВХ colour sold since 22.09,
 * what it sold for less what it was bought for wholesale, times how many went out — "Ақ:
 * 16 200 − 13 000 = 3 200 ₸ × 45 лист". The wholesale price is typed right there in the row, by
 * the owner, because only the owner knows it. Admin-only (route and firestore.rules both).
 */
export default function AdminProfit() {
  const { user, userData } = useAuth();
  const navigate = useNavigate();
  const myDepartment = userData ? departmentOf(userData) : "ldsp";
  const { orders: allOrders, loading: ordersLoading } = useAllOrders();
  const { materials: allMaterials, loading: materialsLoading } = useMaterials(false);
  const { pvcTypes, loading: pvcLoading } = usePvcTypes(false);
  const { costs, available, loading: costsLoading } = useMaterialCosts();
  const { message, visible, showToast } = useToast();

  // One line's books at a time, as everywhere else an Admin reads money (lib/rbac.ts).
  const orders = useMemo(() => allOrders.filter((o) => departmentOfOrder(o) === myDepartment), [allOrders, myDepartment]);
  const materials = useMemo(
    () => allMaterials.filter((m) => (m.category === "mdf") === (myDepartment === "mdf")),
    [allMaterials, myDepartment],
  );
  const freeMaterialIds = useMemo(
    () => new Set(allMaterials.filter((m) => m.stockTracked === false).map((m) => m.id)),
    [allMaterials],
  );
  const categoryByMaterialId = useMemo(
    () => new Map(allMaterials.map((m) => [m.id, m.category ?? "ldsp"] as const)),
    [allMaterials],
  );
  const summary = useMemo(
    () => computeOrderProfits({ orders, costs, freeMaterialIds, categoryByMaterialId }),
    [orders, costs, freeMaterialIds, categoryByMaterialId],
  );
  // Нұр's balance for the head of the page — the Касса page's own figure (hooks/useDepartmentCashbox).
  const cash = useDepartmentCashbox({ orders: allOrders, department: myDepartment });
  const nurNow = cash.now.accounts.find((a) => a.account === "deposit");
  const nurMonth = cash.thisMonth.accounts.find((a) => a.account === "deposit");

  const savePrice = async (key: string, tiyn: number, label: string) => {
    if (!user || !userData) return;
    const before = costs.get(key) ?? 0;
    await setDoc(doc(db, "materialCosts", key), { purchasePriceTiyn: tiyn }, { merge: true });
    await logAudit(db, { user, userData }, {
      action: "purchasePrice.update",
      entityType: key.startsWith("pvc_") ? "pvcType" : "material",
      entityId: key,
      before: { purchasePriceTiyn: before },
      after: { purchasePriceTiyn: tiyn },
      comment: label,
    }).catch(() => {});
    showToast(`✅ ${label}: оптом ${formatMoney(tiyn)}`);
  };

  if (!userData) return <Spinner />;
  const loading = ordersLoading || materialsLoading || pvcLoading || costsLoading || cash.loading;

  return (
    <AppShell title="Таза пайда" subtitle={`${formatStartDate(PROFIT_START_DATE)} бастапқы заказдар`}>
      {loading ? (
        <Spinner />
      ) : !available ? (
        <div className="empty-state"><p>Оптом бағаларды тек админ көре алады.</p></div>
      ) : (
        <ProfitView
          header={nurNow && nurMonth && (
            <DepositCard now={nurNow} month={nurMonth} monthKey={cash.monthKey}
              openingTiyn={cash.openingBalanceTiyn.deposit ?? 0} startDate={cash.startDate} />
          )}
          summary={summary}
          materials={materials}
          pvcTypes={pvcTypes}
          costs={costs}
          freeMaterialIds={freeMaterialIds}
          onSavePrice={savePrice}
          onOpenOrder={(id) => navigate(`/admin/order/${id}`)}
        />
      )}
      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

type SavePrice = (key: string, tiyn: number, label: string) => Promise<void>;

/** The page without its data hooks — tests/mobile-design-preview.tsx renders it on sample figures. */
export function ProfitView({
  header,
  summary,
  materials,
  pvcTypes,
  costs,
  freeMaterialIds,
  onSavePrice,
  onOpenOrder,
}: {
  /** Drawn first and biggest — the Нұр balance (DepositCard). */
  header?: ReactNode;
  summary: ProfitSummary;
  materials: Material[];
  pvcTypes: PvcType[];
  costs: ReadonlyMap<string, number>;
  freeMaterialIds: ReadonlySet<string>;
  onSavePrice: SavePrice;
  onOpenOrder: (orderId: string) => void;
}) {
  const [tab, setTab] = useState<"items" | "orders">("items");
  const tabs = useRef<HTMLDivElement>(null);
  const openPrices = () => {
    setTab("items");
    tabs.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="aps">
      {header}
      <ProfitCard summary={summary} onFixPrices={openPrices} />

      <div className="prf-tabs" role="tablist" aria-label="Таза пайда" ref={tabs}>
        <button type="button" role="tab" aria-selected={tab === "items"} className={tab === "items" ? "is-active" : ""}
          onClick={() => setTab("items")}>
          Материалдар
          {(summary.uncostedSheets > 0 || summary.uncostedCountertops > 0 || summary.uncostedPvcMeters > 0) && (
            <span className="prf-dot" aria-label="оптом бағасы жоқ" />
          )}
        </button>
        <button type="button" role="tab" aria-selected={tab === "orders"} className={tab === "orders" ? "is-active" : ""}
          onClick={() => setTab("orders")}>
          Әр заказ <b>{summary.orders.length}</b>
        </button>
      </div>

      {tab === "items" ? (
        <Breakdown
          summary={summary}
          materials={materials}
          pvcTypes={pvcTypes}
          costs={costs}
          freeMaterialIds={freeMaterialIds}
          onSavePrice={onSavePrice}
        />
      ) : (
        <OrderList summary={summary} onOpenOrder={onOpenOrder} />
      )}
    </div>
  );
}

/**
 * Where the profit came from: each sheet, each ПВХ colour, then распил and the rest. The rows the
 * period actually sold come first — they are the figure — and everything unsold sits folded
 * underneath, so a price can be set before the first sheet of it goes out.
 */
function Breakdown({
  summary,
  materials,
  pvcTypes,
  costs,
  freeMaterialIds,
  onSavePrice,
}: {
  summary: ProfitSummary;
  materials: Material[];
  pvcTypes: PvcType[];
  costs: ReadonlyMap<string, number>;
  freeMaterialIds: ReadonlySet<string>;
  onSavePrice: SavePrice;
}) {
  const materialById = new Map(materials.map((m) => [m.id, m]));
  const pvcById = new Map(pvcTypes.map((p) => [p.id, p]));
  const soldMaterialIds = new Set(summary.materials.map((m) => m.materialId));
  // A customer's own board is not bought by the shop, so it has no wholesale to set — it is never
  // offered in the "not sold yet" price lists.
  const unsold = (countertop: boolean) => materials
    .filter((m) => !soldMaterialIds.has(m.id) && m.active && !m.archived && !freeMaterialIds.has(m.id)
      && (m.category === "countertop") === countertop)
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const soldPvcIds = new Set(summary.pvc.map((p) => p.pvcTypeId));
  const unsoldPvc = pvcTypes
    .filter((p) => !soldPvcIds.has(p.id) && p.active)
    .sort((a, b) => pvcName(a).localeCompare(pvcName(b), "ru"));
  const defaultPvc = costs.get(PVC_DEFAULT_COST_KEY) ?? 0;

  const soldMaterial = (m: MaterialProfit, unit: string) => {
    const name = materialById.get(m.materialId)?.name ?? m.name;
    // A customer's own board or countertop: what the line billed is the labour to cut it, and
    // there is no wholesale behind it to subtract.
    if (freeMaterialIds.has(m.materialId)) {
      // Billed through Распил instead (a customer's own countertop is quoted by length) — its
      // money is on that line, and a "+0 ₸" row here would only look like something went wrong.
      if (m.revenueTiyn === 0) return null;
      return (
        <FlatRow key={m.materialId} name={name} amountTiyn={m.profitTiyn}
          note={`${m.sheets} ${unit} · клиенттің өз материалы — оптом құны жоқ, түскені кесу ақысы`} />
      );
    }
    return (
      <ItemRow
        key={m.materialId}
        name={name}
        unit={unit}
        qty={m.sheets}
        qtyLabel={`${m.sheets} ${unit}`}
        revenueTiyn={m.revenueTiyn}
        sellTiyn={Math.round(m.revenueTiyn / m.sheets)}
        sellVaried={m.minPriceTiyn !== m.maxPriceTiyn}
        wholesaleTiyn={m.wholesaleTiyn}
        profitTiyn={m.profitTiyn}
        missing={m.wholesaleTiyn <= 0}
        onSave={(tiyn) => onSavePrice(m.materialId, tiyn, name)}
      />
    );
  };
  const unsoldMaterial = (m: Material, unit: string) => (
    <ItemRow
      key={m.id}
      name={m.name}
      unit={unit}
      sellTiyn={m.sellingPriceTiyn}
      wholesaleTiyn={costs.get(m.id) ?? 0}
      missing={false}
      onSave={(tiyn) => onSavePrice(m.id, tiyn, m.name)}
    />
  );
  /** Листтар and Столешница: the same sum, sheets counted per sheet and countertops per piece. */
  const materialSection = ({ id, title, countertop, unit, profitTiyn, hint, empty, unsoldTitle }: {
    id: string; title: string; countertop: boolean; unit: string; profitTiyn: number; hint: string; empty: string; unsoldTitle: string;
  }) => {
    const sold = summary.materials.filter((m) => m.countertop === countertop);
    const rest = unsold(countertop);
    if (countertop && sold.length === 0 && rest.length === 0) return null;
    return (
      <section className="aps-card prf-section" aria-labelledby={id}>
        <div className="aps-head">
          <h2 id={id}>{title}</h2>
          <b className={`prf-section-sum${profitTiyn < 0 ? " is-negative" : ""}`}>{signedMoney(profitTiyn)}</b>
        </div>
        <p className="prf-hint">{hint}</p>
        {sold.length === 0 && <p className="prf-empty">{empty}</p>}
        {sold.map((m) => soldMaterial(m, unit))}
        {rest.length > 0 && (
          <details className="prf-more">
            <summary>{unsoldTitle} ({rest.length})</summary>
            {rest.map((m) => unsoldMaterial(m, unit))}
          </details>
        )}
      </section>
    );
  };
  const soldPvc = (p: PvcProfit) => {
    if (p.pvcTypeId === null) {
      // Metres typed with no colour, plus the прифуговка surcharge — costed at the general price.
      return p.meters > 0 ? (
        <ItemRow
          key="none"
          name="Түсі жазылмаған ПВХ"
          note={colourlessNote(p)}
          unit="м"
          qty={p.meters}
          qtyLabel={formatMeters(p.meters)}
          revenueTiyn={p.revenueTiyn}
          sellTiyn={Math.round(p.revenueTiyn / p.meters)}
          wholesaleTiyn={p.wholesaleTiyn}
          profitTiyn={p.profitTiyn}
          missing={p.wholesaleTiyn <= 0}
        />
      ) : (
        <FlatRow key="none" name="Прифуговка үстемесі" note="Оптом құны жоқ — толығымен пайда" amountTiyn={p.profitTiyn} />
      );
    }
    const type = pvcById.get(p.pvcTypeId);
    const name = type ? pvcName(type) : p.name || "ПВХ";
    const id = p.pvcTypeId;
    return (
      <ItemRow
        key={id}
        name={name}
        note={!p.ownPrice && p.wholesaleTiyn > 0 ? "Оптомы — жалпы баға. Өз бағасын жазсаңыз, соны алады." : undefined}
        unit="м"
        qty={p.meters}
        qtyLabel={formatMeters(p.meters)}
        revenueTiyn={p.revenueTiyn}
        sellTiyn={Math.round(p.revenueTiyn / p.meters)}
        wholesaleTiyn={p.wholesaleTiyn}
        inputTiyn={p.ownPrice ? p.wholesaleTiyn : 0}
        placeholderTiyn={p.ownPrice ? undefined : defaultPvc}
        profitTiyn={p.profitTiyn}
        missing={p.wholesaleTiyn <= 0}
        onSave={(tiyn) => onSavePrice(pvcCostKey(id), tiyn, `ПВХ ${name}`)}
      />
    );
  };

  return (
    <>
      {materialSection({
        id: "prf-sheets", title: "Листтан пайда", countertop: false, unit: "лист", profitTiyn: summary.sheetProfitTiyn,
        hint: "Сату бағасы − оптом бағасы = 1 листтің пайдасы. Оптом бағасын өзіңіз жазыңыз.",
        empty: "Бұл кезеңде лист сатылмаған", unsoldTitle: "Әлі сатылмаған листтар",
      })}

      {materialSection({
        id: "prf-tops", title: "Столешницадан пайда", countertop: true, unit: "дана", profitTiyn: summary.countertopProfitTiyn,
        hint: "1 дананың сату бағасы − оптом бағасы. Оптом бағасын өзіңіз жазыңыз.",
        empty: "Бұл кезеңде столешница сатылмаған", unsoldTitle: "Әлі сатылмаған столешницалар",
      })}

      <section className="aps-card prf-section" aria-labelledby="prf-pvc">
        <div className="aps-head">
          <h2 id="prf-pvc">ПВХ-дан пайда</h2>
          <b className={`prf-section-sum${summary.pvcProfitTiyn < 0 ? " is-negative" : ""}`}>{signedMoney(summary.pvcProfitTiyn)}</b>
        </div>
        <p className="prf-hint">1 метрдің сату бағасы − оптом бағасы. Түстің өз бағасы болмаса, жалпы баға алынады.</p>
        <div className="prf-general">
          <span>
            <strong>Жалпы оптом баға</strong>
            <small>Барлық ПВХ, 1 метр</small>
          </span>
          <PriceInput valueTiyn={defaultPvc} label="ПВХ жалпы оптом бағасы, ₸ / м"
            onSave={(tiyn) => onSavePrice(PVC_DEFAULT_COST_KEY, tiyn, "ПВХ жалпы баға")} />
        </div>
        {summary.pvc.map(soldPvc)}
        {unsoldPvc.length > 0 && (
          <details className="prf-more">
            <summary>Әлі сатылмаған түстер ({unsoldPvc.length})</summary>
            {unsoldPvc.map((p) => (
              <ItemRow
                key={p.id}
                name={pvcName(p)}
                unit="м"
                sellTiyn={p.pricePerMeterTiyn}
                wholesaleTiyn={(costs.get(pvcCostKey(p.id)) ?? 0) || defaultPvc}
                inputTiyn={costs.get(pvcCostKey(p.id)) ?? 0}
                placeholderTiyn={defaultPvc}
                missing={false}
                onSave={(tiyn) => onSavePrice(pvcCostKey(p.id), tiyn, `ПВХ ${pvcName(p)}`)}
              />
            ))}
          </details>
        )}
      </section>

      {(summary.cuttingTiyn !== 0 || summary.otherTiyn !== 0) && (
        <section className="aps-card prf-section" aria-labelledby="prf-services">
          <div className="aps-head">
            <h2 id="prf-services">Распил және басқа</h2>
            <b className="prf-section-sum">{signedMoney(summary.cuttingTiyn + summary.otherTiyn)}</b>
          </div>
          <p className="prf-hint">Бұлардың оптом құны жоқ — түскені толығымен пайда.</p>
          {summary.cuttingTiyn !== 0 && <FlatRow name="Распил" amountTiyn={summary.cuttingTiyn} />}
          {summary.otherTiyn !== 0 && (
            <FlatRow name="ХДФ, қызмет, жеткізу" note="Жеңілдіктер шегерілген" amountTiyn={summary.otherTiyn} />
          )}
        </section>
      )}
    </>
  );
}

/**
 * One sheet or colour, worked out the way the owner does it on paper:
 *   Сату 16 200 − Оптом [13 000] = 3 200 ₸ / лист
 *   45 лист × 3 200 = 144 000 ₸
 * The wholesale price is the box in the middle.
 */
function ItemRow({
  name,
  note,
  unit,
  qty,
  qtyLabel,
  revenueTiyn,
  sellTiyn,
  sellVaried = false,
  wholesaleTiyn,
  inputTiyn = wholesaleTiyn,
  placeholderTiyn,
  profitTiyn,
  missing,
  onSave,
}: {
  name: string;
  note?: string;
  unit: string;
  /** Sold quantity; absent on a row that has not sold yet. */
  qty?: number;
  qtyLabel?: string;
  revenueTiyn?: number;
  /** Per unit — the average when the period sold it at more than one price. */
  sellTiyn: number;
  sellVaried?: boolean;
  /** The wholesale actually applied, per unit. */
  wholesaleTiyn: number;
  /** What the box shows — a colour priced by the general rate shows it as a placeholder instead. */
  inputTiyn?: number;
  placeholderTiyn?: number;
  profitTiyn?: number;
  missing: boolean;
  /** Absent: the row's price is not its own to set (the no-colour ПВХ row). */
  onSave?: (tiyn: number) => Promise<void>;
}) {
  const perUnit = wholesaleTiyn > 0 ? sellTiyn - wholesaleTiyn : null;
  const sold = qty !== undefined && profitTiyn !== undefined;

  return (
    <div className={`prf-item${missing ? " is-missing" : ""}`}>
      <div className="prf-item-head">
        <strong>{name}</strong>
        {sold && <b className={profitTiyn < 0 ? "is-negative" : undefined}>{signedMoney(profitTiyn)}</b>}
      </div>
      {sold && revenueTiyn !== undefined && (
        <p className="prf-item-sub">{qtyLabel} сатылды · {formatMoney(revenueTiyn)}</p>
      )}
      <div className="prf-formula">
        <span className="prf-f">
          <small>{sellVaried ? "Сату (орта)" : "Сату"}</small>
          <b>{formatMoney(sellTiyn)}</b>
        </span>
        <span className="prf-op" aria-hidden="true">−</span>
        <span className="prf-f is-input">
          <small>Оптом</small>
          {onSave ? (
            <PriceInput valueTiyn={inputTiyn} placeholderTiyn={placeholderTiyn} label={`${name} — оптом баға, ₸ / ${unit}`} onSave={onSave} />
          ) : (
            <b>{wholesaleTiyn > 0 ? formatMoney(wholesaleTiyn) : "—"}</b>
          )}
        </span>
        <span className="prf-op" aria-hidden="true">=</span>
        <span className="prf-f">
          <small>Пайда / {unit}</small>
          <b className={perUnit !== null && perUnit < 0 ? "is-negative" : undefined}>{perUnit === null ? "—" : formatMoney(perUnit)}</b>
        </span>
      </div>
      {/* "45 лист × 3 200 = 144 000" when that is exactly true. When the period sold it at more
          than one price the per-unit figure is an average, and a calculator would not get the
          total from it — so the line says what the total really is: сатылды − саны × оптом. */}
      {sold && perUnit !== null && (
        !sellVaried && Math.abs(qty * Math.round(perUnit / 100) * 100 - profitTiyn) < 100 ? (
          <p className="prf-item-total">
            {qtyLabel} × {formatMoney(perUnit)} = <b>{formatMoney(profitTiyn)}</b>
          </p>
        ) : (
          <p className="prf-item-total">
            {formatMoney(revenueTiyn)} − {qtyLabel} × {formatMoney(wholesaleTiyn)} = <b>{formatMoney(profitTiyn)}</b>
          </p>
        )
      )}
      {note && <p className="prf-item-note">{note}</p>}
      {missing && <p className="prf-item-warn">Оптом бағасын жазыңыз — әзірге 0 ₸ деп есептелді</p>}
    </div>
  );
}

/** A line with no wholesale cost: распил, services, прифуговка. */
function FlatRow({ name, note, amountTiyn }: { name: string; note?: string; amountTiyn: number }) {
  return (
    <div className="prf-item">
      <div className="prf-item-head">
        <strong>{name}</strong>
        <b className={amountTiyn < 0 ? "is-negative" : undefined}>{signedMoney(amountTiyn)}</b>
      </div>
      {note && <p className="prf-item-note">{note}</p>}
    </div>
  );
}

/** "#1042 · Алмат  +45 000 ₸ / 120 000 − лист 60 000 − ПВХ 15 000" — each order's own sum. */
function OrderList({ summary, onOpenOrder }: { summary: ProfitSummary; onOpenOrder: (id: string) => void }) {
  if (summary.orders.length === 0) {
    return <div className="empty-state"><p>{formatStartDate(summary.startDate)} бастап заказ жоқ</p></div>;
  }
  return (
    <ul className="prf-orders">
      {summary.orders.map((o) => (
        <li key={o.orderId}>
          <button type="button" className="prf-order" onClick={() => onOpenOrder(o.orderId)}>
            <span className="prf-order-head">
              <strong>{o.orderNumber} · {o.customerName}</strong>
              <b className={o.profitTiyn < 0 ? "is-negative" : undefined}>{signedMoney(o.profitTiyn)}</b>
            </span>
            <span className="prf-order-math">
              {formatMoney(o.revenueTiyn)}
              {(o.sheets > 0 || o.countertops > 0) && (
                <> − {[o.sheets > 0 ? `${o.sheets} лист` : "", o.countertops > 0 ? `${o.countertops} столешница` : ""].filter(Boolean).join(" + ")} оптом {formatMoney(o.sheetCostTiyn)}</>
              )}
              {o.pvcMeters > 0 && <> − ПВХ {formatMeters(o.pvcMeters)} оптом {formatMoney(o.pvcCostTiyn)}</>}
            </span>
            <span className="prf-order-meta">
              {o.createdAt ? formatDateDMY(o.createdAt) : ""}
              {o.debtTiyn > 0 && <span className="is-debt"> · қарыз {formatMoney(o.debtTiyn)}</span>}
              {(o.uncostedSheets > 0 || o.uncostedCountertops > 0 || o.uncostedPvcMeters > 0) && <span className="is-warn"> · оптом бағасы жоқ</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const pvcName = (p: PvcType) => `${p.colorName} · ${p.thicknessMm} мм`;
const priceText = (tiyn: number) => (tiyn > 0 ? String(tiyn / 100) : "");

/** A wholesale price box, saved in place — on leaving it or on Enter, like a spreadsheet cell. */
function PriceInput({
  valueTiyn,
  placeholderTiyn,
  label,
  onSave,
}: {
  valueTiyn: number;
  /** Shown greyed when the box is empty — the general ПВХ rate a colour falls back to. */
  placeholderTiyn?: number;
  label: string;
  onSave: (tiyn: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(priceText(valueTiyn));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [editing, setEditing] = useState(false);
  // A save here (or on another device) comes back through the listener; take it unless the owner
  // is mid-way through typing in this very box.
  const [synced, setSynced] = useState(valueTiyn);
  if (!editing && synced !== valueTiyn) {
    setSynced(valueTiyn);
    setDraft(priceText(valueTiyn));
  }

  const commit = async () => {
    setEditing(false);
    const tiyn = parseMoneyInput(draft);
    if (tiyn === valueTiyn) return;
    setState("saving");
    try {
      await onSave(tiyn);
      setState("saved");
    } catch {
      setState("error");
    }
  };

  return (
    <label className="prf-input">
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        placeholder={placeholderTiyn && placeholderTiyn > 0 ? priceText(placeholderTiyn) : "—"}
        aria-label={label}
        onFocus={() => { setEditing(true); setState("idle"); }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      />
      <i className={`prf-input-state is-${state}`} aria-live="polite">
        {state === "saving" ? "…" : state === "saved" ? "✓ сақталды" : state === "error" ? "Қате" : ""}
      </i>
    </label>
  );
}

/**
 * Where the colourless ПВХ came from — "ЛДСП Дуб Бунратти — 76 м (ORD-2026-000188,
 * ORD-2026-000218)" — so the owner can see the metres ARE in the figure, just not under a colour,
 * and which orders to open in the journal to give them one.
 */
function colourlessNote(p: PvcProfit): string {
  const orders = (list: string[]) =>
    list.length <= 4 ? list.join(", ") : `${list.slice(0, 4).join(", ")} және тағы ${list.length - 4} заказ`;
  const boards = (p.colourless ?? []).map((c) => `${c.board} — ${formatMeters(c.meters)} (${orders(c.orderNumbers)})`);
  const where = boards.length > 0 ? `Заказда ПВХ түсі таңдалмаған: ${boards.join("; ")}. ` : "";
  return `${where}Бұл метрлер пайдаға кірген, оптомы — жалпы баға. Журналда түсін таңдасаңыз, сол түстің жолына ауысады.`;
}
