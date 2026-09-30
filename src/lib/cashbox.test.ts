import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  accountForExpense,
  accountForMethod,
  computeCashbox,
  expensesInPeriod,
  groupExpensesByName,
  isBeforeRestart,
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

describe("payments on orders from before the accounting restart", () => {
  // The owner's rule: the books closed on the restart, and marking a 07.09 order paid on the 25th
  // must not add to today's deposit. ORD-2026-000043 (created 07.09, 333 360 ₸ by Pay on 25.09)
  // and ORD-2026-000049 (07.09, 6 400 ₸ Нұр on 28.09) are the real cases this was found on.
  const SEP25 = Timestamp.fromDate(new Date("2026-09-25T12:00:00+05:00"));
  const at = (day: string) => Timestamp.fromDate(new Date(`${day}T12:00:00+05:00`));
  const orders = [
    { id: "old", orderNumber: "ORD-2026-000049", createdAt: at("2026-09-07") },
    { id: "new", orderNumber: "ORD-2026-000200", createdAt: at("2026-09-24") },
    { id: "start", orderNumber: "ORD-2026-000150", createdAt: at("2026-09-22") },
  ];
  const summary = computeCashbox({
    payments: [
      payment({ id: "p-old", orderId: "old", amountTiyn: T(6400), paymentDate: SEP25 }),
      payment({ id: "p-new", orderId: "new", amountTiyn: T(100000), paymentDate: SEP25 }),
      payment({ id: "p-start", orderId: "start", amountTiyn: T(5000), paymentDate: SEP25 }),
      payment({ id: "p-unknown", orderId: "not-loaded", amountTiyn: T(700), paymentDate: SEP25 }),
    ],
    expenses: [],
    methods,
    period: null,
    startDate: "2026-09-22",
    orders,
  });

  it("leaves them out of every pot, while an order from the restart day on still counts", () => {
    expect(summary.accounts.find((a) => a.account === "deposit")!.inTiyn).toBe(T(100000 + 5000 + 700));
    expect(summary.totalInTiyn).toBe(T(105700));
  });

  it("lists what it left out, so the money is never simply gone", () => {
    expect(summary.excludedOldOrders).toEqual([{
      paymentId: "p-old", orderNumber: "ORD-2026-000049", orderDay: "2026-09-07", paymentDay: "2026-09-25",
      amountTiyn: T(6400), methodName: "Нұр", account: "deposit",
    }]);
  });

  it("changes nothing when no orders are passed, or there is no restart", () => {
    const noOrders = computeCashbox({ payments: [payment({ orderId: "old", amountTiyn: T(6400), paymentDate: SEP25 })], expenses: [], methods, period: null, startDate: "2026-09-22" });
    expect(noOrders.totalInTiyn).toBe(T(6400));
    const noRestart = computeCashbox({ payments: [payment({ orderId: "old", amountTiyn: T(6400), paymentDate: SEP25 })], expenses: [], methods, period: null, orders });
    expect(noRestart.totalInTiyn).toBe(T(6400));
    expect(noRestart.excludedOldOrders).toEqual([]);
  });
});

describe("a restart drawn at an order — «№281 заказға дейін расчет істелді»", () => {
  // 30.09: the owner settled everything before №281 and set Нұр to 5 339 797 ₸. №280 was written
  // that same morning and was in the settlement, so its day cannot tell it apart from №281.
  const at = (iso: string) => Timestamp.fromDate(new Date(iso));
  const SEP30 = at("2026-09-30T11:00:00+05:00");
  const orders = [
    { id: "o280", orderNumber: "ORD-2026-000280", createdAt: at("2026-09-30T10:33:00+05:00") },
    { id: "o281", orderNumber: "ORD-2026-000281", createdAt: at("2026-09-30T10:49:00+05:00") },
    // Typed up after the settlement but dated back a day — still new business.
    { id: "o282", orderNumber: "ORD-2026-000282", createdAt: at("2026-09-29T12:00:00+05:00") },
  ];
  const s = computeCashbox({
    payments: [
      payment({ id: "p280", orderId: "o280", methodId: "cash", amountTiyn: T(51180), paymentDate: SEP30 }),
      payment({ id: "p281", orderId: "o281", amountTiyn: T(111060), paymentDate: SEP30 }),
      payment({ id: "p282", orderId: "o282", amountTiyn: T(20000), paymentDate: SEP30 }),
    ],
    expenses: [],
    methods,
    period: null,
    openingBalanceTiyn: { deposit: T(5339797) },
    startDate: "2026-09-30",
    startOrderNumber: "ORD-2026-000281",
    orders,
  });

  it("leaves out an order before it even when written on the restart day, and lists it", () => {
    expect(s.accounts.find((a) => a.account === "cash")!.inTiyn).toBe(0);
    expect(s.excludedOldOrders.map((p) => p.orderNumber)).toEqual(["ORD-2026-000280"]);
  });

  it("counts that order and every one after it, whatever day they carry", () => {
    const nur = s.accounts.find((a) => a.account === "deposit")!;
    expect(nur.inTiyn).toBe(T(111060 + 20000));
    expect(nur.balanceTiyn).toBe(T(5339797 + 111060 + 20000));
  });
});

