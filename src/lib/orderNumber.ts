import { doc, runTransaction, type Firestore } from "firebase/firestore";

/** Generates a unique "ORD-{year}-{seq:6}" via an atomic counter transaction — never duplicated. */
export async function generateOrderNumber(db: Firestore): Promise<string> {
  const year = new Date().getFullYear();
  const counterRef = doc(db, "counters", `orderNumber_${year}`);
  const seq = await runTransaction(db, async (tx) => {
    // Must be tx.get(), not the standalone getDoc() — a plain read here sits outside the
    // transaction's read set, so two managers adding a row at the same moment could both read the
    // same counter value and commit the same "next" number, which is exactly the collision this
    // function exists to prevent. tx.get() makes Firestore detect the conflict and retry one of
    // them instead.
    const snap = await tx.get(counterRef);
    const current = snap.exists() ? (snap.data().seq as number) : 0;
    const next = current + 1;
    tx.set(counterRef, { seq: next }, { merge: true });
    return next;
  });
  return `ORD-${year}-${String(seq).padStart(6, "0")}`;
}
