import { describe, it, expect } from "vitest";
import type { Timestamp } from "firebase/firestore";
import type { CashReceipt, Order, Payment, PaymentMethodDef } from "../types/domain";
import { checkCashReceipts, isObnal, journalCash, nameKey, nearbyCash, sameCustomer, type JournalCash } from "./cashReceipts";
import { cashReceiptErrorText } from "./cashReceiptsWrite";

const at = (iso: string) => ({ seconds: Math.floor(new Date(iso).getTime() / 1000), nanoseconds: 0 }) as unknown as Timestamp;
const T = (tenge: number) => tenge * 100;

const methods: PaymentMethodDef[] = [
  { id: "cash", name: "Нал / Қолма-қол", active: true, isMixed: false, account: "cash" },
  { id: "nur", name: "Нұр", active: true, isMixed: false, department: "ldsp" },
];
const order = (id: string, num: number, customerName: string, customerPhone = "") =>
  ({ id, orderNumber: `ORD-2026-${String(num).padStart(6, "0")}`, customerName, customerPhone }) as Order;
const payment = (over: Partial<Payment>): Payment => ({
  id: "p", orderId: "o558", amountTiyn: T(50000), methodId: "cash", methodName: "Нал / Қолма-қол",
  paymentDate: at("2026-11-03T10:00:00+05:00"), recordedByUid: "m", recordedByName: "Бақыт", reversed: false,
  ...over,
});
let seq = 0;
const receipt = (over: Partial<CashReceipt>): CashReceipt => ({
  id: `r${++seq}`, customerName: "Мейрам", amountTiyn: T(50000), date: "2026-11-03", department: "ldsp",
  createdByUid: "erbol", createdByName: "Ербол", createdAt: at("2026-11-03T18:00:00+05:00"),
  ...over,
});
const cash = (over: Partial<JournalCash>): JournalCash => ({
  paymentId: `p${++seq}`, orderId: "o558", orderNumber: "ORD-2026-000558", customerName: "Мейрам", customerPhone: "",
  amountTiyn: T(50000), day: "2026-11-03", atMs: Date.parse("2026-11-03T10:00:00+05:00"), byName: "Бақыт", note: "",
  ...over,
});

const orders = [order("o558", 558, "Мейрам"), order("o560", 560, "Дархан", "+7 701 111 22 33")];

describe("journalCash — the journal's cash, as the check reads it", () => {
  it("takes a live cash payment with its order's number, customer and Almaty day", () => {
    const [j] = journalCash({ payments: [payment({ id: "p1", comment: "Ерболға берілді" })], orders, methods });
    expect(j).toMatchObject({ paymentId: "p1", orderNumber: "ORD-2026-000558", customerName: "Мейрам", day: "2026-11-03", note: "Ерболға берілді" });
  });

  it("leaves out transfers, reversed payments and the other line's orders", () => {
    expect(journalCash({
      payments: [
        payment({ id: "a", methodId: "nur", methodName: "Нұр" }),
        payment({ id: "b", reversed: true }),
        payment({ id: "c", orderId: "mdf-order" }),
      ],
      orders, methods,
    })).toEqual([]);
  });
});

describe("matching an entry to the journal by the customer", () => {
  it("folds case, spacing and the Kazakh letters, so «Нұрик» and «нурик » are one name", () => {
    expect(nameKey("  Нұрик ")).toBe(nameKey("нурик"));
    expect(nameKey("Айбек,  Соната")).toBe("айбек соната");
    expect(sameCustomer({ customerName: "Қанат" }, { customerName: "канат" })).toBe(true);
    expect(sameCustomer({ customerName: "Айбек" }, { customerName: "Айбек Соната" })).toBe(false);
  });

  it("takes the same phone as the same customer even when the name was spelled otherwise", () => {
    expect(sameCustomer({ customerName: "Дәке", customerPhone: "87011112233" }, { customerName: "Дархан", customerPhone: "+7 701 111 22 33" })).toBe(true);
  });

  it("looks a month back and a day ahead, never at cash another entry already took", () => {
    const old = cash({ day: "2026-09-20" }), late = cash({ day: "2026-11-05" }), near = cash({ day: "2026-11-01" }), taken = cash({ day: "2026-11-02" });
    expect(nearbyCash(receipt({}), [old, late, near, taken], new Set([taken.paymentId]))).toEqual([near]);
  });
});

