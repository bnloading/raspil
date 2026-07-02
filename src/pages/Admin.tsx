import { useState, useEffect, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  collection,
  addDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  updateDoc,
  writeBatch,
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
import {
  Toast,
  ItemProgressSteps,
  getStatus,
  Spinner,
  TrackBottomNav,
} from "../components";
import { formatDateTime } from "../utils";

export default function Admin() {
  const { user, userData, loading: authLoading, logout } = useAuth();
  const navigate = useNavigate();
  const { orders, loading: ordersLoading } = useOrders();
  const { message, visible, showToast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
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

  const resetOrderForm = () => {
    setModalOpen(false);
    setEditingOrder(null);
    setClientName("");
    setClientPhone("");
    setItemDescs([{ desc: "", material: "лдсп" }]);
    setQueueNum("");
  };

  const openAddOrder = () => {
    setEditingOrder(null);
    setClientName("");
    setClientPhone("");
    setItemDescs([{ desc: "", material: "лдсп" }]);
    setQueueNum("");
    setModalOpen(true);
  };

  const openEditOrder = (order: Order) => {
    setEditingOrder(order);
    setClientName(order.clientName);
    setClientPhone(order.phone || "");
    setQueueNum(order.queue ? String(order.queue) : "");
    setItemDescs(
      order.items.map((item) => ({
        desc: item.description,
        material: item.material || "лдсп",
      })),
    );
    setModalOpen(true);
  };

  const handleSubmitOrder = async (e: FormEvent) => {
    e.preventDefault();
    const validItems = itemDescs.filter((d) => d.desc.trim().length > 0);
    if (!clientName.trim() || validItems.length === 0) {
      showToast("Атын және кем дегенде 1 сипаттаманы толтырыңыз");
      return;
    }
    try {
      const payload = {
        clientName: clientName.trim(),
        phone: clientPhone.trim(),
        items: validItems.map((item) => {
          const description = item.desc.trim();
          const existing = editingOrder?.items.find(
            (existing) => existing.description === description,
          );
          return {
            description,
            material: item.material,
            raspilDone: existing?.raspilDone || false,
            pvhDone: needsPvh(item.material)
              ? existing?.pvhDone || false
              : true,
          };
        }),
        queue:
          parseInt(queueNum) ||
          (orders.length > 0 ? Math.max(...orders.map((o) => o.queue)) + 1 : 1),
      };

      if (editingOrder) {
        await updateDoc(doc(db, "orders", editingOrder.id), payload);
        showToast("✅ Заказ жаңартылды");
      } else {
        await addDoc(collection(db, "orders"), {
          ...payload,
          createdAt: serverTimestamp(),
        });
        showToast("✅ Заказ қосылды");
      }
      resetOrderForm();
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const handleMoveQueue = async (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= orders.length) return;
    const current = orders[index];
    const target = orders[targetIndex];
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, "orders", current.id), { queue: target.queue });
      batch.update(doc(db, "orders", target.id), { queue: current.queue });
      await batch.commit();
      showToast("↕️ Очередь жаңартылды");
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
    <div className="orders-mobile-page figma-track-page admin-track-page">
      <div className="header orders-mobile-header">
        <div className="header-top">
          <div>
            <span className="screen-kicker">Furniture workshop</span>
            <h1>Orders</h1>
            <p>Сәлем, {userData.name || "Админ"}</p>
          </div>
          <button
            className="btn-logout orders-icon-button"
            onClick={handleLogout}
            aria-label="Шығу"
          >
            ↗
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
        <div className="section-title-row orders-title-row">
          <div className="section-title">Белсенді заказдар</div>
          <span>{orders.length} order</span>
        </div>
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
                canMoveUp={idx > 0}
                canMoveDown={idx < orders.length - 1}
                onEdit={openEditOrder}
                onDelete={handleDelete}
                onMoveUp={() => handleMoveQueue(idx, -1)}
                onMoveDown={() => handleMoveQueue(idx, 1)}
              />
            ))
          )}
        </div>
      </div>

      <div
        className={`modal-overlay${modalOpen ? " active" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) resetOrderForm();
        }}
      >
        <div className="modal">
          <div className="modal-handle" />
          <h2>{editingOrder ? "✎ Заказды өзгерту" : "➕ Жаңа заказ"}</h2>
          <form onSubmit={handleSubmitOrder}>
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
                onClick={resetOrderForm}
              >
                Болдырмау
              </button>
              <button type="submit" className="btn btn-primary">
                {editingOrder ? "Сақтау" : "Қосу"}
              </button>
            </div>
          </form>
        </div>
      </div>

      <Toast message={message} visible={visible} />
      <TrackBottomNav onCreateOrder={openAddOrder} />
    </div>
  );
}

function OrderCard({
  order,
  num,
  canMoveUp,
  canMoveDown,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  order: Order;
  num: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onEdit: (order: Order) => void;
  onDelete: (id: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const status = getStatus(order);
  const isDone = order.raspilDone && order.pvhDone;
  const date = order.createdAt ? formatDateTime(order.createdAt.seconds) : "";
  const primaryMaterial = order.items[0]?.material || "лдсп";
  const completedItems = order.items.filter((item) => {
    const hasPvh = needsPvh(item.material);
    return item.raspilDone && (hasPvh ? item.pvhDone : true);
  }).length;

  return (
    <div className={`order-card${isDone ? " done" : ""}`}>
      <div className={`order-card-media material-bg-${primaryMaterial}`}>
        <span>{String(num).padStart(2, "0")}</span>
      </div>
      <button
        className="btn-delete"
        onClick={() => onDelete(order.id)}
        title="Жою"
      >
        🗑
      </button>
      <div className="order-admin-actions">
        <button type="button" onClick={() => onEdit(order)} title="Өзгерту">
          ✎
        </button>
        <button
          type="button"
          onClick={onMoveUp}
          disabled={!canMoveUp}
          title="Очередьте жоғары"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={!canMoveDown}
          title="Очередьте төмен"
        >
          ↓
        </button>
      </div>
      <div className="order-card-header">
        <span className="order-number">
          {num}. #{order.queue}
        </span>
        <span className={`order-status ${status.className}`}>
          {status.text}
        </span>
      </div>
      <div className="order-client">{order.clientName}</div>
      <div className="order-card-meta">
        <span>
          {completedItems}/{order.items.length} дайын
        </span>
        {date && <span>{date}</span>}
      </div>
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
    </div>
  );
}
