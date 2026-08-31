import { describe, it, expect } from "vitest";
import { monthlyExpensesTotal } from "./expenses";
import type { Expense } from "../types/domain";

const T = (n: number) => n * 100; // ₸ → tiyn

const expense = (over: Partial<Expense> = {}): Expense => ({
  id: "e1",
  name: "Мусор",
  amountTiyn: T(12500),
  date: "2026-03-15",
  createdByUid: "admin-1",
  createdByName: "Admin",
  ...over,
});

describe("monthlyExpensesTotal", () => {
  it("sums only the entries logged in the given month", () => {
    const list = [
      expense({ id: "a", date: "2026-03-01", amountTiyn: T(5000) }),
      expense({ id: "b", date: "2026-03-31", amountTiyn: T(7500) }),
      expense({ id: "c", date: "2026-04-01", amountTiyn: T(9000) }),
    ];
    expect(monthlyExpensesTotal(list, "2026-03")).toBe(T(12500));
    expect(monthlyExpensesTotal(list, "2026-04")).toBe(T(9000));
    expect(monthlyExpensesTotal(list, "2026-05")).toBe(0);
  });

  it("sums everything when the period is null (all time)", () => {
    const list = [expense({ date: "2026-01-05" }), expense({ date: "2026-12-31" })];
    expect(monthlyExpensesTotal(list, null)).toBe(T(25000));
  });

  it("is zero for an empty list", () => {
    expect(monthlyExpensesTotal([], "2026-03")).toBe(0);
  });
});
