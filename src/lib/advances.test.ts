import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import { advancesFor, totalAdvancesTiyn, summariseAdvances, isLive } from "./advances";
import type { SalaryAdvance } from "../types/domain";

const T = (n: number) => n * 100;
const at = (sec: number) => Timestamp.fromMillis(sec * 1000);

const adv = (overrides: Partial<SalaryAdvance> = {}): SalaryAdvance => ({
  id: "a1",
  userId: "u1",
  userName: "Ержан",
  periodKey: "2026-08",
  amountTiyn: T(50000),
  paidAt: at(1000),
  recordedByUid: "m1",
  recordedByName: "Нур",
  ...overrides,
});

describe("advancesFor", () => {
  it("keeps only this worker and this month", () => {
    const all = [
      adv({ id: "a" }),
      adv({ id: "b", userId: "u2" }),
      adv({ id: "c", periodKey: "2026-07" }),
    ];
    expect(advancesFor(all, "u1", "2026-08").map((a) => a.id)).toEqual(["a"]);
  });

  it("excludes reversed advances", () => {
    const all = [adv({ id: "a" }), adv({ id: "b", reversed: true })];
    expect(advancesFor(all, "u1", "2026-08").map((a) => a.id)).toEqual(["a"]);
  });

  it("returns newest first", () => {
    const all = [adv({ id: "old", paidAt: at(100) }), adv({ id: "new", paidAt: at(900) })];
    expect(advancesFor(all, "u1", "2026-08").map((a) => a.id)).toEqual(["new", "old"]);
  });
});

describe("totalAdvancesTiyn", () => {
  it("sums live advances", () => {
    expect(totalAdvancesTiyn([adv({ amountTiyn: T(30000) }), adv({ amountTiyn: T(20000) })])).toBe(T(50000));
  });

  it("ignores a reversed one", () => {
    expect(totalAdvancesTiyn([adv({ amountTiyn: T(30000) }), adv({ amountTiyn: T(20000), reversed: true })]))
      .toBe(T(30000));
  });

  it("never counts a negative amount", () => {
    expect(totalAdvancesTiyn([adv({ amountTiyn: -T(5000) })])).toBe(0);
  });

  it("is zero for an empty list", () => {
    expect(totalAdvancesTiyn([])).toBe(0);
  });
});

describe("summariseAdvances", () => {
  const earned = T(350000); // the fixed PVC monthly salary

  it("subtracts advances from what is still owed", () => {
    const s = summariseAdvances({
      advances: [adv({ amountTiyn: T(200000) })],
      userId: "u1", periodKey: "2026-08", earnedTiyn: earned,
    });
    expect(s.totalTiyn).toBe(T(200000));
    expect(s.remainingTiyn).toBe(T(150000));
    expect(s.overdrawn).toBe(false);
  });

  it("leaves the earned figure alone — an advance is not a pay cut", () => {
    // The caller passes earnedTiyn in and gets it back untouched; only `remaining` moves.
    const s = summariseAdvances({
      advances: [adv({ amountTiyn: T(200000) })],
      userId: "u1", periodKey: "2026-08", earnedTiyn: earned,
    });
    expect(s.remainingTiyn + s.totalTiyn).toBe(earned);
  });

  it("floors at zero and flags an overdraw rather than showing a negative payslip", () => {
    const s = summariseAdvances({
      advances: [adv({ amountTiyn: T(400000) })],
      userId: "u1", periodKey: "2026-08", earnedTiyn: earned,
    });
    expect(s.remainingTiyn).toBe(0);
    expect(s.overdrawn).toBe(true);
  });

  it("is not overdrawn when the advance exactly equals the pay", () => {
    const s = summariseAdvances({
      advances: [adv({ amountTiyn: earned })],
      userId: "u1", periodKey: "2026-08", earnedTiyn: earned,
    });
    expect(s.remainingTiyn).toBe(0);
    expect(s.overdrawn).toBe(false);
  });

  it("returns the whole salary when nothing was drawn", () => {
    const s = summariseAdvances({ advances: [], userId: "u1", periodKey: "2026-08", earnedTiyn: earned });
    expect(s.totalTiyn).toBe(0);
    expect(s.remainingTiyn).toBe(earned);
    expect(s.entries).toEqual([]);
  });

  it("ignores another worker's advances entirely", () => {
    const s = summariseAdvances({
      advances: [adv({ userId: "someone-else", amountTiyn: T(300000) })],
      userId: "u1", periodKey: "2026-08", earnedTiyn: earned,
    });
    expect(s.remainingTiyn).toBe(earned);
  });
});

describe("isLive", () => {
  it("treats a reversal as not a payment", () => {
    expect(isLive(adv())).toBe(true);
    expect(isLive(adv({ reversed: true }))).toBe(false);
  });
});
