import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  accountForExpense,
  accountForMethod,
  computeCashbox,
  expensesInPeriod,
  groupExpensesByName,
  CASH_ACCOUNT_LABELS,
} from "./cashbox";
import type { Expense, Payment, PaymentMethodDef } from "../types/domain";

const T = (n: number) => n * 100; // ₸ → tiyn

/** 2026-08-15 12:00 Almaty, well inside the month whichever way the boundary is read. */
const AUG = Timestamp.fromDate(new Date("2026-08-15T12:00:00+05:00"));
const JUL = Timestamp.fromDate(new Date("2026-07-15T12:00:00+05:00"));

const methods: PaymentMethodDef[] = [
  { id: "cash", name: "Нал / Қолма-қол", active: true, isMixed: false },
  { id: "kaspi", name: "Kaspi", active: true, isMixed: false },
  { id: "nur", name: "Нұр", active: true, isMixed: false },
  { id: "balim", name: "Бәлім", active: true, isMixed: false },
];

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "p1",
    orderId: "o1",
    amountTiyn: 0,
    methodId: "nur",
    methodName: "Нұр",
    paymentDate: AUG,
    recordedByUid: "u1",
    recordedByName: "Manager",
    reversed: false,
    ...overrides,
  };
}

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: "e1",
    name: "Мусор",
    amountTiyn: 0,
    date: "2026-08-15",
    createdByUid: "u1",
    createdByName: "Manager",
    ...overrides,
  };
}

const run = (args: {
  payments?: Payment[];
  expenses?: Expense[];
  period?: string | null;
  openingBalanceTiyn?: Partial<Record<"deposit" | "cash", number>>;
  startDate?: string | null;
}) =>
  computeCashbox({
    payments: args.payments ?? [],
    expenses: args.expenses ?? [],
    methods,
    period: args.period === undefined ? "2026-08" : args.period,
    openingBalanceTiyn: args.openingBalanceTiyn,
    startDate: args.startDate ?? null,
  });

const of = (s: ReturnType<typeof run>, account: "deposit" | "cash") =>
  s.accounts.find((a) => a.account === account)!;

describe("accountForMethod — which pot the money lands in", () => {
  it("cash goes in the drawer, every transfer goes on the deposit", () => {
    expect(accountForMethod(methods[0])).toBe("cash");
    expect(accountForMethod(methods[1])).toBe("deposit");
    expect(accountForMethod(methods[2])).toBe("deposit");
    expect(accountForMethod(methods[3])).toBe("deposit");
  });

  it("an explicit account on the method wins over the default", () => {
    expect(accountForMethod({ id: "cash", account: "deposit" })).toBe("deposit");
    expect(accountForMethod({ id: "kaspi", account: "cash" })).toBe("cash");
  });

  it("reads an unknown method as a transfer rather than as cash", () => {
    // Overstating the drawer is the worse error: it sends someone looking for notes that are not
    // there, where the deposit can at least be checked against a statement.
    expect(accountForMethod(undefined)).toBe("deposit");
    expect(accountForMethod({ id: "deleted-method" })).toBe("deposit");
  });
});

describe("accountForExpense", () => {
  it("treats an expense logged before the split as cash out of the drawer", () => {
    expect(accountForExpense(expense())).toBe("cash");
  });

  it("respects a recorded account", () => {
    expect(accountForExpense(expense({ account: "deposit" }))).toBe("deposit");
  });
});