describe("rent the owner takes on the side (Аренда)", () => {
  const OCT2 = Timestamp.fromDate(new Date("2026-10-02T12:00:00+05:00"));

  it("adds to its method's pot as its own line, dated by its day like an expense", () => {
    const s = computeCashbox({
      payments: [payment({ amountTiyn: T(100000), paymentDate: OCT2 })],
      expenses: [],
      methods,
      period: null,
      openingBalanceTiyn: { deposit: T(5228737) },
      startDate: "2026-09-30",
      rent: [
        { amountTiyn: T(150000), methodId: "nur", date: "2026-10-01" },
        { amountTiyn: T(50000), methodId: "cash", date: "2026-10-01" },
        { amountTiyn: T(70000), methodId: "nur", date: "2026-09-29" }, // before the restart
      ],
    });
    const nur = s.accounts.find((a) => a.account === "deposit")!;
    expect(nur.inTiyn).toBe(T(100000));
    expect(nur.rentTiyn).toBe(T(150000));
    expect(nur.balanceTiyn).toBe(T(5228737 + 100000 + 150000));
    expect(s.accounts.find((a) => a.account === "cash")!.rentTiyn).toBe(T(50000));
    expect(s.totalRentTiyn).toBe(T(200000));
    expect(s.totalInTiyn).toBe(T(100000)); // order money stays apart from rent
  });

  it("counts only the chosen month's rent when a month is picked", () => {
    const s = computeCashbox({
      payments: [], expenses: [], methods, period: "2026-10",
      rent: [
        { amountTiyn: T(150000), methodId: "nur", date: "2026-10-01" },
        { amountTiyn: T(150000), methodId: "nur", date: "2026-11-01" },
      ],
    });
    expect(s.totalRentTiyn).toBe(T(150000));
  });
});

describe("isBeforeRestart", () => {
  const at = (day: string) => Timestamp.fromDate(new Date(`${day}T12:00:00+05:00`));

  it("goes by the order's day when the restart names no order", () => {
    expect(isBeforeRestart({ orderNumber: "ORD-2026-000300", createdAt: at("2026-09-21") }, "2026-09-22")).toBe(true);
    expect(isBeforeRestart({ orderNumber: "ORD-2026-000001", createdAt: at("2026-09-22") }, "2026-09-22")).toBe(false);
    expect(isBeforeRestart({ orderNumber: "ORD-2026-000001", createdAt: at("2026-09-21") }, null)).toBe(false);
  });

  it("goes by the number when it does — across a new year too", () => {
    const first = "ORD-2026-000281";
    expect(isBeforeRestart({ orderNumber: "ORD-2026-000280", createdAt: at("2026-09-30") }, "2026-09-30", first)).toBe(true);
    expect(isBeforeRestart({ orderNumber: "ORD-2026-000281", createdAt: at("2026-09-29") }, "2026-09-30", first)).toBe(false);
    expect(isBeforeRestart({ orderNumber: "ORD-2027-000001", createdAt: at("2027-01-02") }, "2026-09-30", first)).toBe(false);
  });
});

describe("the owner's exceptions and corrections", () => {
  const SEP28 = Timestamp.fromDate(new Date("2026-09-28T12:00:00+05:00"));
  const at = (day: string) => Timestamp.fromDate(new Date(`${day}T12:00:00+05:00`));
  const orders = [{ id: "o145", orderNumber: "ORD-2026-000145", createdAt: at("2026-09-18") }];

  it("counts a pre-restart payment the Admin marked as today's money", () => {
    // ORD-2026-000145: an order from 18.09 paid 80 000 ₸ in cash on 28.09, which the owner confirmed
    // was real money taken that day.
    const s = computeCashbox({
      payments: [payment({ orderId: "o145", methodId: "cash", amountTiyn: T(80000), paymentDate: SEP28, countsInCurrentBooks: true })],
      expenses: [], methods, period: null, startDate: "2026-09-22", orders,
    });
    expect(s.accounts.find((a) => a.account === "cash")!.inTiyn).toBe(T(80000));
    expect(s.excludedOldOrders).toEqual([]);
  });

  it("adds a dated correction to its pot's balance, and shows it apart from in and out", () => {
    const adj = { id: "a1", account: "deposit" as const, amountTiyn: T(1385385), date: "2026-09-29", note: "Банкпен теңестіру", byUid: "u", byName: "Нур" };
    const s = computeCashbox({
      payments: [payment({ amountTiyn: T(100000), paymentDate: SEP28 })],
      expenses: [expense({ account: "deposit", amountTiyn: T(30000), date: "2026-09-28" })],
      methods, period: null, openingBalanceTiyn: { deposit: T(4253791) }, startDate: "2026-09-22", adjustments: [adj],
    });
    const nur = s.accounts.find((a) => a.account === "deposit")!;
    expect(nur).toMatchObject({ inTiyn: T(100000), outTiyn: T(30000), adjustTiyn: T(1385385) });
    expect(nur.balanceTiyn).toBe(T(4253791 + 100000 - 30000 + 1385385));
    expect(s.totalAdjustTiyn).toBe(T(1385385));
    expect(s.adjustments).toEqual([adj]);
  });

  it("dates a correction like an expense: not before the restart, and only in its own month", () => {
    const adj = (date: string) => ({ id: date, account: "deposit" as const, amountTiyn: T(1000), date, note: "", byUid: "u", byName: "" });
    const all = computeCashbox({ payments: [], expenses: [], methods, period: null, startDate: "2026-09-22", adjustments: [adj("2026-09-20"), adj("2026-09-29"), adj("2026-10-02")] });
    expect(all.totalAdjustTiyn).toBe(T(2000));
    const sept = computeCashbox({ payments: [], expenses: [], methods, period: "2026-09", startDate: "2026-09-22", adjustments: [adj("2026-09-29"), adj("2026-10-02")] });
    expect(sept.totalAdjustTiyn).toBe(T(1000));
  });
});
