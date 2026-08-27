import { doc, getDoc, runTransaction, type Firestore } from "firebase/firestore";

/** Generates a unique "ORD-{year}-{seq:6}" via an atomic counter transaction — never duplicated. */
export async function generateOrderNumber(db: Firestore): Promise<string> {
  const year = new Date().getFullYear();
  const counterRef = doc(db, "counters", `orderNumber_${year}`);
  const seq = await runTransaction(db, async (tx) => {
    const snap = await getDoc(counterRef);
    const current = snap.exists() ? (snap.data().seq as number) : 0;
    const next = current + 1;
    tx.set(counterRef, { seq: next }, { merge: true });
    return next;
  });
  return `ORD-${year}-${String(seq).padStart(6, "0")}`;
}