describe("computeCashbox — the two pots", () => {
  it("sorts each payment into its own pot", () => {
    const s = run({
      payments: [
        payment({ id: "a", methodId: "nur", amountTiyn: T(195200) }),
        payment({ id: "b", methodId: "cash", amountTiyn: T(18800) }),
        payment({ id: "c", methodId: "kaspi", amountTiyn: T(42480) }),
      ],
    });
    expect(of(s, "deposit").inTiyn).toBe(T(237680));
    expect(of(s, "cash").inTiyn).toBe(T(18800));
    expect(s.totalInTiyn).toBe(T(256480));
  });

  it("splits the deposit's takings by method, biggest first", () => {
    const s = run({
      payments: [
        payment({ id: "a", methodId: "kaspi", amountTiyn: T(42480) }),
        payment({ id: "b", methodId: "nur", amountTiyn: T(195200) }),
        payment({ id: "c", methodId: "nur", amountTiyn: T(4800) }),
      ],
    });
    expect(of(s, "deposit").byMethod).toEqual([
      { methodId: "nur", methodName: "Нұр", amountTiyn: T(200000) },
      { methodId: "kaspi", methodName: "Kaspi", amountTiyn: T(42480) },
    ]);
  });

  it("takes each expense out of the pot it was paid from", () => {
    const s = run({
      payments: [payment({ methodId: "nur", amountTiyn: T(200000) })],
      expenses: [
        expense({ id: "e1", name: "Мусор", amountTiyn: T(15000), account: "cash" }),
        expense({ id: "e2", name: "Лист алуға", amountTiyn: T(20000), account: "deposit" }),
      ],
    });
    expect(of(s, "deposit").outTiyn).toBe(T(20000));
    expect(of(s, "deposit").balanceTiyn).toBe(T(180000));
    expect(of(s, "cash").outTiyn).toBe(T(15000));
    // Spending the drawer past what came into it that month is real, and is shown as it is.
    expect(of(s, "cash").balanceTiyn).toBe(T(-15000));
    expect(s.totalOutTiyn).toBe(T(35000));
    expect(s.totalBalanceTiyn).toBe(T(165000));
  });

  it("never counts a reversed payment — the money went back", () => {
    const s = run({
      payments: [
        payment({ id: "a", methodId: "nur", amountTiyn: T(100000) }),
        payment({ id: "b", methodId: "nur", amountTiyn: T(50000), reversed: true }),
      ],
    });
    expect(of(s, "deposit").inTiyn).toBe(T(100000));
    expect(of(s, "deposit").byMethod).toHaveLength(1);
  });

  it("dates money by when it arrived, not by the order it settles", () => {
    const s = run({
      payments: [
        payment({ id: "a", amountTiyn: T(100000), paymentDate: AUG }),
        payment({ id: "b", amountTiyn: T(70000), paymentDate: JUL }),
      ],
      expenses: [
        expense({ id: "e1", amountTiyn: T(9000), date: "2026-08-02" }),
        expense({ id: "e2", amountTiyn: T(4000), date: "2026-07-28" }),
      ],
    });
    expect(s.totalInTiyn).toBe(T(100000));
    expect(s.totalOutTiyn).toBe(T(9000));
  });

  it("adds every month up when the period is all time", () => {
    const s = run({
      period: null,
      payments: [
        payment({ id: "a", amountTiyn: T(100000), paymentDate: AUG }),
        payment({ id: "b", amountTiyn: T(70000), paymentDate: JUL }),
      ],
    });
    expect(s.totalInTiyn).toBe(T(170000));
  });

  it("folds an opening balance into the deposit's all-time Қалдық", () => {
    const s = run({
      period: null,
      payments: [payment({ methodId: "nur", amountTiyn: T(50000) })],
      openingBalanceTiyn: { deposit: T(3421427) },
    });
    expect(of(s, "deposit").balanceTiyn).toBe(T(3471427));
    expect(s.totalBalanceTiyn).toBe(T(3471427));
  });

  it("never applies the opening balance to a specific month's Қалдық", () => {
    const s = run({
      period: "2026-08",
      payments: [payment({ methodId: "nur", amountTiyn: T(50000) })],
      openingBalanceTiyn: { deposit: T(3421427) },
    });
    expect(of(s, "deposit").balanceTiyn).toBe(T(50000));
  });

  it("always reports every pot, even in a month nothing happened", () => {
    const s = run({});
    // One per place the shop actually keeps money: Нұр and Kaspi/Pay are separate accounts with
    // separate statements, and folding them into a single "Депозит" is what stopped the page ever
    // matching the bank. "deposit" is Нұр — the id predates the split — and "Kaspi" and "Pay" are
    // two names for the one account, so they share a pot.
    expect(s.accounts.map((a) => a.account)).toEqual(["deposit", "pay", "cash"]);
    expect(s.accounts.every((a) => a.inTiyn === 0 && a.outTiyn === 0)).toBe(true);
    expect(CASH_ACCOUNT_LABELS.deposit).toBe("Нұр");
  });
});

