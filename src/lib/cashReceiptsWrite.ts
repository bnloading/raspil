import { addDoc, collection, deleteDoc, doc, serverTimestamp, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";
import type { CashReceipt, Department, UserDoc } from "../types/domain";
import { logAudit } from "./audit";

type Actor = { user: User; userData: UserDoc };

/**
 * Records «Нал ақша алдым» — "Мейрам, 50 000 ₸, 03.11" — under the Admin writing it. Nothing else
 * moves: the cash was counted on Касса when the journal took it (lib/cashReceipts.ts).
 */
export async function addCashReceipt(
  db: Firestore,
  actor: Actor,
  data: {
    customerName: string;
    customerPhone: string;
    amountTiyn: number;
    date: string;
    comment: string;
    department: Department;
  },
): Promise<string> {
  const entry = {
    customerName: data.customerName.trim(),
    // Only kept when there is one — an empty string would read as "this customer has no phone".
    ...(data.customerPhone.trim() ? { customerPhone: data.customerPhone.trim() } : {}),
    amountTiyn: data.amountTiyn,
    date: data.date,
    comment: data.comment.trim(),
    department: data.department,
  };
  const ref = await addDoc(collection(db, "cashReceipts"), {
    ...entry,
    createdByUid: actor.user.uid,
    createdByName: actor.userData.name,
    createdAt: serverTimestamp(),
  });
  await logAudit(db, actor, { action: "cash_receipt.create", entityType: "cashReceipt", entityId: ref.id, after: entry });
  return ref.id;
}

/** Removes an entry — a typo, a hand-over written twice. Nothing else refers to it by id. */
export async function deleteCashReceipt(db: Firestore, actor: Actor, receipt: CashReceipt): Promise<void> {
  await deleteDoc(doc(db, "cashReceipts", receipt.id));
  await logAudit(db, actor, {
    action: "cash_receipt.delete",
    entityType: "cashReceipt",
    entityId: receipt.id,
    before: {
      customerName: receipt.customerName,
      amountTiyn: receipt.amountTiyn,
      date: receipt.date,
      comment: receipt.comment ?? "",
      department: receipt.department ?? "ldsp",
      createdByName: receipt.createdByName,
    },
  });
}
