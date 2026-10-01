import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import { paymentNote, planOverpaymentTrim } from "./payments";

describe("paymentNote — what a person wrote on the cash, not the app's own tag", () => {
  it("returns what was typed", () => {
    expect(paymentNote({ comment: "  Ерболға берілді " })).toBe("Ерболға берілді");
  });

  it("hides the app's provenance tags and empty comments", () => {
    expect(paymentNote({ comment: "Журнал арқылы" })).toBeNull();
    expect(paymentNote({ comment: "Журналда түзетілді" })).toBeNull();
    expect(paymentNote({ comment: "" })).toBeNull();
    expect(paymentNote({})).toBeNull();
  });
});

const T = (n: number) => n * 100; // ₸ → tiyn
const pay = (id: string, amount: number, when: string) => ({
  id,
  amountTiyn: T(amount),
  paymentDate: Timestamp.fromDate(new Date(when)),
});

describe("planOverpaymentTrim — the excess comes off, every tenge left keeps its day and method", () => {
  it("brings the newest payment down rather than writing a new one today", () => {
    // ORD-2026-000150: 100 000 Нұр on 19.09 and 50 000 cash on 21.09 against 148 400.
    const plan = planOverpaymentTrim([pay("nur", 100_000, "2026-09-19T11:27:58Z"), pay("cash", 50_000, "2026-09-21T07:20:24Z")], T(1_600));
    expect(plan).toEqual({ reverse: [], correct: { paymentId: "cash", amountTiyn: T(48_400) } });
  });

  it("reverses a payment the excess covers whole and takes the rest off the one before it", () => {
    // ORD-2026-000224: the same 221 400 recorded twice on 26.09 against 213 400.
    const plan = planOverpaymentTrim([pay("first", 221_400, "2026-09-26T04:54:00Z"), pay("second", 221_400, "2026-09-26T04:55:00Z")], T(229_400));
    expect(plan).toEqual({ reverse: ["second"], correct: { paymentId: "first", amountTiyn: T(213_400) } });
  });

  it("goes by payment date, not by the order the payments arrive in", () => {
    // ORD-2026-000077: 111 640 at 12:04:12 and 40 000 at 12:04:39 against 110 540.
    const plan = planOverpaymentTrim([pay("later", 40_000, "2026-09-10T07:04:39Z"), pay("earlier", 111_640, "2026-09-10T07:04:12Z")], T(41_100));
    expect(plan).toEqual({ reverse: ["later"], correct: { paymentId: "earlier", amountTiyn: T(110_540) } });
  });

  it("reverses without a correction when the excess is exactly a payment", () => {
    const plan = planOverpaymentTrim([pay("a", 30_000, "2026-09-24T05:00:00Z"), pay("b", 30_000, "2026-09-24T06:00:00Z")], T(30_000));
    expect(plan).toEqual({ reverse: ["b"], correct: null });
  });
});
