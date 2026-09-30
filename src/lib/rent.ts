import { addDoc, collection, deleteDoc, doc, serverTimestamp, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";
import type { Department, RentPayment, UserDoc } from "../types/domain";
import { logAudit } from "./audit";

type Actor = { user: User; userData: UserDoc };

/**
 * Records rent received — "Аренда, Бекзат — 150 000 ₸, Нұр". The money is in whichever account
 * its method lands in, so Касса adds it to that pot as its own "+ Аренда" line
 * (lib/cashbox.ts computeCashbox) and the balance keeps matching the bank.
 */
export async function addRentPayment(
  db: Firestore,
  actor: Actor,
  data: {
    payerName: string;
    amountTiyn: number;
    methodId: string;
    methodName: string;
    date: string;
    comment: string;
    department: Department;
  },
): Promise<string> {
  const ref = await addDoc(collection(db, "rentPayments"), {
    ...data,
    createdByUid: actor.user.uid,
    createdByName: actor.userData.name,
    createdAt: serverTimestamp(),
  });
  await logAudit(db, actor, {
    action: "rent.create",
    entityType: "rentPayment",
    entityId: ref.id,
    after: data,
  });
  return ref.id;
}

/** Removes a rent entry — the owner correcting a typo. Nothing else refers to it by id. */
export async function deleteRentPayment(db: Firestore, actor: Actor, rent: RentPayment): Promise<void> {
  await deleteDoc(doc(db, "rentPayments", rent.id));
  await logAudit(db, actor, {
    action: "rent.delete",
    entityType: "rentPayment",
    entityId: rent.id,
    before: { payerName: rent.payerName, amountTiyn: rent.amountTiyn, methodName: rent.methodName, date: rent.date },
  });
}
