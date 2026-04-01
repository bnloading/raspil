import { useState, useEffect, type FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  collection,
  addDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import {
  useOrders,
  useToast,
  type Order,
  type Material,
  needsPvh,
} from "../hooks";
import { Toast, ItemProgressSteps, getStatus, Spinner } from "../components";
import { formatDateTime } from "../utils";

export default function Admin() {
  const { user, userData, loading: authLoading, logout } = useAuth();
  const navigate = useNavigate();
  const { orders, loading: ordersLoading } = useOrders();
  const { message, visible, showToast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [itemDescs, setItemDescs] = useState<
    { desc: string; material: Material }[]
  >([{ desc: "", material: "лдсп" }]);
  const [queueNum, setQueueNum] = useState("");

  useEffect(() => {
    if (!authLoading) {
      if (!user) {
        navigate("/login", { replace: true });
      } else if (userData && userData.role !== "admin") {
        logout().then(() => navigate("/login", { replace: true }));
      }
    }
  }, [authLoading, user, userData, navigate, logout]);

  if (authLoading || !userData) return <Spinner />;

  const total = orders.length;
  const done = orders.filter((o) => o.raspilDone && o.pvhDone).length;
  const progress = total - done;

  const handleLogout = () => {
    logout().then(() => navigate("/login"));
  };

  const addItemField = () =>
    setItemDescs((prev) => [...prev, { desc: "", material: "лдсп" }]);
  const removeItemField = (i: number) =>
    setItemDescs((prev) => prev.filter((_, idx) => idx !== i));
  const updateItemField = (i: number, key: "desc" | "material", val: string) =>
    setItemDescs((prev) =>
      prev.map((v, idx) => (idx === i ? { ...v, [key]: val } : v)),
    );

  const handleAddOrder = async (e: FormEvent) => {
    e.preventDefault();
    const validItems = itemDescs.filter((d) => d.desc.trim().length > 0);
    if (!clientName.trim() || validItems.length === 0) {
      showToast("Атын және кем дегенде 1 сипаттаманы толтырыңыз");
      return;
    }
    try {
      await addDoc(collection(db, "orders"), {
        clientName: clientName.trim(),
        phone: clientPhone.trim(),
        items: validItems.map((item) => ({
          description: item.desc.trim(),
          material: item.material,
          raspilDone: false,
          pvhDone: !needsPvh(item.material),
        })),
        queue:
          parseInt(queueNum) ||
          (orders.length > 0 ? Math.max(...orders.map((o) => o.queue)) + 1 : 1),
        createdAt: serverTimestamp(),
      });
      setModalOpen(false);
      setClientName("");
      setClientPhone("");
      setItemDescs([{ desc: "", material: "лдсп" }]);
      setQueueNum("");
      showToast("✅ Заказ қосылды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Заказды жоюды қалайсыз ба?")) return;
    try {
      await deleteDoc(doc(db, "orders", id));
      showToast("🗑 Заказ жойылды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  return (
    <>
      <div className="header">
        <div className="header-top">
          <div>
            <h1>📋 Заказдар</h1>
            <p>Сәлем, {userData.name || "Админ"}</p>
          </div>
          <button className="btn-logout" onClick={handleLogout}>
            Шығу ↗
          </button>
        </div>
      </div>

      <div className="stats-bar">
        <div className="stat-card">
          <div className="number">{total}</div>
          <div className="label">Барлығы</div>
        </div>
        <div className="stat-card">
          <div className="number">{progress}</div>
          <div className="label">Жұмыста</div>
        </div>
        <div className="stat-card">
          <div className="number">{done}</div>
          <div className="label">Дайын</div>
        </div>
      </div>

      <div className="orders-section">
        <div className="section-title">Белсенді заказдар</div>
        <div>
          {ordersLoading ? (
            <Spinner />
          ) : orders.length === 0 ? (
            <div className="empty-state">
              <div className="icon">📭</div>
              <p>
                Заказдар жоқ
                <br />
                Жаңа заказ қосу үшін + басыңыз
              </p>
            </div>
          ) : (
            orders.map((order, idx) => (
              <OrderCard
                key={order.id}
                order={order}
                num={idx + 1}
                onDelete={handleDelete}
              />
            ))
          )}
        </div>
      </div>

      <button
        className="fab"
        onClick={() => setModalOpen(true)}
        title="Жаңа заказ"
      >
        +
      </button>

      <div
        className={`modal-overlay${modalOpen ? " active" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) setModalOpen(false);
        }}
      >
        <div className="modal">
          <div className="modal-handle" />
          <h2>➕ Жаңа заказ</h2>
          <form onSubmit={handleAddOrder}>
            <div className="form-group">
              <label>Клиент аты</label>
              <input
                type="text"
                className="form-input"
                placeholder="Мысалы: Алмас"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>Телефон</label>
              <input
                type="tel"
                className="form-input"
                placeholder="+7 777 123 4567"
                value={clientPhone}
                onChange={(e) => setClientPhone(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>Заказ сипаттамалары</label>
              <div className="item-fields">
                {itemDescs.map((item, i) => (
                  <div className="item-field-row" key={i}>
                    <select
                      className="form-select-material"
                      value={item.material}
                      onChange={(e) =>
                        updateItemField(i, "material", e.target.value)
                      }
                    >
                      <option value="лдсп">ЛДСП</option>
                      <option value="хдф">ХДФ</option>
                      <option value="мдф">МДФ</option>
                      <option value="двп">ДВП</option>
                      <option value="фанера">Фанера</option>
                    </select>
                    <input
                      type="text"
                      className="form-input"
                      placeholder={`${i + 1}-заказ: мыс. 4 лист ақ`}
                      value={item.desc}
                      onChange={(e) =>
                        updateItemField(i, "desc", e.target.value)
                      }
                      required
                    />
                    {itemDescs.length > 1 && (
                      <button
                        type="button"
                        className="btn-remove-item"
                        onClick={() => removeItemField(i)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className="btn-add-item"
                  onClick={addItemField}
                >
                  + Тағы заказ қосу
                </button>
              </div>
            </div>
            <div className="form-group">
              <label>Очередь нөмірі</label>
              <input
                type="number"
                className="form-input"
                placeholder="1"
                min={1}
                value={queueNum}
                onChange={(e) => setQueueNum(e.target.value)}
              />
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setModalOpen(false)}
              >
                Болдырмау
              </button>
              <button type="submit" className="btn btn-primary">
                Қосу
              </button>
            </div>
          </form>
        </div>
      </div>

      <Toast message={message} visible={visible} />

      <nav className="bottom-nav">
        <Link to="/admin" className="bottom-nav-item active">
          <span className="bottom-nav-icon">📋</span>
          <span className="bottom-nav-label">Заказдар</span>
        </Link>
        <Link to="/track" className="bottom-nav-item">
          <span className="bottom-nav-icon">📦</span>
          <span className="bottom-nav-label">Бақылау</span>
        </Link>
        <Link to="/setup" className="bottom-nav-item">
          <span className="bottom-nav-icon">⚙️</span>
          <span className="bottom-nav-label">Баптау</span>
        </Link>
      </nav>
    </>
  );
}

function OrderCard({
  order,
  num,
  onDelete,
}: {
  order: Order;
  num: number;
  onDelete: (id: string) => void;
}) {
  const status = getStatus(order);
  const isDone = order.raspilDone && order.pvhDone;
  const date = order.createdAt ? formatDateTime(order.createdAt.seconds) : "";

  return (
    <div className={`order-card${isDone ? " done" : ""}`}>
      <button
        className="btn-delete"
        onClick={() => onDelete(order.id)}
        title="Жою"
      >
        🗑
      </button>
      <div className="order-card-header">
        <span className="order-number">
          {num}. #{order.queue}
        </span>
        <span className={`order-status ${status.className}`}>
          {status.text}
        </span>
      </div>
      <div className="order-client">{order.clientName}</div>
      {order.phone && (
        <div className="order-phone">
          📞 <span>{order.phone}</span>
        </div>
      )}
      <div className="order-items-list">
        {order.items.map((item, i) => (
          <div key={i} className="order-item-row">
            <span className="order-item-num">{i + 1}.</span>
            {item.material && (
              <span className={`material-tag material-${item.material}`}>
                {item.material.toUpperCase()}
              </span>
            )}
            <span className="order-item-desc">{item.description}</span>
            <ItemProgressSteps item={item} />
          </div>
        ))}
      </div>
      {date && <div className="order-date">📅 {date}</div>}
    </div>
  );
}
