import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query, where, type Query } from "firebase/firestore";
import { db } from "../firebase";
import type { Order, ProductionStatus } from "../types/domain";

// These statuses are only ever reachable via lib/orderStatus.ts's enterCuttingQueue(), which
// enforces the payment gate before writing "cutting_queue" — so filtering on status alone already
// satisfies "cutter/PVC worker must never see unpaid or partially-paid orders" with no extra query.
const CUTTER_VISIBLE_STATUSES: ProductionStatus[] = ["cutting_queue", "cutting_started", "cutting_completed"];
// PVC work itself only starts once the sheets are cut, but the job is the PVC worker's to plan for
// from the moment it enters the cutting queue — that is what fills the dashboard's "Распил
// күтілуде" list. firestore.rules pvcCanSee() allows exactly these statuses to be read; editing
// still begins at cutting_completed (pvcCanEdit).
const PVC_VISIBLE_STATUSES: ProductionStatus[] = [
  "cutting_queue",
  "cutting_started",
  "cutting_completed",
  "pvc_queue",
  "pvc_started",
  "pvc_completed",
];

/**
 * The `orders` collection also holds a handful of documents from the app's pre-rewrite schema
 * (clientName/items[]/queue fields instead of orderNumber/productionStatus/materialSnapshot) —
 * real historical records, not something to silently coerce. Every UI here assumes the current
 * `Order` shape, so skip anything that doesn't have its two load-bearing fields rather than crash
 * the whole list on a `.toFixed()`/`.map()` over a field that was never written.
 */
function isCurrentSchemaOrder(data: Record<string, unknown>): boolean {
  return typeof data.orderNumber === "string" && typeof data.productionStatus === "string";
}

function useOrderQueries(queries: Query[]) {
  const [byId, setById] = useState<Map<string, Order>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (queries.length === 0) {
      setById(new Map());
      setLoading(false);
      return;
    }
    let pending = queries.length;
    const localMaps = queries.map(() => new Map<string, Order>());
    setLoading(true);

    const unsubs = queries.map((q, i) =>
      onSnapshot(
        q,
        (snap) => {
          const map = new Map<string, Order>();
          snap.forEach((d) => {
            const data = d.data();
            if (!isCurrentSchemaOrder(data)) return;
            map.set(d.id, { id: d.id, ...(data as Omit<Order, "id">) });
          });
          localMaps[i] = map;
          const merged = new Map<string, Order>();
          for (const m of localMaps) for (const [id, order] of m) merged.set(id, order);
          setById(merged);
          if (pending > 0) {
            pending -= 1;
            if (pending === 0) setLoading(false);
          }
        },
        () => {
          if (pending > 0) {
            pending -= 1;
            if (pending === 0) setLoading(false);
          }
        },
      ),
    );
    return () => unsubs.forEach((u) => u());
    // `queries` is the caller's memoized array (see useCustomerOrders/useAllOrders/etc.) — its
    // identity only changes when the underlying customerId/uid actually changes.
  }, [queries]);

  const orders = useMemo(
    () => [...byId.values()].sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0)),
    [byId],
  );

  return { orders, loading };
}

/** Every order belonging to one customer. */
export function useCustomerOrders(customerId: string | undefined) {
  const queries = useMemo(() => {
    if (!customerId) return [];
    return [query(collection(db, "orders"), where("customerId", "==", customerId), orderBy("createdAt", "desc"))];
  }, [customerId]);
  return useOrderQueries(queries);
}

/** Admin: every order (small/medium shop volume — filtering/pagination happens client-side in AdminOrders). */
export function useAllOrders() {
  const queries = useMemo(
    () => [query(collection(db, "orders"), orderBy("createdAt", "desc"))],
    [],
  );
  return useOrderQueries(queries);
}

/** Cutter: orders in cutting-relevant statuses, plus anything ever assigned to them (for history). */
export function useCutterOrders(uid: string | undefined) {
  const queries = useMemo(() => {
    if (!uid) return [];
    return [
      query(collection(db, "orders"), where("productionStatus", "in", CUTTER_VISIBLE_STATUSES)),
      query(collection(db, "orders"), where("assignedCutterId", "==", uid)),
    ];
  }, [uid]);
  return useOrderQueries(queries);
}

/** PVC worker: orders in PVC-relevant statuses, plus anything ever assigned to them. */
export function usePvcOrders(uid: string | undefined) {
  const queries = useMemo(() => {
    if (!uid) return [];
    return [
      query(collection(db, "orders"), where("productionStatus", "in", PVC_VISIBLE_STATUSES)),
      query(collection(db, "orders"), where("assignedPvcId", "==", uid)),
    ];
  }, [uid]);
  return useOrderQueries(queries);
}
