import { addDoc, collection, doc, serverTimestamp, updateDoc, type Firestore } from "firebase/firestore";
import type { UserDoc } from "../types/domain";

interface Actor {
  user: { uid: string };
  userData: Pick<UserDoc, "name">;
}

/**
 * Records money handed to a worker.
 *
 * `recordedByUid` is taken from the caller rather than a parameter — firestore.rules requires it
 * to equal the signed-in uid, so an entry can never be attributed to someone else.
 */
export async function recordAdvance(
  db: Firestore,
  actor: Actor,
  params: { userId: string; userName: string; periodKey: string; amountTiyn: number; note?: string },
): Promise<void> {
  if (!Number.isInteger(params.amountTiyn) || params.amountTiyn <= 0) {
    throw new Error("Сома оң сан болуы керек");
  }
  await addDoc(collection(db, "advances"), {
    userId: params.userId,
    userName: params.userName,
    periodKey: params.periodKey,
    amountTiyn: params.amountTiyn,
    note: params.note?.trim() || "",
    paidAt: serverTimestamp(),
    recordedByUid: actor.user.uid,
    recordedByName: actor.userData.name,
    reversed: false,
    createdAt: serverTimestamp(),
  });
}

/**
 * Cancels an advance that was recorded in error. Admin-only in the rules, and the amount is left
 * untouched — the record stays, flagged, so the history still shows what happened and why.
 */
export async function reverseAdvance(
  db: Firestore,
  actor: Actor,
  params: { advanceId: string; reason: string },
): Promise<void> {
  const reason = params.reason.trim();
  if (!reason) throw new Error("Себебін жазыңыз");
  await updateDoc(doc(db, "advances", params.advanceId), {
    reversed: true,
    reversalReason: reason,
    reversedByName: actor.userData.name,
  });
}