describe("computeCashbox — есеп басталатын күн (accounting restart)", () => {
  const EARLY = Timestamp.fromDate(new Date("2026-08-10T12:00:00+05:00"));
  const ON_DAY = Timestamp.fromDate(new Date("2026-08-18T12:00:00+05:00"));
  const LATER = Timestamp.fromDate(new Date("2026-08-25T12:00:00+05:00"));

  it("ignores money that moved before the start date", () => {
    const s = run({
      payments: [payment({ id: "a", amountTiyn: T(500000), paymentDate: EARLY })],
      startDate: "2026-08-18",
    });
    expect(of(s, "deposit").inTiyn).toBe(0);
  });

  it("counts the start date itself — the restart day is in, not out", () => {
    const s = run({
      payments: [payment({ id: "a", amountTiyn: T(300000), paymentDate: ON_DAY })],
      startDate: "2026-08-18",
    });
    expect(of(s, "deposit").inTiyn).toBe(T(300000));
  });

  it("ignores expenses dated before the start date", () => {
    const s = run({
      expenses: [
        expense({ id: "old", amountTiyn: T(400000), date: "2026-08-01" }),
        expense({ id: "new", amountTiyn: T(50000), date: "2026-08-20" }),
      ],
      startDate: "2026-08-18",
    });
    expect(of(s, "cash").outTiyn).toBe(T(50000));
    expect(of(s, "cash").expenseCount).toBe(1);
  });

  it("all-time balance = opening balance on that day + only what moved since", () => {
    // The shop's actual restart: a known deposit balance on the day, older flow left behind.
    const s = run({
      period: null,
      startDate: "2026-08-18",
      openingBalanceTiyn: { deposit: T(1467781) },
      payments: [
        payment({ id: "old", amountTiyn: T(4545520), paymentDate: EARLY }),
        payment({ id: "new", amountTiyn: T(3335080), paymentDate: LATER }),
      ],
      expenses: [expense({ id: "old", amountTiyn: T(4426359), date: "2026-08-01" })],
    });
    expect(of(s, "deposit").inTiyn).toBe(T(3335080));
    expect(of(s, "cash").outTiyn).toBe(0);
    expect(of(s, "deposit").balanceTiyn).toBe(T(1467781 + 3335080));
  });

  it("counts everything when no start date is set, exactly as before", () => {
    const s = run({
      payments: [payment({ id: "a", amountTiyn: T(500000), paymentDate: EARLY })],
    });
    expect(of(s, "deposit").inTiyn).toBe(T(500000));
  });

  it("keeps the Шығындар list in step with the totals above it", () => {
    const rows = expensesInPeriod(
      [expense({ id: "old", date: "2026-08-01" }), expense({ id: "new", date: "2026-08-20" })],
      "2026-08",
      "2026-08-18",
    );
    expect(rows.map((r) => r.id)).toEqual(["new"]);
  });
});

describe("the expense log", () => {
  const list = [
    expense({ id: "b", name: "Мусор", amountTiyn: T(15000), date: "2026-08-10" }),
    expense({ id: "a", name: "Лист алуға", amountTiyn: T(20000), date: "2026-08-10" }),
    expense({ id: "c", name: "Жөндеу", amountTiyn: T(5000), date: "2026-08-20" }),
    expense({ id: "d", name: "мусор", amountTiyn: T(7000), date: "2026-07-30" }),
  ];

  it("shows one month, newest first, with a stable order inside a day", () => {
    const rows = expensesInPeriod(list, "2026-08");
    expect(rows.map((e) => e.id)).toEqual(["c", "a", "b"]);
  });

  it("groups repeats by name, case and spacing aside, biggest first", () => {
    const groups = groupExpensesByName(expensesInPeriod(list, null));
    expect(groups[0]).toEqual({ name: "Мусор", amountTiyn: T(22000), count: 2 });
    expect(groups[1]).toEqual({ name: "Лист алуға", amountTiyn: T(20000), count: 1 });
  });
});
