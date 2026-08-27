import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import type { AttendanceRecord, SalaryAdjustment, SalaryEntry, SalaryRule } from "../types/domain";

/** One worker's pay rule (document id == userId). Undefined once loaded means "no rule yet". */
export function useSalaryRule(userId: string | undefined) {
  const [rule, setRule] = useState<SalaryRule | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) {
      setRule(undefined);
      setLoading(false);
      return;
    }
    const unsub = onSnapshot(
      doc(db, "salaryRules", userId),
      (snap) => {
        setRule(snap.exists() ? ({ id: snap.id, ...(snap.data() as Omit<SalaryRule, "id">) }) : undefined);
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, [userId]);

  return { rule, loading };
}

/** All salary rules — Admin's salary settings screen. */
export function useAllSalaryRules() {
  const [rules, setRules] = useState<SalaryRule[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "salaryRules"),
      (snap) => {
        setRules(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SalaryRule, "id">) })));
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, []);

  return { rules, loading };
}

/**
 * Salary entries. Pass a userId to scope to one worker (what a worker's own page must do —
 * firestore.rules only lets a non-Admin read their own), or omit it for Admin's overview.
 */
export function useSalaryEntries(userId?: string) {
  const [entries, setEntries] = useState<SalaryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = userId
      ? query(collection(db, "salaryEntries"), where("userId", "==", userId))
      : query(collection(db, "salaryEntries"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setEntries(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SalaryEntry, "id">) })));
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, [userId]);

  return { entries, loading };
}

/** Salary adjustments, optionally scoped to one worker. */
export function useSalaryAdjustments(userId?: string) {
  const [adjustments, setAdjustments] = useState<SalaryAdjustment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = userId
      ? query(collection(db, "salaryAdjustments"), where("userId", "==", userId))
      : query(collection(db, "salaryAdjustments"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setAdjustments(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SalaryAdjustment, "id">) })));
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, [userId]);

  return { adjustments, loading };
}

/** Attendance records, optionally scoped to one worker (a worker may only read their own). */
export function useAttendance(userId?: string) {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = userId
      ? query(collection(db, "attendance"), where("userId", "==", userId))
      : query(collection(db, "attendance"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setRecords(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AttendanceRecord, "id">) })));
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, [userId]);

  return { records, loading };
}
