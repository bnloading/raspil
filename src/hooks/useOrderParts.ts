import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import type { CuttingPart } from "../types/domain";

/**
 * Lightweight parts-only subscription for list/card views (cutter/PVC dashboards) that need a
 * per-order parts summary (grain direction, PVC-needed, part count) without the full
 * useOrderDetail payload (order doc + statusHistory + payments) that a detail page needs.
 */
export function useOrderParts(orderId: string | undefined) {
  const [parts, setParts] = useState<CuttingPart[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orderId) {
      setParts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsub = onSnapshot(
      collection(db, "orders", orderId, "parts"),
      (snap) => {
        const list: CuttingPart[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<CuttingPart, "id">) }));
        setParts(list);
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, [orderId]);

  return { parts, loading };
}
