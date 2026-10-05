import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  isEmptyPlan,
  nextOrderNumber,
  nextSettlementStart,
  orderNumberLike,
  planSettlement,
  settlementFromPlan,
  settlementOfExpense,
  type SettlementInput,
} from "./settlements";
import type { Expense, Order, Payment, PaymentMethodDef, Settlement } from "../types/domain";

const T = (n: number) => n * 100; // ₸ → tiyn
const at = (iso: string) => Timestamp.fromDate(new Date(`${iso}+05:00`));
const no = (n: number) => `ORD-2026-${String(n).padStart(6, "0")}`;

const methods = [
  { id: "nur", name: "Нұр", account: "deposit" },
  { id: "pay", name: "Pay", account: "pay" },
  { id: "cash", name: "Нал / Қолма-қол", account: "cash" },
] as PaymentMethodDef[];

const order = (n: number, created = "2026-10-01T10:00:00") =>
  ({ id: `o${n}`, orderNumber: no(n), createdAt: at(created) }) as Order;
const orders = [order(275, "2026-09-29T10:00:00"), ...[281, 290, 300, 301, 310].map((n) => order(n))];

let seq = 0;
const payment = (n: number, amount: number, methodId: string, recorded: string, extra: Partial<Payment> = {}) =>
  ({
    id: `p${++seq}`,
    orderId: `o${n}`,
    amountTiyn: T(amount),
    methodId,
    methodName: methodId,
    paymentDate: at(recorded),
    createdAt: at(recorded),
    reversed: false,
    ...extra,
  }) as Payment;
const expense = (amount: number, date: string, recorded: string) =>
  ({ id: `e${++seq}`, name: "Мусор", amountTiyn: T(amount), date, createdAt: at(recorded) }) as Expense;

const base = (payments: Payment[], expenses: Expense[], settlements: Settlement[] = []): SettlementInput => ({
  payments, expenses, methods, orders, settlements, startDate: "2026-09-30", startOrderNumber: no(281),
});
const settle = (input: SettlementInput, to: number) =>
  settlementFromPlan(planSettlement(input, no(to)), `s${++seq}`, { uid: "u", name: "Нур" }, new Date("2026-10-05T10:00:00+05:00"));

describe("nextOrderNumber / orderNumberLike", () => {
  it("counts on in the same year and width", () => {
    expect(nextOrderNumber("ORD-2026-000300")).toBe("ORD-2026-000301");
    expect(orderNumberLike("ORD-2026-000281", 318)).toBe("ORD-2026-000318");
  });
});

