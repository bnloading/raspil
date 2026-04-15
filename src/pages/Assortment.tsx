import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../AuthContext";

import imgAk from "../images/Белый.jpeg";
import imgSeryy from "../images/светло серый.jpg";
import imgVotan from "../images/дуб вотан.jpeg";
import imgBunratti from "../images/бнуратти.jpeg";
import imgSonoma from "../images/дуб санома.jpeg";
import imgChester from "../images/Честер.jpg";
import imgKanyon from "../images/каньон.jpg";

const sheets = [
  { name: "Ақ", image: imgAk },
  { name: "Светло серый", image: imgSeryy },
  { name: "Дуб Вотан", image: imgVotan },
  { name: "Дуб Бунратти", image: imgBunratti },
  { name: "Дуб Сонома", image: imgSonoma },
  { name: "Честерфилд", image: imgChester },
  { name: "Дуб Каньон", image: imgKanyon },
];

export default function Assortment() {
  const [selected, setSelected] = useState<{
    name: string;
    image: string;
  } | null>(null);

  return (
    <>
      <div className="client-header">
        <h1>🎨 Листтар</h1>
        <p>Біздегі ЛДСП листтарының түстері</p>
      </div>

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
      <AssortmentBottomNav />
    </>
  );
}

function AssortmentBottomNav() {
  const { user, userData } = useAuth();
  if (!user || !userData) {
    return (
      <nav className="bottom-nav">
        <Link to="/" className="bottom-nav-item">
          <span className="bottom-nav-icon">📦</span>
          <span className="bottom-nav-label">Бақылау</span>
        </Link>
        <Link to="/assortment" className="bottom-nav-item active">
          <span className="bottom-nav-icon">🎨</span>
          <span className="bottom-nav-label">Листтар</span>
        </Link>
        <Link to="/login" className="bottom-nav-item">
          <span className="bottom-nav-icon">🔑</span>
          <span className="bottom-nav-label">Кіру</span>
        </Link>
      </nav>
    );
  }
  if (userData.role === "admin") {
    return (
      <nav className="bottom-nav">
        <Link to="/admin" className="bottom-nav-item">
          <span className="bottom-nav-icon">📋</span>
          <span className="bottom-nav-label">Заказдар</span>
        </Link>
        <Link to="/track" className="bottom-nav-item">
          <span className="bottom-nav-icon">📦</span>
          <span className="bottom-nav-label">Бақылау</span>
        </Link>
        <Link to="/assortment" className="bottom-nav-item active">
          <span className="bottom-nav-icon">🎨</span>
          <span className="bottom-nav-label">Листтар</span>
        </Link>
        <Link to="/setup" className="bottom-nav-item">
          <span className="bottom-nav-icon">⚙️</span>
          <span className="bottom-nav-label">Баптау</span>
        </Link>
      </nav>
    );
  }
  return (
    <nav className="bottom-nav">
      <Link to="/worker" className="bottom-nav-item">
        <span className="bottom-nav-icon">🔧</span>
        <span className="bottom-nav-label">Заказ</span>
      </Link>
      <Link to="/track" className="bottom-nav-item">
        <span className="bottom-nav-icon">📦</span>
        <span className="bottom-nav-label">Бақылау</span>
      </Link>
      <Link to="/assortment" className="bottom-nav-item active">
        <span className="bottom-nav-icon">🎨</span>
        <span className="bottom-nav-label">Листтар</span>
      </Link>
    </nav>
  );
}
