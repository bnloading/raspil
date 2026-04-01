import type { Order, OrderItem } from "./hooks";
import { needsPvh } from "./hooks";

export function Toast({
  message,
  visible,
}: {
  message: string;
  visible: boolean;
}) {
  return <div className={`toast${visible ? " show" : ""}`}>{message}</div>;
}

export function getStatus(order: Order) {
  if (order.raspilDone && order.pvhDone)
    return { text: "Дайын ✅", className: "status-done" };
  if (order.raspilDone || order.pvhDone)
    return { text: "Жұмыста 🔄", className: "status-progress" };
  return { text: "Кезекте ⏳", className: "status-queue" };
}

export function ItemProgressSteps({ item }: { item: OrderItem }) {
  const hasPvh = needsPvh(item.material);
  const isDone = item.raspilDone && (hasPvh ? item.pvhDone : true);
  return (
    <div className="item-progress">
      <span
        className={`item-step ${item.raspilDone ? "completed" : "pending"}`}
        title="Распил"
      >
        🪚{item.raspilDone ? "✓" : ""}
      </span>
      {hasPvh && (
        <span
          className={`item-step ${item.pvhDone ? "completed" : "pending"}`}
          title="ПВХ"
        >
          🪟{item.pvhDone ? "✓" : ""}
        </span>
      )}
      {isDone && <span className="item-step-done">✅</span>}
    </div>
  );
}

export function ProgressSteps({ order }: { order: Order }) {
  const isDone = order.raspilDone && order.pvhDone;
  return (
    <div className="progress-steps">
      <div
        className={`step ${order.raspilDone ? "completed" : !order.raspilDone && !order.pvhDone ? "active" : ""}`}
      >
        <div className="step-dot">{order.raspilDone ? "✓" : "1"}</div>
        <div className="step-label">Распил</div>
      </div>
      <div
        className={`step ${order.pvhDone ? "completed" : order.raspilDone && !order.pvhDone ? "active" : ""}`}
      >
        <div className="step-dot">{order.pvhDone ? "✓" : "2"}</div>
        <div className="step-label">ПВХ</div>
      </div>
      <div className={`step ${isDone ? "completed" : ""}`}>
        <div className="step-dot">{isDone ? "✓" : "3"}</div>
        <div className="step-label">Дайын</div>
      </div>
    </div>
  );
}

export function Spinner() {
  return (
    <div className="loading">
      <div className="spinner" />
      <p>Жүктелуде...</p>
    </div>
  );
}
