import { addDoc, collection, doc, serverTimestamp, setDoc, updateDoc, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";
import type {
  AttendanceRecord,
  AttendanceStatus,
  MaterialCategory,
  Order,
  SalaryEntry,
  SalaryRule,
  SalaryStatus,
  UserDoc,
} from "../types/domain";
import { buildSalaryEntry } from "./salary";
import { logAudit } from "./audit";

type Actor = { user: User; userData: UserDoc };

/** Hours between two "HH:MM" times, or undefined if either is missing/unparseable. */
export function hoursBetween(checkIn?: string, checkOut?: string): number | undefined {
  if (!checkIn || !checkOut) return undefined;
  const [inH, inM] = checkIn.split(":").map(Number);
  const [outH, outM] = checkOut.split(":").map(Number);
  if ([inH, inM, outH, outM].some((n) => !Number.isFinite(n))) return undefined;
  const minutes = outH * 60 + outM - (inH * 60 + inM);
  return minutes > 0 ? Math.round((minutes / 60) * 100) / 100 : undefined;
}

/**
 * Marks one employee-day. The document id is `${userId}_${date}`, so re-marking the same day
 * updates the existing record instead of creating a second one for the same date.
 */
export async function markAttendance(
  db: Firestore,
  actor: Actor,
  params: {
    userId: string;
    userName: string;
    date: string; // YYYY-MM-DD
    status: AttendanceStatus;
    checkIn?: string;
    checkOut?: string;
    comment?: string;
  },
): Promise<void> {
  const id = `${params.userId}_${params.date}`;
  const workedHours = hoursBetween(params.checkIn, params.checkOut);

  await setDoc(
    doc(db, "attendance", id),
    {
      userId: params.userId,
      userName: params.userName,
      date: params.date,
      status: params.status,
      checkIn: params.checkIn ?? null,
      checkOut: params.checkOut ?? null,
      workedHours: workedHours ?? null,
      comment: params.comment ?? "",
      recordedByUid: actor.user.uid,
      recordedByName: actor.userData.name,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    },
    { merge: true },
  );

  await logAudit(db, actor, {
    action: "attendance.mark",
    entityType: "attendance",
    entityId: id,
    after: { status: params.status, date: params.date },
  });
}

/** Saves a worker's pay rule (Admin only). Document id == userId: one active rule per worker. */
export async function saveSalaryRule(
  db: Firestore,
  actor: Actor,
  userId: string,
  rule: Omit<SalaryRule, "id" | "userId" | "updatedAt" | "updatedByUid" | "updatedByName">,
): Promise<void> {
  await setDoc(
    doc(db, "salaryRules", userId),
    {
      userId,
      ...rule,
      updatedAt: serverTimestamp(),
      updatedByUid: actor.user.uid,
      updatedByName: actor.userData.name,
    },
    { merge: true },
  );

  await logAudit(db, actor, {
    action: "salary.rule_change",
    entityType: "salaryRule",
    entityId: userId,
    after: { mode: rule.mode },
  });
}

/**
 * Recalculates and stores one worker's salary entry for one period. Re-runnable: the document id
 * is `${userId}_${periodKey}`, so recalculating overwrites rather than accumulating duplicates.
 * Refuses to touch an entry that has already been paid — a payslip that has been settled is
 * history, and correcting it is what SalaryAdjustment is for.
 */
export async function recalculateSalary(
  db: Firestore,
  actor: Actor,
  params: {
    userId: string;
    userName: string;
    periodKey: string;
    rule: SalaryRule | undefined;
    orders: Order[];
    attendance: AttendanceRecord[];
    /** Material category per materialId, so per-sheet pay uses the right rate for ХДФ/столешница. */
    categoryByMaterialId?: Map<string, MaterialCategory>;
    adjustmentTiyn: number;
    bonusTiyn?: number;
    existing?: SalaryEntry;
  },
): Promise<void> {
  if (params.existing?.status === "paid") {
    throw new Error("Төленген айлықты қайта есептеу мүмкін емес. Түзету енгізіңіз.");
  }

  const built = buildSalaryEntry({
    userId: params.userId,
    userName: params.userName,
    periodKey: params.periodKey,
    rule: params.rule,
    orders: params.orders,
    attendance: params.attendance,
    categoryByMaterialId: params.categoryByMaterialId,
    bonusTiyn: params.bonusTiyn,
    adjustmentTiyn: params.adjustmentTiyn,
  });

  const id = `${params.userId}_${params.periodKey}`;
  await setDoc(
    doc(db, "salaryEntries", id),
    { ...built, status: "calculated" satisfies SalaryStatus, updatedAt: serverTimestamp() },
    { merge: true },
  );

  await logAudit(db, actor, {
    action: "salary.recalculate",
    entityType: "salaryEntry",
    entityId: id,
    after: { finalTiyn: built.finalTiyn, periodKey: params.periodKey },
  });
}

/** Moves a salary entry along calculated → confirmed → paid. */
export async function setSalaryStatus(
  db: Firestore,
  actor: Actor,
  entry: SalaryEntry,
  status: SalaryStatus,
): Promise<void> {
  await updateDoc(doc(db, "salaryEntries", entry.id), {
    status,
    ...(status === "confirmed" ? { confirmedAt: serverTimestamp() } : {}),
    ...(status === "paid" ? { paidAt: serverTimestamp() } : {}),
    updatedAt: serverTimestamp(),
  });

  await logAudit(db, actor, {
    action: "salary.status_change",
    entityType: "salaryEntry",
    entityId: entry.id,
    before: { status: entry.status },
    after: { status },
  });
}

/**
 * Records a salary adjustment. The reason is mandatory — an adjustment without one is refused
 * here rather than saved with an empty string, so the audit trail is always explicable.
 */
export async function addSalaryAdjustment(
  db: Firestore,
  actor: Actor,
  params: { userId: string; periodKey: string; amountTiyn: number; reason: string },
): Promise<void> {
  const reason = params.reason.trim();
  if (!reason) throw new Error("Түзету себебі міндетті");
  if (params.amountTiyn === 0) throw new Error("Түзету сомасы нөл болмауы керек");

  const ref = await addDoc(collection(db, "salaryAdjustments"), {
    userId: params.userId,
    periodKey: params.periodKey,
    amountTiyn: params.amountTiyn,
    reason,
    createdByUid: actor.user.uid,
    createdByName: actor.userData.name,
    createdAt: serverTimestamp(),
  });

  await logAudit(db, actor, {
    action: "salary.adjustment",
    entityType: "salaryAdjustment",
    entityId: ref.id,
    after: { amountTiyn: params.amountTiyn, periodKey: params.periodKey },
    comment: reason,
  });
}
