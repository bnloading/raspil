import { useState, useEffect, useCallback } from "react";
import { collection, query, orderBy, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";

export type Material = "лдсп" | "хдф" | "мдф" | "двп" | "фанера";

export function needsPvh(material?: Material | string): boolean {
  return !material || material === "лдсп";
}

export interface OrderItem {
  description: string;
  material?: Material;
  raspilDone: boolean;
  pvhDone: boolean;
}

export interface Order {
  id: string;
  clientName: string;
  phone?: string;
  description?: string;
  items: OrderItem[];
  queue: number;
  raspilDone: boolean;
  pvhDone: boolean;
  estimatedMinutes?: number;
  createdAt?: { seconds: number };
}

function detectMaterial(item: OrderItem): Material | undefined {
  if (item.material) return item.material;
  const desc = (item.description || "").toLowerCase();
  if (desc.includes("хдф")) return "хдф";
  if (desc.includes("мдф")) return "мдф";
  if (desc.includes("двп")) return "двп";
  if (desc.includes("фанера")) return "фанера";
  return undefined; // defaults to ЛДСП behavior via needsPvh
}

function normalizeOrder(id: string, data: Record<string, unknown>): Order {
  const raw = data as {
    clientName?: string;
    phone?: string;
    description?: string;
    items?: OrderItem[];
    queue?: number;
    raspilDone?: boolean;
    pvhDone?: boolean;
    estimatedMinutes?: number;
    createdAt?: { seconds: number };
  };

  let items: OrderItem[];
  if (Array.isArray(raw.items) && raw.items.length > 0) {
    items = raw.items.map((it) => {
      const mat = detectMaterial(it);
      return {
        ...it,
        material: mat,
        pvhDone: needsPvh(mat) ? !!it.pvhDone : true,
      };
    });
  } else {
    items = [
      {
        description: raw.description || "",
        raspilDone: !!raw.raspilDone,
        pvhDone: !!raw.pvhDone,
      },
    ];
  }

  const raspilDone = items.every((it) => it.raspilDone);
  const pvhDone = items.every((it) => it.pvhDone);

  return {
    id,
    clientName: raw.clientName || "",
    phone: raw.phone,
    description: raw.description,
    items,
    queue: raw.queue || 0,
    raspilDone,
    pvhDone,
    estimatedMinutes: raw.estimatedMinutes,
    createdAt: raw.createdAt,
  };
}

export function useOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "orders"), orderBy("createdAt", "asc"));
    const unsub = onSnapshot(q, (snapshot) => {
      const data: Order[] = [];
      snapshot.forEach((d) =>
        data.push(normalizeOrder(d.id, d.data() as Record<string, unknown>)),
      );
      setOrders(data);
      setLoading(false);
    });
    return unsub;
  }, []);

  return { orders, loading };
}

export function useToast() {
  const [message, setMessage] = useState("");
  const [visible, setVisible] = useState(false);

  const showToast = useCallback((msg: string) => {
    setMessage(msg);
    setVisible(true);
    setTimeout(() => setVisible(false), 3000);
  }, []);

  return { message, visible, showToast };
}
