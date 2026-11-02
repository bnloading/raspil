import { describe, it, expect } from "vitest";
import type { Timestamp } from "firebase/firestore";
import type { SalaryAdvance } from "../types/domain";
import { carriedIntoPeriod, summariseAdvancesWithCarry } from "./advanceCarry";

const T = (n: number) => n * 100;
const WORKER = "sundet";
let seq = 0;
const advance = (periodKey: string, tenge: number, over: Partial<SalaryAdvance> = {}): SalaryAdvance => ({
  id: `a${++seq}`,
  userId: WORKER,
  userName: "Сүндет",
  periodKey,
  amountTiyn: T(tenge),
  paidAt: { seconds: seq, nanoseconds: 0 } as unknown as Timestamp,
  recordedByUid: "owner",
  recordedByName: "Нур",
  reversed: false,
  ...over,
} as SalaryAdvance);
const entry = (periodKey: string, tenge: number) => ({ userId: WORKER, periodKey, finalTiyn: T(tenge) });

describe("advances over a period's pay carry into the next — «350-ден асқанын осы айға»", () => {
  it("closes October at the salary and opens November with the rest", () => {
    // Сүндет: 370 000 ₸ of October advances against a 350 000 ₸ salary.
    const advances = [advance("2026-10", 140000), advance("2026-10", 230000), advance("2026-11", 2000)];
    const entries = [entry("2026-10", 350000)];

    const october = summariseAdvancesWithCarry({ advances, entries, userId: WORKER, periodKey: "2026-10", earnedTiyn: T(350000) });
    expect(october).toMatchObject({ ownTiyn: T(370000), carriedInTiyn: 0, remainingTiyn: 0, carriedOutTiyn: T(20000), overdrawn: true });

    const november = summariseAdvancesWithCarry({ advances, entries, userId: WORKER, periodKey: "2026-11", earnedTiyn: T(350000) });
    expect(november).toMatchObject({ ownTiyn: T(2000), carriedInTiyn: T(20000), totalTiyn: T(22000), remainingTiyn: T(328000), carriedOutTiyn: 0 });
  });

  it("is the owner's own example: 390 taken, 40 carried", () => {
    const advances = [advance("2026-10", 390000)];
    expect(carriedIntoPeriod({ advances, entries: [entry("2026-10", 350000)], userId: WORKER, periodKey: "2026-11" })).toBe(T(40000));
  });

  it("carries nothing when a month stayed within its pay", () => {
    const advances = [advance("2026-10", 300000)];
    expect(carriedIntoPeriod({ advances, entries: [entry("2026-10", 350000)], userId: WORKER, periodKey: "2026-11" })).toBe(0);
  });

  it("keeps carrying through a month that was overdrawn again, and stops once a month absorbs it", () => {
    const advances = [advance("2026-09", 400000), advance("2026-10", 330000), advance("2026-11", 100000)];
    const entries = [entry("2026-09", 350000), entry("2026-10", 350000), entry("2026-11", 350000)];
    // September: 50 000 over → October: 330 000 + 50 000 = 380 000, 30 000 over → November.
    expect(carriedIntoPeriod({ advances, entries, userId: WORKER, periodKey: "2026-11" })).toBe(T(30000));
    // November: 100 000 + 30 000 is within 350 000 — December starts clean.
    expect(carriedIntoPeriod({ advances, entries, userId: WORKER, periodKey: "2026-12" })).toBe(0);
  });

  it("does not count a reversed advance", () => {
    const advances = [advance("2026-10", 350000), advance("2026-10", 40000, { reversed: true })];
    expect(carriedIntoPeriod({ advances, entries: [entry("2026-10", 350000)], userId: WORKER, periodKey: "2026-11" })).toBe(0);
  });

  it("carries nothing from a month whose salary was never worked out", () => {
    // No entry for October: no honest "over" to carry, so an old advance never turns into a debt.
    expect(carriedIntoPeriod({ advances: [advance("2026-10", 500000)], entries: [], userId: WORKER, periodKey: "2026-11" })).toBe(0);
  });

  it("works the same way week by week for распил", () => {
    const cutter = "olzhas";
    const advances = [advance("2026-10-26", 300000, { userId: cutter })];
    const entries = [{ userId: cutter, periodKey: "2026-10-26", finalTiyn: T(250000) }];
    expect(carriedIntoPeriod({ advances, entries, userId: cutter, periodKey: "2026-11-02" })).toBe(T(50000));
  });

  it("keeps each worker's carry to themselves", () => {
    const advances = [advance("2026-10", 390000)];
    expect(carriedIntoPeriod({ advances, entries: [entry("2026-10", 350000)], userId: "someone-else", periodKey: "2026-11" })).toBe(0);
  });
});