describe("planSettlement — the money on a run of orders, less the expenses since the last one", () => {
  const payments = [
    payment(281, 100_000, "nur", "2026-10-01T11:00:00"),
    payment(290, 30_000, "cash", "2026-10-02T11:00:00"),
    payment(300, 20_000, "pay", "2026-10-03T11:00:00"),
    payment(301, 50_000, "nur", "2026-10-03T12:00:00"), // past the line: waits for the next one
    payment(290, 9_000, "cash", "2026-10-02T12:00:00", { reversed: true }),
    payment(275, 40_000, "cash", "2026-10-01T12:00:00"), // the old books' — Касса leaves it out
    payment(275, 15_000, "nur", "2026-10-02T09:00:00", { countsInCurrentBooks: true }), // brought in by an Admin
  ];
  const expenses = [
    expense(12_500, "2026-09-30", "2026-09-30T15:00:00"),
    expense(5_000, "2026-09-29", "2026-09-29T15:00:00"), // the old books'
    expense(7_000, "2026-10-03", "2026-10-03T12:30:00"),
  ];

  it("starts where the books start and takes what Касса counts on orders up to the line", () => {
    const plan = planSettlement(base(payments, expenses), no(300));
    expect(plan.fromOrderNumber).toBe(no(281));
    expect(plan.incomeTiyn).toBe(T(100_000 + 30_000 + 20_000 + 15_000));
    expect(plan.incomeByAccount).toEqual({ deposit: T(115_000), pay: T(20_000), cash: T(30_000) });
    expect(plan.lateIncomeTiyn).toBe(T(15_000));
    expect(plan.deferredTiyn).toBe(T(50_000));
    expect(plan.expenseTiyn).toBe(T(12_500 + 7_000));
    expect(plan.resultTiyn).toBe(T(165_000 - 19_500));
  });

  it("settles up to the newest record, not the device clock", () => {
    expect(planSettlement(base(payments, expenses), no(300)).atMs).toBe(at("2026-10-03T12:30:00").toMillis());
  });

  it("gives the next settlement what came in late, what waited past the line and what was spent since — and nothing twice", () => {
    const first = settle(base(payments, expenses), 300);
    const later = [
      ...payments,
      payment(290, 8_000, "cash", "2026-10-04T10:00:00"), // a debt on an order already settled
      payment(310, 60_000, "pay", "2026-10-04T11:00:00"),
    ];
    const laterExpenses = [...expenses, expense(3_000, "2026-10-01", "2026-10-04T12:00:00")]; // typed in late, dated back
    const plan = planSettlement(base(later, laterExpenses, [first]), no(310));
    expect(plan.fromOrderNumber).toBe(no(301));
    expect(plan.incomeTiyn).toBe(T(50_000 + 8_000 + 60_000));
    expect(plan.lateIncomeTiyn).toBe(T(8_000));
    expect(plan.deferredTiyn).toBe(0);
    expect(plan.expenseTiyn).toBe(T(3_000));
    expect(nextSettlementStart([first], no(281))).toBe(no(301));
  });

  it("says which settlement took an expense", () => {
    const first = settle(base(payments, expenses), 300);
    expect(settlementOfExpense(expenses[0], [first], "2026-09-30")?.id).toBe(first.id);
    expect(settlementOfExpense(expenses[1], [first], "2026-09-30")).toBeNull(); // the old books'
    expect(settlementOfExpense(expense(1_000, "2026-10-05", "2026-10-05T09:00:00"), [first], "2026-09-30")).toBeNull();
    expect(settlementOfExpense({ ...expenses[2], createdAt: null } as unknown as Expense, [first], "2026-09-30")).toBeNull(); // still being saved
  });

  it("keeps the totals it came to", () => {
    const s = settle(base(payments, expenses), 300);
    expect(s).toMatchObject({
      fromOrderNumber: no(281), toOrderNumber: no(300), date: "2026-10-05",
      incomeTiyn: T(165_000), lateIncomeTiyn: T(15_000), paymentCount: 4, expenseTiyn: T(19_500), expenseCount: 2,
      carriedIncomeTiyn: 0, carriedExpenseTiyn: 0, resultTiyn: T(145_500), byName: "Нур",
    });
  });
});

