import { deleteDoc, deleteField, doc, setDoc, updateDoc, type Firestore } from "firebase/firestore";
import type { BirthdayDoc } from "../types/domain";

/**
 * "YYYY-MM-DD" -> "MM-DD". Compared as plain strings throughout this module (both dayKey() in
 * lib/dates.ts and a native <input type="date"> already produce zero-padded YYYY-MM-DD), so no
 * Date parsing — and no timezone question — is ever needed for a comparison that only cares about
 * the calendar date, never the moment.
 */
export function monthDayOf(dateStr: string): string {
  return dateStr.slice(5, 10);
}

/**
 * Saves a worker's own birthday. Writes both documents in one call because they can never be
 * allowed to drift apart: users/{uid}.birthDate is what the Профиль form reads back, and
 * birthdays/{uid} is the narrow, everyone-can-read projection the shop-wide alert actually
 * queries (see BirthdayDoc's own doc comment for why the two are split at all). Neither write
 * depends on the other succeeding or failing — Firestore has no cross-collection transaction here
 * that would make that worth guarding — so a partial failure just means "try Сақтау again".
 */
export async function saveBirthday(
  db: Firestore,
  params: { uid: string; name: string; birthDate: string },
): Promise<void> {
  const monthDay = monthDayOf(params.birthDate);
  await setDoc(doc(db, "users", params.uid), { birthDate: params.birthDate }, { merge: true });
  const entry: BirthdayDoc = { name: params.name, monthDay };
  await setDoc(doc(db, "birthdays", params.uid), entry);
}

/** Clearing the Профиль field back to blank has to actually remove the birthday, not just stop
 *  updating it — otherwise the shop-wide alert keeps firing every year off a date the worker
 *  deliberately took out. */
export async function clearBirthday(db: Firestore, uid: string): Promise<void> {
  await updateDoc(doc(db, "users", uid), { birthDate: deleteField() });
  await deleteDoc(doc(db, "birthdays", uid));
}
