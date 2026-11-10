import { describe, it, expect } from "vitest";
import type { Timestamp } from "firebase/firestore";
import type { CashReceipt, Expense, Order, Payment, PaymentMethodDef } from "../types/domain";
import {
  cashHandOvers, checkCashReceipts, isObnal, journalCash, kassaObnal, nameKey, nearbyCash, nearbyObnal, noteSumTiyn,
  sameCustomer, type JournalCash, type KassaObnal,
} from "./cashReceipts";
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
    const handOvers = cashHandOvers([old, late, near, taken]);
    expect(nearbyCash(receipt({}), handOvers, new Set([taken.paymentId])).map((h) => h.payments)).toEqual([[near]]);
  });
});

describe("checkCashReceipts", () => {
  it("reads an entry with the journal's cash for that customer and sum as «сәйкес»", () => {
    const j = cash({});
    const { checks, unclaimed } = checkCashReceipts([receipt({})], [j, cash({ customerName: "Дархан", day: "2026-11-04" })]);
    expect(checks[0]).toMatchObject({ status: "ok", payments: [j], recordTiyn: T(50000) });
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
    expect(checks[0]).toMatchObject({ status: "diff", recordTiyn: T(45000), payments: [j] });
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
    expect(checks.map((c) => [c.receipt.id, c.status])).toEqual([[own.id, "ok"], [obnal.id, "none"]]);
    expect(checks[1]).toMatchObject({ payments: [], obnal: [], recordTiyn: 0 });
    expect(unclaimed).toEqual([]);
    expect(isObnal(obnal)).toBe(true);
    expect(isObnal(own)).toBe(false);
  });

  it("an «обнал» entry with no name is still listed, and its day still starts the unclaimed list", () => {
    const after = cash({ customerName: "Дархан", day: "2026-11-04" });
    const { checks, unclaimed } = checkCashReceipts([receipt({ kind: "obnal", customerName: "" })], [after]);
    expect(checks[0].status).toBe("none");
    expect(unclaimed.map((h) => h.payments)).toEqual([[after]]);
  });

  it("lists as unclaimed only the journal's cash from the first entry's day on", () => {
    const before = cash({ customerName: "Дархан", day: "2026-11-01" }), after = cash({ customerName: "Дархан", day: "2026-11-04" });
    expect(checkCashReceipts([receipt({})], [cash({}), before, after]).unclaimed.map((h) => h.payments)).toEqual([[after]]);
    expect(checkCashReceipts([], [before, after]).unclaimed).toEqual([]);
  });
});

