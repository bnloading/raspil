import {
  addDoc,
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  type Firestore,
} from "firebase/firestore";
import type { User } from "firebase/auth";
import type { AdvanceRequest, CashAccount, Department, UserDoc } from "../types/domain";
import { advancePeriodKey } from "./advances";
import { departmentOf } from "./rbac";
import { dayKey } from "./dates";
import { formatMoney } from "./money";
import { workerPaymentDocs } from "./expenses";
import { logAudit } from "./audit";

type Actor = { user: User; userData: UserDoc };

/**
 * «Аванс сұрау» (the owner, 09.11): a worker on either line asks for an advance from their phone;
 * the Manager of that line answers «Иә, беремін» — and only then does money move, written exactly
 * as the Касса counter writes money handed to a worker: an expense off the pot it left and an
 * advance off the worker's pay (lib/expenses.ts workerPaymentDocs), in the same transaction that
 * marks the request approved, so two Managers tapping at once can never pay it twice.
 */

/** The expense's name on Касса — the same «Олжас — аванс» the counter writes by hand. */
export function advanceExpenseName(workerName: string): string {
  return `${workerName.trim()} — аванс`;
}

/** This line's requests still waiting on an answer, oldest first — the one asked earliest is answered first. */
export function pendingForLine(requests: readonly AdvanceRequest[], department: Department): AdvanceRequest[] {
  return requests
    .filter((r) => r.status === "pending" && (r.department ?? "ldsp") === department)
    .sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));
}

/** A worker's own requests, newest first; the one still waiting, if any, is the first. */
export function ownRequests(requests: readonly AdvanceRequest[]): { pending: AdvanceRequest | null; history: AdvanceRequest[] } {
  const sorted = [...requests].sort((a, b) => (b.createdAt?.seconds ?? Infinity) - (a.createdAt?.seconds ?? Infinity));
  const pending = sorted.find((r) => r.status === "pending") ?? null;
  return { pending, history: sorted.filter((r) => r !== pending) };
}

/** Notifications go to the Admins and Managers of the request's own line only — ЛДСП and МДФ are kept apart. */
async function notifyLine(db: Firestore, department: Department, title: string, body: string): Promise<void> {
  const snap = await getDocs(query(collection(db, "users"), where("role", "in", ["admin", "manager"])));
  await Promise.all(
    snap.docs
      .filter((d) => {
        const u = d.data() as UserDoc;
        return !u.blocked && departmentOf(u) === department;
      })
      .map((d) =>
        addDoc(collection(db, "notifications"), {
          userId: d.id, type: "advance_request", title, body, read: false, createdAt: serverTimestamp(),
        }),
      ),
  );
}

async function notifyWorker(db: Firestore, userId: string, title: string, body: string): Promise<void> {
  await addDoc(collection(db, "notifications"), {
    userId, type: "advance_request", title, body, read: false, createdAt: serverTimestamp(),
  });
}

/** The worker asks. Nothing moves until a Manager answers. */
export async function requestAdvance(
  db: Firestore,
  actor: Actor,
  data: { amountTiyn: number; comment: string },
): Promise<string> {
  if (!Number.isInteger(data.amountTiyn) || data.amountTiyn <= 0) throw new Error("Соманы жазыңыз");
  const department = departmentOf(actor.userData);
  const ref = await addDoc(collection(db, "advanceRequests"), {
    userId: actor.user.uid,
    userName: actor.userData.name,
    role: actor.userData.role,
    department,
    amountTiyn: data.amountTiyn,
    comment: data.comment.trim(),
    status: "pending",
    createdAt: serverTimestamp(),
  });
  // A failed notification must not read as a failed request — the request is already there, and
  // the Manager sees it on Касса either way.
  await notifyLine(
    db,
    department,
    `💵 ${actor.userData.name} аванс сұрады`,
    `${formatMoney(data.amountTiyn)}${data.comment.trim() ? ` · ${data.comment.trim()}` : ""} — Касса бетінде жауап беріңіз`,
  ).catch(() => {});
  return ref.id;
}

