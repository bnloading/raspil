import { useState } from "react";
import { TrackBottomNav, Spinner } from "../components";
import { useSheets } from "../hooks";

import imgAk from "../images/Белый.jpeg";
import imgSeryy from "../images/светло серый.jpg";
import imgVotan from "../images/дуб вотан.jpeg";
import imgBunratti from "../images/бнуратти.jpeg";
import imgSonoma from "../images/дуб санома.jpeg";
import imgChester from "../images/Честер.jpg";
import imgKanyon from "../images/каньон.jpg";

const fallbackSheets = [
  { name: "Ақ", image: imgAk },
  { name: "Светло серый", image: imgSeryy },
  { name: "Дуб Вотан", image: imgVotan },
  { name: "Дуб Бунратти", image: imgBunratti },
  { name: "Дуб Сонома", image: imgSonoma },
  { name: "Честерфилд", image: imgChester },
  { name: "Дуб Каньон", image: imgKanyon },
];

export default function Assortment() {
  const { sheets: dbSheets, loading } = useSheets();
  const [selected, setSelected] = useState<{
    name: string;
    image: string;
  } | null>(null);

  const sheets =
    dbSheets.length > 0
      ? dbSheets.map((s) => ({ name: s.name, image: s.imageUrl || "" }))
      : fallbackSheets;

  return (
    <div className="figma-track-page assortment-track-page">
      <div className="client-header">
        <h1>🎨 Листтар</h1>
        <p>Біздегі ЛДСП листтарының түстері</p>
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <div className="assortment-grid">
          {sheets.map((s) => (
            <div
              key={s.name}
              className="assortment-card"
              onClick={() => setSelected(s)}
            >
              <img className="assortment-swatch" src={s.image} alt={s.name} />
              <div className="assortment-name">{s.name}</div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div className="lightbox-overlay" onClick={() => setSelected(null)}>
          <div
            className="lightbox-content"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={selected.image}
              alt={selected.name}
              className="lightbox-img"
            />
            <div className="lightbox-name">{selected.name}</div>
            <button
              className="lightbox-close"
              onClick={() => setSelected(null)}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div style={{ paddingBottom: 80 }} />
      <TrackBottomNav active="assortment" />
    </div>
  );
}