describe("the sum written after «Нал» in the journal (the owner, 10.11)", () => {
  it("reads the sum a comment starts with, a bare number under 1 000 as thousands", () => {
    expect(noteSumTiyn("600000")).toBe(T(600000));
    expect(noteSumTiyn("600 000")).toBe(T(600000));
    expect(noteSumTiyn("670000 мен бірге")).toBe(T(670000));
    expect(noteSumTiyn("670")).toBe(T(670000));
    expect(noteSumTiyn("72к")).toBe(T(72000));
    expect(noteSumTiyn("50 мың")).toBe(T(50000));
    expect(noteSumTiyn("97120тг")).toBe(T(97120));
    expect(noteSumTiyn("Ерболға берілді")).toBeNull();
    expect(noteSumTiyn("2 лист")).toBeNull();
    expect(noteSumTiyn("")).toBeNull();
  });

  it("takes six orders paid together, «600000» on each, as one hand-over of 600 000", () => {
    // Заказ Цех, 31.10: the orders took 594 500 of it.
    const six = [123000, 41000, 102500, 143500, 102500, 82000].map((t, i) =>
      cash({ customerName: "Заказ Цех", orderNumber: `ORD-2026-00063${i}`, amountTiyn: T(t), day: "2026-10-31", note: "600000" }));
    const [h] = cashHandOvers(six);
    expect(h).toMatchObject({ handedTiyn: T(600000), paidTiyn: T(594500), fromNote: true, note: "600000" });
    expect(h.payments).toHaveLength(6);
    const { checks, unclaimed } = checkCashReceipts(
      [receipt({ customerName: "Заказ Цех", amountTiyn: T(600000), date: "2026-10-31" })], six);
    expect(checks[0]).toMatchObject({ status: "ok", recordTiyn: T(600000) });
    expect(checks[0].payments).toHaveLength(6);
    expect(unclaimed).toEqual([]);
  });

  it("joins «670», «670000» and «670000 мен бірге» on one customer's day into one hand-over", () => {
    // Ринат Алишер, 22.10: nine orders, 670 040 in the journal, 670 000 handed over.
    const rinat = [
      cash({ customerName: "Ринат Алишер", amountTiyn: T(245800), day: "2026-10-22", note: "670000 мен бірге" }),
      cash({ customerName: "Ринат Алишер", amountTiyn: T(424240), day: "2026-10-22", note: "670" }),
    ];
    const ok = checkCashReceipts([receipt({ customerName: "Ринат Алишер", amountTiyn: T(670000), date: "2026-10-22" })], rinat);
    expect(ok.checks[0]).toMatchObject({ status: "ok" });
    expect(ok.checks[0].handOvers[0]).toMatchObject({ handedTiyn: T(670000), paidTiyn: T(670040) });
  });

  it("adds that day's payment with nothing written on it when it is what makes the sum add up", () => {
    // Ринат, 22.10: №248's 23 500 had only the app's tag; 646 540 + 23 500 = 670 040 ≈ «670000».
    const noted = cash({ customerName: "Ринат Алишер", amountTiyn: T(646540), day: "2026-10-22", note: "670000" });
    const n248 = cash({ customerName: "Ринат Алишер", amountTiyn: T(23500), day: "2026-10-22", note: "" });
    const [h] = cashHandOvers([noted, n248]);
    expect(h).toMatchObject({ handedTiyn: T(670000), paidTiyn: T(670040) });
    expect(h.payments).toHaveLength(2);
    // Бахытжан, 29.10: 84 000 with «91500», 7 500 with nothing — exactly 91 500 together.
    const b = cashHandOvers([
      cash({ customerName: "Бахытжан", amountTiyn: T(84000), day: "2026-10-29", note: "91500" }),
      cash({ customerName: "Бахытжан", amountTiyn: T(7500), day: "2026-10-29", note: "" }),
    ]);
    expect(b.map((x) => [x.handedTiyn, x.paidTiyn])).toEqual([[T(91500), T(91500)]]);
    // A payment that does not close the gap stays its own: 45 000 «50000» and 2 000 → still 3 000 short.
    expect(cashHandOvers([cash({ amountTiyn: T(45000), note: "50000" }), cash({ amountTiyn: T(2000), note: "" })])).toHaveLength(2);
  });

  it("checks against the comment, not the payment: 380 700 in the journal, «380000» after «Нал»", () => {
    const j = cash({ customerName: "Алмат", amountTiyn: T(380700), note: "380000" });
    expect(checkCashReceipts([receipt({ customerName: "Алмат", amountTiyn: T(380000) })], [j]).checks[0].status).toBe("ok");
    // The payment's own sum is not what changed hands.
    expect(checkCashReceipts([receipt({ customerName: "Алмат", amountTiyn: T(380700) })], [j]).checks[0])
      .toMatchObject({ status: "diff", recordTiyn: T(380000) });
  });

  it("reads a payment with no sum in its comment by its own sum", () => {
    const j = cash({ note: "Ерболға берілді", amountTiyn: T(45000) });
    expect(cashHandOvers([j])[0]).toMatchObject({ handedTiyn: T(45000), fromNote: false });
    expect(checkCashReceipts([receipt({ amountTiyn: T(45000) })], [j]).checks[0].status).toBe("ok");
  });

  it("keeps two orders of 50 000, «50000» on each, as two hand-overs, not one", () => {
    const a = cash({ note: "50000" }), b = cash({ note: "50000" });
    expect(cashHandOvers([a, b]).map((h) => h.handedTiyn)).toEqual([T(50000), T(50000)]);
    const two = checkCashReceipts([receipt({}), receipt({ createdAt: at("2026-11-03T19:00:00+05:00") })], [a, b]);
    expect(two.checks.map((c) => c.status)).toEqual(["ok", "ok"]);
  });

  it("never joins two customers, or two days, under one sum", () => {
    const a = cash({ customerName: "Мейрам", note: "50000", amountTiyn: T(30000) });
    const b = cash({ customerName: "Дархан", note: "50000", amountTiyn: T(20000) });
    const c = cash({ customerName: "Мейрам", note: "50000", amountTiyn: T(20000), day: "2026-11-04" });
    expect(cashHandOvers([a, b, c])).toHaveLength(3);
  });
});

