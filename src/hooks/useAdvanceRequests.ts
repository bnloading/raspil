import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import type { AdvanceRequest } from "../types/domain";

/**
 * «Аванс сұрау» requests, live.
 *
 * `{ userId }` — one worker's own; firestore.rules proves a worker's list per document, so the
 * query must carry the `where` or it is refused whole. `{ pending: true }` — every request still
 * waiting, for the Admin and Managers, who filter it to their own line (lib/advanceRequests.ts
 * pendingForLine). Nothing is read while neither is given.
 */
export function useAdvanceRequests(scope: { userId?: string; pending?: boolean }) {
  const { userId, pending } = scope;
  const [requests, setRequests] = useState<AdvanceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRequests([]);
    setError(null);
    const q = userId
      ? query(collection(db, "advanceRequests"), where("userId", "==", userId))
      : pending
        ? query(collection(db, "advanceRequests"), where("status", "==", "pending"))
        : null;
    if (!q) {
      setLoading(false);
      return;
    }
    setLoading(true);
    return onSnapshot(
      q,
      (snap) => {
        setRequests(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AdvanceRequest, "id">) })));
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      },
    );
  }, [userId, pending]);

  return { requests, loading, error };
}
