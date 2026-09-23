import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { dayKey } from "../lib/dates";
import { monthDayOf } from "../lib/birthdays";
import type { BirthdayDoc } from "../types/domain";

/**
 * Every name whose birthday is today (Asia/Almaty calendar day), from the shop-wide /birthdays
 * collection any signed-in user may read — see BirthdayDoc's doc comment for why that collection
 * exists separately from /users. A shop's whole staff is a handful of documents, so reading all of
 * them and filtering client-side (the same shape useExpenseCategories/useAppSettings already use)
 * costs nothing worth a server-side query over.
 */
export function useTodaysBirthdays(): string[] {
  const [all, setAll] = useState<BirthdayDoc[]>([]);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "birthdays"),
      (snap) => setAll(snap.docs.map((d) => d.data() as BirthdayDoc)),
      () => setAll([]),
    );
    return unsub;
  }, []);

  return useMemo(() => {
    const today = monthDayOf(dayKey(new Date()));
    return all.filter((b) => b.monthDay === today).map((b) => b.name);
  }, [all]);
}