describe("cashReceiptErrorText", () => {
  it("says in words that the rules are not deployed when Firestore refuses", () => {
    expect(cashReceiptErrorText({ code: "permission-denied", message: "Missing or insufficient permissions." }))
      .toMatch(/Firestore ережелері әлі жаңартылмаған/);
    expect(cashReceiptErrorText(new Error("network down"))).toBe("network down");
  });
});

describe("обнал against Касса's «Обнал» expenses", () => {
  const expense = (over: Partial<Expense>): Expense => ({
    id: `e${++seq}`, name: "Обнал", amountTiyn: T(100000), date: "2026-11-07", account: "deposit", department: "ldsp",
    comment: "", createdByUid: "nur", createdByName: "Нур", ...over,
  });
  const obnalEntry = (over: Partial<CashReceipt>) => receipt({ kind: "obnal", customerName: "", date: "2026-11-07", amountTiyn: T(100000), ...over });

  it("reads Касса's обнал the way Нұр writes it, with who took the transfer", () => {
    const rows = kassaObnal([
      expense({ id: "a", name: "Акжол 100 000", comment: "Обнал" }),
      expense({ id: "b", name: "172000  Обнал", comment: "Акжол" }),
      expense({ id: "c", name: "40000 обнал Динко", comment: "Здачамен 43320\\" }),
      expense({ id: "d", name: "Миллион обнал" }),
      expense({ id: "e", name: "Акжол Болат Обнал" }),
      expense({ id: "f", name: "Мусор" }),
      expense({ id: "g", name: "Аман обнал", department: "mdf" }),
    ], "ldsp");
    expect(rows.map((k) => [k.expenseId, k.who])).toEqual([["a", "Акжол"], ["b", "Акжол"], ["c", "Динко"], ["d", ""], ["e", "Акжол Болат"]]);
    expect(rows[0].label).toBe("Акжол 100 000 · Обнал");
  });

  it("matches the Касса обнал of the same sum, the same hand first, within a week either way", () => {
    const [far, other, akzhol] = kassaObnal([
      expense({ id: "far", name: "Акжол обнал", date: "2026-10-25" }),
      expense({ id: "other", name: "Аман обнал", date: "2026-11-07" }),
      expense({ id: "ak", name: "Акжол обнал", date: "2026-11-05" }),
    ], "ldsp");
    // «Ақжол» on the phone, «Акжол» on Касса — one name.
    const { checks, unclaimedObnal } = checkCashReceipts([obnalEntry({ customerName: "Ақжол" })], [], [far, other, akzhol]);
    expect(checks[0]).toMatchObject({ status: "ok", obnal: [akzhol], recordTiyn: T(100000) });
    expect(unclaimedObnal).toEqual([other]);
    expect(nearbyObnal({ customerName: "", date: "2026-11-07" }, [far, other, akzhol]).map((k) => k.expenseId)).toEqual(["other", "ak"]);
  });

  it("shows another sum only when it is plainly the same обнал, and takes one expense once", () => {
    const [dinko] = kassaObnal([expense({ name: "40000 обнал Динко", amountTiyn: T(43320), date: "2026-10-15" })], "ldsp");
    const named = checkCashReceipts([obnalEntry({ customerName: "Динко", amountTiyn: T(40000), date: "2026-10-12" })], [], [dinko]);
    expect(named.checks[0]).toMatchObject({ status: "diff", obnal: [dinko], recordTiyn: T(43320) });
    expect(named.unclaimedObnal).toEqual([]);
    // No name, three days off, another sum: not this one.
    expect(checkCashReceipts([obnalEntry({ amountTiyn: T(40000), date: "2026-10-12" })], [], [dinko]).checks[0].status).toBe("none");
    // Two hand-overs, one transfer: the second finds nothing left.
    const [k] = kassaObnal([expense({})], "ldsp");
    const two = checkCashReceipts([obnalEntry({}), obnalEntry({ createdAt: at("2026-11-07T19:00:00+05:00") })], [], [k as KassaObnal]);
    expect(two.checks.map((c) => c.status).sort()).toEqual(["none", "ok"]);
  });
});
