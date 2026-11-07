import { addDoc, collection, deleteDoc, doc, serverTimestamp, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";
import type { CashReceipt, CashReceiptKind, Department, UserDoc } from "../types/domain";
import { logAudit } from "./audit";

type Actor = { user: User; userData: UserDoc };

/**
 * A failed read or write in words the Admin can act on. «Missing or insufficient permissions» on
 * his phone meant nothing to him (07.11: «нал толтырылмай тұр») — it was firestore.rules not yet
 * deployed with the cashReceipts block.
 */
export function cashReceiptErrorText(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code === "permission-denied" || /insufficient permissions/i.test(e?.message ?? "")) {
    return "рұқсат жоқ — Firestore ережелері әлі жаңартылмаған (firebase deploy --only firestore:rules)";
  }
  return e?.message ?? String(err);
}

/**
 * Records «Нал ақша алдым» — "Мейрам, 50 000 ₸, 03.11", or "Обнал, Ақжол, 100 000 ₸" — under the
 * Admin writing it. Nothing else moves: a customer's cash was counted on Касса when the journal
 * took it, обнал when Касса booked the transfer (lib/cashReceipts.ts).
 */
export async function addCashReceipt(
  db: Firestore,
  actor: Actor,
  data: {
    kind: CashReceiptKind;
    customerName: string;
    customerPhone: string;
    amountTiyn: number;
    date: string;
    comment: string;
    department: Department;
  },
): Promise<string> {
  const obnal = data.kind === "obnal";
  const entry = {
    kind: data.kind,
    customerName: data.customerName.trim(),
    // Only kept when there is one — an empty string would read as "this customer has no phone".
    ...(!obnal && data.customerPhone.trim() ? { customerPhone: data.customerPhone.trim() } : {}),
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
      kind: receipt.kind ?? "customer",
      customerName: receipt.customerName,
      amountTiyn: receipt.amountTiyn,
      date: receipt.date,
      comment: receipt.comment ?? "",
      department: receipt.department ?? "ldsp",
      createdByName: receipt.createdByName,
    },
  });
}