describe("planSettlement — records that change after they are settled come back as «түзету»", () => {
  const p290 = payment(290, 100_000, "nur", "2026-10-01T11:00:00");
  const old = payment(275, 40_000, "cash", "2026-10-01T12:00:00"); // the old books' — Касса leaves it out
  const e1 = expense(15_000, "2026-10-02", "2026-10-02T10:00:00"); // typed for 1 500
  const first = settle(base([p290, old], [e1]), 300);
  /** Money in across every settlement made, and the money Касса counts on the settled orders now. */
  const settledIncome = (all: Settlement[]) => all.reduce((s, x) => s + x.incomeTiyn + x.carriedIncomeTiyn, 0);
  const settledExpense = (all: Settlement[]) => all.reduce((s, x) => s + x.expenseTiyn + x.carriedExpenseTiyn, 0);

  it("«Төленді» typed lower: the reversal is taken back and the new figure counted, once", () => {
    // ManagerJournal handleSetPaid: reverse the 100 000, record 90 000 the next day.
    const later = [{ ...p290, reversed: true }, payment(290, 90_000, "nur", "2026-10-06T10:00:00")];
    const plan = planSettlement(base(later, [e1], [first]), no(310));
    expect(plan.incomeTiyn).toBe(T(90_000));
    expect(plan.carriedIncomeTiyn).toBe(-T(100_000));
    expect(plan.carriedByAccount.deposit).toBe(-T(100_000));
    expect(settledIncome([first, settle(base(later, [e1], [first]), 310)])).toBe(T(90_000));
  });

  it("an amount corrected in place, and an old order's payment brought into Касса afterwards", () => {
    // Both were recorded before the first settlement; the first counted 100 000 and left the 40 000 out.
    const moved = [{ ...p290, amountTiyn: T(108_000) }, { ...old, countsInCurrentBooks: true }];
    const plan = planSettlement(base(moved, [e1], [first]), no(310));
    expect(plan.incomeTiyn).toBe(0);
    expect(plan.carriedIncomeTiyn).toBe(T(8_000 + 40_000));
    expect(plan.carriedByAccount).toEqual({ deposit: T(8_000), pay: 0, cash: T(40_000) });
    expect(isEmptyPlan(plan)).toBe(false);
  });

  it("an expense deleted and typed again", () => {
    const retyped = [expense(1_500, "2026-10-02", "2026-10-06T10:00:00")];
    const plan = planSettlement(base([p290], retyped, [first]), no(310));
    expect(plan.expenseTiyn).toBe(T(1_500));
    expect(plan.carriedExpenseTiyn).toBe(-T(15_000));
    expect(plan.resultTiyn).toBe(T(13_500));
    expect(settledExpense([first, settle(base([p290], retyped, [first]), 310)])).toBe(T(1_500));
  });

  it("never settles up to a moment before the last settlement, even when its newest record is gone", () => {
    const plan = planSettlement(base([p290], [], [first]), no(310)); // e1, the newest record, deleted
    expect(plan.atMs).toBe(first.atMs);
    expect(plan.carriedExpenseTiyn).toBe(-T(15_000));
  });

  it("nothing moved and nothing new: an empty plan", () => {
    expect(isEmptyPlan(planSettlement(base([p290], [e1], [first]), no(310)))).toBe(true);
  });
});

describe("a Касса restart after settlements", () => {
  it("leaves the earlier ones as history: nothing carried, and the next starts where the new books do", () => {
    const p290 = payment(290, 100_000, "nur", "2026-10-01T11:00:00");
    const first = settle(base([p290], []), 300);
    const restarted: SettlementInput = {
      ...base([p290, payment(310, 30_000, "cash", "2026-10-07T10:00:00")], [], [first]),
      startDate: "2026-10-06", startOrderNumber: no(310),
    };
    const plan = planSettlement(restarted, no(310));
    expect(plan.fromOrderNumber).toBe(no(310));
    expect(plan.incomeTiyn).toBe(T(30_000));
    expect(plan.carriedIncomeTiyn).toBe(0);
    expect(settlementFromPlan(plan, "x", { uid: "u", name: "Нур" })).toMatchObject({ startDate: "2026-10-06", startOrderNumber: no(310) });
  });
});

describe("nextSettlementStart — across New Year", () => {
  it("starts at the first order after the last settlement's, in whatever year it is", () => {
    const s = { toOrderNumber: "ORD-2026-000500", atMs: 1 } as Settlement;
    const lineOrders = [{ id: "a", orderNumber: "ORD-2026-000500" }, { id: "b", orderNumber: "ORD-2027-000001" }] as Order[];
    expect(nextSettlementStart([s], no(281), lineOrders)).toBe("ORD-2027-000001");
    expect(nextSettlementStart([s], no(281), [])).toBe("ORD-2026-000501");
    expect(nextSettlementStart([], no(281), lineOrders)).toBe(no(281));
  });
});