/** The worker takes their own request back while it is still waiting. */
export async function cancelAdvanceRequest(db: Firestore, request: AdvanceRequest): Promise<void> {
  await updateDoc(doc(db, "advanceRequests", request.id), { status: "cancelled", cancelledAt: serverTimestamp() });
}

/**
 * «Иә, беремін»: the expense, the advance and the answer, all or none. The Manager may hand over
 * less than was asked, and chooses the pot it leaves — the cash drawer unless they say otherwise.
 */
export async function approveAdvanceRequest(
  db: Firestore,
  actor: Actor,
  request: AdvanceRequest,
  { amountTiyn, account }: { amountTiyn: number; account: CashAccount },
): Promise<void> {
  if (!Number.isInteger(amountTiyn) || amountTiyn <= 0) throw new Error("Соманы жазыңыз");
  const ref = doc(db, "advanceRequests", request.id);
  const periodKey = advancePeriodKey(request.role);
  const pay = workerPaymentDocs(db, actor, {
    name: advanceExpenseName(request.userName),
    amountTiyn,
    date: dayKey(new Date()),
    comment: request.comment ? `Аванс сұрауы: ${request.comment}` : "Аванс сұрауы бойынша",
    account,
    department: request.department ?? "ldsp",
    worker: { uid: request.userId, name: request.userName },
    periodKey,
  });
  await runTransaction(db, async (tx) => {
    const now = (await tx.get(ref)).data() as AdvanceRequest | undefined;
    if (!now) throw new Error("сұрау табылмады");
    if (now.status !== "pending") {
      throw new Error(
        now.status === "approved" ? `бұл аванс берілген (${now.decidedByName ?? ""})`
          : now.status === "cancelled" ? "жұмысшы сұрауын қайтарып алды"
            : "бұл сұрауға жауап берілген",
      );
    }
    tx.set(pay.expenseRef, pay.expense);
    tx.set(pay.advanceRef, pay.advance);
    tx.update(ref, {
      status: "approved",
      approvedTiyn: amountTiyn,
      account,
      periodKey,
      expenseId: pay.expenseRef.id,
      advanceId: pay.advanceRef.id,
      decidedByUid: actor.user.uid,
      decidedByName: actor.userData.name,
      decidedAt: serverTimestamp(),
    });
  });
  await logAudit(db, actor, {
    action: "advance_request.approve",
    entityType: "advanceRequest",
    entityId: request.id,
    after: { worker: request.userName, askedTiyn: request.amountTiyn, approvedTiyn: amountTiyn, account, periodKey, expenseId: pay.expenseRef.id },
  }).catch(() => {});
  await notifyWorker(db, request.userId, `✅ Аванс берілді: ${formatMoney(amountTiyn)}`,
    `${actor.userData.name} берді${amountTiyn !== request.amountTiyn ? ` (сұрағаныңыз ${formatMoney(request.amountTiyn)})` : ""} — айлығыңыздан шегеріледі`,
  ).catch(() => {});
}

/** «Жоқ» — with a reason if the Manager gives one. Nothing moves. */
export async function declineAdvanceRequest(db: Firestore, actor: Actor, request: AdvanceRequest, reason: string): Promise<void> {
  const ref = doc(db, "advanceRequests", request.id);
  await runTransaction(db, async (tx) => {
    const now = (await tx.get(ref)).data() as AdvanceRequest | undefined;
    if (!now || now.status !== "pending") throw new Error("бұл сұрауға жауап берілген");
    tx.update(ref, {
      status: "declined",
      declineReason: reason.trim(),
      decidedByUid: actor.user.uid,
      decidedByName: actor.userData.name,
      decidedAt: serverTimestamp(),
    });
  });
  await logAudit(db, actor, {
    action: "advance_request.decline",
    entityType: "advanceRequest",
    entityId: request.id,
    after: { worker: request.userName, askedTiyn: request.amountTiyn, reason: reason.trim() },
  }).catch(() => {});
  await notifyWorker(db, request.userId, `Аванс берілмеді: ${formatMoney(request.amountTiyn)}`,
    reason.trim() ? `${actor.userData.name}: ${reason.trim()}` : `${actor.userData.name} бас тартты`,
  ).catch(() => {});
}
