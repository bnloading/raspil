import { useMemo, useState } from "react";
import { Spinner } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { useMaterials } from "../hooks/useMaterials";
import { formatMoney } from "../lib/money";
import { materialImage } from "../lib/materialImages";
import {
  SORT_LABELS,
  assortmentStock,
  categoryChips,
  filterMaterials,
  materialSpec,
  sortMaterials,
  type AssortmentSort,
} from "../lib/assortment";
import type { Material, MaterialCategory } from "../types/domain";

/**
 * "Листтер" — the shop's catalogue, as somebody standing in front of the rack would ask about it:
 * what it looks like, what it costs, and whether they can have it today.
 *
 * The stock line is the point of the page. It counts what is free to sell — on hand less what is
 * already promised to other orders — so it is never a number the shop cannot honour.
 */
export default function Assortment() {
  const { materials, loading } = useMaterials(true);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<MaterialCategory | "all">("all");
  const [inStockOnly, setInStockOnly] = useState(false);
  const [sort, setSort] = useState<AssortmentSort>("name");
  const [selected, setSelected] = useState<Material | null>(null);

  const chips = useMemo(() => categoryChips(materials), [materials]);
  const shown = useMemo(
    () => sortMaterials(filterMaterials(materials, { query, category, inStockOnly }), sort),
    [materials, query, category, inStockOnly, sort],
  );

  return (
    <AppShell
      title="Листтер"
      subtitle="Материалдар ассортименті"
      search={{ value: query, onChange: setQuery, placeholder: "Материал атауы немесе коды" }}
    >
      {loading ? (
        <Spinner />
      ) : (
        <>
          {/* Counted chips: "do you have ХДФ" is answered without a tap, and a category the shop
              does not stock is never offered as a dead end. */}
          <div className="assort-filters">
            <div className="assort-chips">
              {chips.map((c) => (
                <button
                  key={c.id}
                  className={`assort-chip${category === c.id ? " is-active" : ""}`}
                  onClick={() => setCategory(c.id)}
                >
                  {c.label}
                  <b>{c.count}</b>
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`assort-funnel${inStockOnly ? " is-active" : ""}`}
              aria-pressed={inStockOnly}
              title="Тек қоймада барлары"
              onClick={() => setInStockOnly((v) => !v)}
            >
              ⧩
            </button>
          </div>

          <div className="assort-bar">
            <span className="assort-count">{shown.length} материал</span>
            <select
              className="assort-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as AssortmentSort)}
              aria-label="Сұрыптау"
            >
              {(Object.keys(SORT_LABELS) as AssortmentSort[]).map((s) => (
                <option key={s} value={s}>{SORT_LABELS[s]}</option>
              ))}
            </select>
          </div>

          {shown.length === 0 ? (
            <div className="empty-state">
              <div className="icon">🔍</div>
              <p>Материал табылмады</p>
              <p className="empty-state-hint">
                {inStockOnly
                  ? "Қоймада барын ғана көрсетіп тұрсыз — сүзгіні алып көріңіз."
                  : "Іздеу сөзін немесе санатты өзгертіп көріңіз."}
              </p>
            </div>
          ) : (
            <div className="assort-grid">
              {shown.map((m) => {
                const photo = materialImage(m);
                const stock = assortmentStock(m);
                return (
                  <button key={m.id} type="button" className="assort-card" onClick={() => setSelected(m)}>
                    <span className="assort-photo">
                      {photo ? (
                        <img src={photo} alt={m.name} loading="lazy" />
                      ) : (
                        <span className="assort-photo-empty" aria-hidden="true" />
                      )}
                      {m.article && <span className="assort-code">{m.article}</span>}
                    </span>

                    <span className="assort-name">{m.name}</span>
                    <span className="assort-spec">{materialSpec(m)}</span>
                    <span className="assort-price">{formatMoney(m.sellingPriceTiyn)} / лист</span>

                    {/* What the customer actually came to find out. */}
                    <span className={`assort-stock is-${stock.tone}`}>
                      {stock.label}
                      <i aria-hidden="true">›</i>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {selected && (
        <div className="lightbox-overlay" onClick={() => setSelected(null)}>
          <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
            {materialImage(selected) && (
              <img src={materialImage(selected)!} alt={selected.name} className="lightbox-img" />
            )}
            <div className="lightbox-name">{selected.name}</div>
            <div className="assortment-detail">
              {materialSpec(selected)} · {formatMoney(selected.sellingPriceTiyn)} / лист
            </div>
            <div className={`assort-stock is-${assortmentStock(selected).tone}`}>
              {assortmentStock(selected).label}
            </div>
            <button className="lightbox-close" onClick={() => setSelected(null)}>
              ✕
            </button>
          </div>
        </div>
      )}
    </AppShell>
  );
}
