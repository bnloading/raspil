import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../firebase";
import type { WorkshopActivityEntry } from "../types/domain";

/**
 * Live public workshop board — see WorkshopActivityEntry. Uses onSnapshot, so every customer's
 * board updates in near-real-time as workers start/finish jobs, with no polling.
 */
export function useWorkshopActivity() {
  const [entries, setEntries] = useState<WorkshopActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "workshopActivity"), orderBy("queuePosition", "asc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setEntries(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<WorkshopActivityEntry, "id">) })));
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, []);

  return { entries, loading };
}
