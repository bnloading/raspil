import { useState } from "react";
import type { CSSProperties } from "react";
import { Spinner } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { useMaterials } from "../hooks/useMaterials";
import { formatMoney } from "../lib/money";

import imgAk from "../images/Белый.jpeg";
import imgSeryy from "../images/светло серый.jpg";
import imgVotan from "../images/дуб вотан.jpeg";
import imgBunratti from "../images/бнуратти.jpeg";
import imgSonoma from "../images/дуб санома.jpeg";
import imgChester from "../images/Честер.jpg";
import imgKanyon from "../images/каньон.jpg";

interface SheetSwatch {
  name: string;
  image: string;
  detail?: string;
  available?: boolean;
}

const fallbackSheets: SheetSwatch[] = [
  { name: "Ақ", image: imgAk },
  { name: "Светло серый", image: imgSeryy },
  { name: "Дуб Вотан", image: imgVotan },
  { name: "Дуб Бунратти", image: imgBunratti },
  { name: "Дуб Сонома", image: imgSonoma },
  { name: "Честерфилд", image: imgChester },
  { name: "Дуб Каньон", image: imgKanyon },
];

export default function Assortment() {
  const { materials, loading } = useMaterials(true);
  const [selected, setSelected] = useState<SheetSwatch | null>(null);

  const sheets =
    materials.length > 0
      ? materials.map((m) => ({
          name: m.name,
          image: m.imageUrl || "",
          detail: `${m.thicknessMm} мм · ${formatMoney(m.sellingPriceTiyn)} / лист`,
          available: m.qtyOnHand - m.reservedQty > 0,
        }))
      : fallbackSheets;

  return (
    <AppShell title="Листтар" subtitle="Материалдар ассортименті">
      {loading ? (
        <Spinner />
      ) : (
        <div className="card-grid" style={{ "--cols": 4 } as CSSProperties}>
          {sheets.map((s) => (
            <div key={s.name} className="assortment-card" onClick={() => setSelected(s)}>
              {s.image ? (
                <img className="assortment-swatch" src={s.image} alt={s.name} />
              ) : (
                <div className="assortment-swatch assortment-swatch-empty" />
              )}
              <div className="assortment-name">{s.name}</div>
              {s.detail && <div className="assortment-detail">{s.detail}</div>}
              {"available" in s && (
                <div className={`assortment-stock ${s.available ? "in-stock" : "out-of-stock"}`}>
                  {s.available ? "Қоймада бар" : "Қоймада жоқ"}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div className="lightbox-overlay" onClick={() => setSelected(null)}>
          <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
            {selected.image && (
              <img src={selected.image} alt={selected.name} className="lightbox-img" />
            )}
            <div className="lightbox-name">{selected.name}</div>
            {selected.detail && <div className="assortment-detail">{selected.detail}</div>}
            <button className="lightbox-close" onClick={() => setSelected(null)}>
              ✕
            </button>
          </div>
        </div>
      )}
    </AppShell>
  );
}
