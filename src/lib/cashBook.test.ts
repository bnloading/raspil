import { describe, it, expect } from "vitest";
import type { Timestamp } from "firebase/firestore";
import type { Expense, Order, Payment, PaymentMethodDef } from "../types/domain";
import { cashBookDays, cashBookEntries } from "./cashBook";

const at = (iso: string) => ({ seconds: Math.floor(new Date(iso).getTime() / 1000), nanoseconds: 0 }) as unknown as Timestamp;
const T = (tenge: number) => tenge * 100;

const methods: PaymentMethodDef[] = [
  { id: "cash", name: "Нал / Қолма-қол", active: true, isMixed: false, account: "cash" },
  { id: "akhzhol", name: "Ахжол", active: true, isMixed: false, department: "mdf" },
];
const order = (id: string, num: number, customerName: string) =>
  ({ id, orderNumber: `ORD-2026-${String(num).padStart(6, "0")}`, customerName }) as Order;
const payment = (over: Partial<Payment>): Payment => ({
  id: "p", orderId: "o558", amountTiyn: T(1000), methodId: "cash", methodName: "Нал / Қолма-қол",
  paymentDate: at("2026-10-27T10:00:00+05:00"), recordedByUid: "u", recordedByName: "Ахжол", reversed: false,
  ...over,
});
const expense = (over: Partial<Expense>): Expense => ({
  id: "e", name: "Пленка", amountTiyn: T(500), date: "2026-10-27", createdByUid: "u", createdByName: "Ахжол", department: "mdf",
  ...over,
});

const orders = [order("o558", 558, "Мейрам"), order("o560", 560, "Дархан")];

describe("cashBookEntries — the МДФ line's «Қолма-қол»", () => {
  it("lists the cash taken on an order, named by its number and customer", () => {
    const [entry] = cashBookEntries({ payments: [payment({ comment: "Ербақытқа берілді" })], expenses: [], orders, methods });
    expect(entry).toMatchObject({ kind: "in", title: "№558 · Мейрам", amountTiyn: T(1000), note: "Ербақытқа берілді", day: "2026-10-27" });
  });

  it("leaves out a transfer — Ахжол's account is not the drawer", () => {
    expect(cashBookEntries({ payments: [payment({ methodId: "akhzhol", methodName: "Ахжол" })], expenses: [], orders, methods })).toEqual([]);
  });

  it("leaves out the other line's money: a payment on an order it was not given", () => {
    expect(cashBookEntries({ payments: [payment({ orderId: "ldsp-order" })], expenses: [], orders, methods })).toEqual([]);
  });

  it("leaves out reversed money", () => {
    expect(cashBookEntries({ payments: [payment({ reversed: true })], expenses: [], orders, methods })).toEqual([]);
  });

  it("does not show the app's own tag as if someone had written it", () => {
    const [entry] = cashBookEntries({ payments: [payment({ comment: "Қолма-қол беті арқылы" })], expenses: [], orders, methods });
    expect(entry.note).toBe("");
  });

  it("counts an expense paid out of the drawer, and not one paid from an account", () => {
    const entries = cashBookEntries({
      payments: [],
      expenses: [expense({ id: "cash-out" }), expense({ id: "card-out", account: "deposit" })],
      orders,
      methods,
    });
    expect(entries.map((e) => e.id)).toEqual(["cash-out"]);
    expect(entries[0].kind).toBe("out");
  });

  it("runs newest first, a day's expenses after its takings", () => {
    const entries = cashBookEntries({
      payments: [
        payment({ id: "morning", paymentDate: at("2026-10-27T09:00:00+05:00") }),
        payment({ id: "evening", paymentDate: at("2026-10-27T18:00:00+05:00") }),
        payment({ id: "yesterday", paymentDate: at("2026-10-26T12:00:00+05:00") }),
      ],
      expenses: [expense({ id: "spent" })],
      orders,
      methods,
    });
    expect(entries.map((e) => e.id)).toEqual(["evening", "morning", "spent", "yesterday"]);
  });
});

describe("cashBookEntries — money in with no order behind it", () => {
  it("lists cash from outside the journal with what it was, and leaves out what went to an account", () => {
    const entries = cashBookEntries({
      payments: [], expenses: [], orders, methods,
      other: [
        { id: "out-1", kind: "outside", payerName: "Сырттан кірген ақша", amountTiyn: T(50000), methodId: "cash", methodName: "Нал",
          date: "2026-10-30", comment: "Ербақыт берді", createdByUid: "u", createdByName: "Ахжол" },
        { id: "out-2", kind: "outside", payerName: "Сырттан кірген ақша", amountTiyn: T(9000), methodId: "akhzhol", methodName: "Ахжол",
          date: "2026-10-30", comment: "аударым", createdByUid: "u", createdByName: "Ахжол" },
      ],
    });
    expect(entries).toEqual([
      expect.objectContaining({ id: "out-1", kind: "in", title: "Сырттан кірген ақша", note: "Ербақыт берді", amountTiyn: T(50000) }),
    ]);
  });
});

describe("cashBookDays", () => {
  it("folds the book into days with what came in and went out on each", () => {
    const entries = cashBookEntries({
      payments: [
        payment({ id: "a", amountTiyn: T(220110) }),
        payment({ id: "b", orderId: "o560", amountTiyn: T(50000), paymentDate: at("2026-10-26T12:00:00+05:00") }),
      ],
      expenses: [expense({ amountTiyn: T(15000) })],
      orders,
      methods,
    });
    expect(cashBookDays(entries).map(({ day, inTiyn, outTiyn, entries: e }) => ({ day, inTiyn, outTiyn, count: e.length }))).toEqual([
      { day: "2026-10-27", inTiyn: T(220110), outTiyn: T(15000), count: 2 },
      { day: "2026-10-26", inTiyn: T(50000), outTiyn: 0, count: 1 },
    ]);
  });
});
