import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";

/**
 * Purchase prices, keyed by material id.
 *
 * `materialCosts` is Admin-only in firestore.rules — deliberately, so a Manager never sees the
 * shop's margin. A Manager's listen is therefore *expected* to be rejected, which is why the error
 * path sets `available: false` rather than surfacing an error: the caller uses that flag to hide
 * the profit breakdown instead of quietly rendering it with every cost at zero, which would
 * present revenue as if it were profit.
 */
export function useMaterialCosts(): { costs: Map<string, number>; available: boolean; loading: boolean } {
  const [costs, setCosts] = useState<Map<string, number>>(new Map());
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "materialCosts"),
      (snap) => {
        const next = new Map<string, number>();
        snap.forEach((d) => next.set(d.id, (d.data() as { purchasePriceTiyn?: number }).purchasePriceTiyn ?? 0));
        setCosts(next);
        setAvailable(true);
        setLoading(false);
      },
      () => {
        setCosts(new Map());
        setAvailable(false);
        setLoading(false);
      },
    );
    return unsub;
  }, []);

  return { costs, available, loading };
}
