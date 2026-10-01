import { describe, it, expect } from "vitest";
import { expenseDefaultDate, expensesByWeek, monthlyExpensesTotal, weekStartOf } from "./expenses";
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

describe("expensesByWeek — the expense log a week to a line, old weeks kept", () => {
  it("starts a week on Monday", () => {
    expect(weekStartOf("2026-10-01")).toBe("2026-09-28"); // Thursday
    expect(weekStartOf("2026-09-28")).toBe("2026-09-28"); // Monday itself
    expect(weekStartOf("2026-09-27")).toBe("2026-09-21"); // Sunday closes the week before
  });

  it("groups by week, newest week first, each week's entries newest first", () => {
    const weeks = expensesByWeek([
      expense({ id: "a", date: "2026-09-22", amountTiyn: T(1000) }),
      expense({ id: "b", date: "2026-09-29", amountTiyn: T(300000) }),
      expense({ id: "c", date: "2026-09-27", amountTiyn: T(2000) }),
      expense({ id: "d", date: "2026-10-01", amountTiyn: T(5000) }),
    ]);
    expect(weeks.map((w) => [w.start, w.end, w.totalTiyn])).toEqual([
      ["2026-09-28", "2026-10-04", T(305000)],
      ["2026-09-21", "2026-09-27", T(3000)],
    ]);
    expect(weeks[0].expenses.map((e) => e.id)).toEqual(["d", "b"]);
  });

  it("has nothing to show for an empty log", () => {
    expect(expensesByWeek([])).toEqual([]);
  });
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

describe("expenseDefaultDate — the day a new expense lands on", () => {
  /** Noon Almaty on 19 September, well away from either day boundary. */
  const now = new Date("2026-09-19T12:00:00+05:00");

  it("uses today while the current month is on screen", () => {
    // The bug this replaces: it handed back the 1st, so seven expenses typed on the 19th were
    // filed on the 1st — before the accounting restart, where nothing on Касса would show them.
    expect(expenseDefaultDate("2026-09", now)).toBe("2026-09-19");
  });

  it("uses today for the all-time view too", () => {
    expect(expenseDefaultDate(null, now)).toBe("2026-09-19");
  });

  it("falls back to the 1st only for a month that is genuinely over", () => {
    // Picking Тамыз and being handed today's date would mean correcting every backdated entry.
    expect(expenseDefaultDate("2026-08", now)).toBe("2026-08-01");
    expect(expenseDefaultDate("2025-12", now)).toBe("2025-12-01");
  });
});
