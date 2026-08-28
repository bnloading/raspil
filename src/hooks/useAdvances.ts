import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import type { SalaryAdvance } from "../types/domain";

/**
 * Advances.
 *
 * Pass a `userId` to read one worker's own — the security rule proves a filtered list per
 * document, so a worker's query MUST carry the `where` or the whole query is rejected. Admin and
 * Manager may omit it and read the lot.
 */
export function useAdvances(userId?: string) {
  const [advances, setAdvances] = useState<SalaryAdvance[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = userId
      ? query(collection(db, "advances"), where("userId", "==", userId))
      : query(collection(db, "advances"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setAdvances(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SalaryAdvance, "id">) })));
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, [userId]);

  return { advances, loading };
}