describe("checkCashReceipts", () => {
  it("reads an entry with the journal's cash for that customer and sum as «сәйкес»", () => {
    const j = cash({});
    const { checks, unclaimed } = checkCashReceipts([receipt({})], [j, cash({ customerName: "Дархан", day: "2026-11-04" })]);
    expect(checks[0]).toMatchObject({ status: "ok", payments: [j], journalTiyn: T(50000) });
    expect(unclaimed.map((u) => u.customerName)).toEqual(["Дархан"]);
  });

  it("matches two payments taken together — the customer paid twice, he took both at once", () => {
    const a = cash({ amountTiyn: T(30000), day: "2026-11-01" }), b = cash({ amountTiyn: T(20000), day: "2026-11-02" }), c = cash({ amountTiyn: T(7000), day: "2026-11-02" });
    const { checks } = checkCashReceipts([receipt({})], [a, b, c]);
    expect(checks[0].status).toBe("ok");
    expect(checks[0].payments.map((p) => p.paymentId).sort()).toEqual([a.paymentId, b.paymentId].sort());
  });

  it("says «басқа сома» when the journal has that customer's cash for another sum", () => {
    const j = cash({ amountTiyn: T(45000) });
    const { checks, unclaimed } = checkCashReceipts([receipt({})], [j]);
    expect(checks[0]).toMatchObject({ status: "diff", journalTiyn: T(45000), payments: [j] });
    // Shown beside the entry, so not counted again as unclaimed.
    expect(unclaimed).toEqual([]);
  });

  it("says «журналда жоқ» when the journal has no cash from that customer", () => {
    expect(checkCashReceipts([receipt({ customerName: "Бейтаныс" })], [cash({})]).checks[0].status).toBe("none");
  });

  it("uses one payment once: two hand-overs of the same sum need two payments of it", () => {
    const j = cash({});
    const { checks } = checkCashReceipts(
      [receipt({ date: "2026-11-03" }), receipt({ date: "2026-11-04", createdAt: at("2026-11-04T18:00:00+05:00") })],
      [j],
    );
    // Newest first: the second hand-over found nothing left.
    expect(checks.map((c) => [c.receipt.date, c.status])).toEqual([["2026-11-04", "none"], ["2026-11-03", "ok"]]);
  });

  it("prefers the payment nearest before the hand-over among equal sums", () => {
    const early = cash({ day: "2026-10-20" }), close = cash({ day: "2026-11-02" });
    expect(checkCashReceipts([receipt({})], [early, close]).checks[0].payments).toEqual([close]);
  });

  it("never checks «обнал» against the journal, and leaves the journal's cash to the customer's own entry", () => {
    // Same name and sum as a customer's payment — still not taken: обнал is no customer's cash.
    const j = cash({});
    const obnal = receipt({ kind: "obnal", customerName: "Мейрам", date: "2026-11-03" });
    const own = receipt({ date: "2026-11-04", createdAt: at("2026-11-04T18:00:00+05:00") });
    const { checks, unclaimed } = checkCashReceipts([obnal, own], [j]);
    expect(checks.map((c) => [c.receipt.id, c.status])).toEqual([[own.id, "ok"], [obnal.id, "obnal"]]);
    expect(checks[1]).toMatchObject({ payments: [], journalTiyn: 0 });
    expect(unclaimed).toEqual([]);
    expect(isObnal(obnal)).toBe(true);
    expect(isObnal(own)).toBe(false);
  });

  it("an «обнал» entry with no name is still listed, and its day still starts the unclaimed list", () => {
    const after = cash({ customerName: "Дархан", day: "2026-11-04" });
    const { checks, unclaimed } = checkCashReceipts([receipt({ kind: "obnal", customerName: "" })], [after]);
    expect(checks[0].status).toBe("obnal");
    expect(unclaimed).toEqual([after]);
  });

  it("lists as unclaimed only the journal's cash from the first entry's day on", () => {
    const before = cash({ customerName: "Дархан", day: "2026-11-01" }), after = cash({ customerName: "Дархан", day: "2026-11-04" });
    expect(checkCashReceipts([receipt({})], [cash({}), before, after]).unclaimed).toEqual([after]);
    expect(checkCashReceipts([], [before, after]).unclaimed).toEqual([]);
  });
});

describe("cashReceiptErrorText", () => {
  it("says in words that the rules are not deployed when Firestore refuses", () => {
    expect(cashReceiptErrorText({ code: "permission-denied", message: "Missing or insufficient permissions." }))
      .toMatch(/Firestore ережелері әлі жаңартылмаған/);
    expect(cashReceiptErrorText(new Error("network down"))).toBe("network down");
  });
});
