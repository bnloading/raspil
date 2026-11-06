import { describe, it, expect } from "vitest";
import type { Timestamp } from "firebase/firestore";
import type { InventoryMovement, Material } from "../types/domain";
import { DEFAULT_RECEIPT_COMMENT, receiptsByDay, sheetsReceivedByPeriod, stockReceipts } from "./stockReceipts";

const at = (iso: string) => ({ seconds: Math.floor(Date.parse(iso) / 1000), nanoseconds: 0 }) as unknown as Timestamp;
const materials = [
  { id: "kash", name: "ЛДСП Кашемир" },
  { id: "tomsk", name: "ЛДСП Ақ Томск" },
] as Material[];
let seq = 0;
const mv = (over: Partial<InventoryMovement>): InventoryMovement => ({
  id: `m${++seq}`, materialId: "kash", type: "receipt", qty: 38, userId: "e", userName: "Ербол",
  comment: DEFAULT_RECEIPT_COMMENT, balanceBefore: 12, balanceAfter: 50, createdAt: at("2026-11-06T11:11:00+05:00"),
  ...over,
});

describe("stockReceipts — what came onto the rack, and how", () => {
  it("lists receipts newest first with who took them and the stock before and after", () => {
    const list = stockReceipts([
      mv({ id: "a", createdAt: at("2026-11-03T16:30:00+05:00"), balanceBefore: 6, balanceAfter: 44 }),
      mv({ id: "b" }),
    ], materials);
    expect(list.map((r) => [r.id, r.materialName, r.qty, r.userName, r.day, r.balanceBefore, r.balanceAfter]))
      .toEqual([["b", "ЛДСП Кашемир", 38, "Ербол", "2026-11-06", 12, 50], ["a", "ЛДСП Кашемир", 38, "Ербол", "2026-11-03", 6, 44]]);
  });

  it("keeps what was written about a delivery, and drops the default line", () => {
    const [own, plain] = stockReceipts([
      mv({ id: "own", comment: "Эггер, накладная 512", createdAt: at("2026-11-06T12:00:00+05:00") }),
      mv({ id: "plain" }),
    ], materials);
    expect(own.note).toBe("Эггер, накладная 512");
    expect(plain.note).toBe("");
  });

  it("leaves out cuts, corrections, the other line's materials and a receipt not yet on the server", () => {
    const list = stockReceipts([
      mv({ type: "cutting_consumption", qty: -3 }),
      mv({ type: "manual_correction", qty: 5 }),
      mv({ materialId: "mdf-bizden" }),
      mv({ createdAt: undefined }),
    ], materials);
    expect(list).toEqual([]);
  });

  it("adds each Almaty day up, newest day first — an evening receipt stays on its own day", () => {
    const days = receiptsByDay(stockReceipts([
      mv({ materialId: "tomsk", qty: 40, createdAt: at("2026-11-02T11:48:00+05:00") }),
      mv({ materialId: "tomsk", qty: 40, createdAt: at("2026-11-02T23:30:00+05:00") }),
      mv({ qty: 38, createdAt: at("2026-11-03T00:10:00+05:00") }),
    ], materials));
    expect(days.map((d) => [d.day, d.qty, d.receipts.length])).toEqual([["2026-11-03", 38, 1], ["2026-11-02", 80, 2]]);
  });

  it("counts this week from Monday and this month from the 1st", () => {
    const now = new Date("2026-11-06T15:00:00+05:00"); // a Friday
    const list = stockReceipts([
      mv({ qty: 38, createdAt: at("2026-11-06T11:00:00+05:00") }),
      mv({ qty: 40, createdAt: at("2026-11-02T09:00:00+05:00") }), // Monday
      mv({ qty: 4, createdAt: at("2026-11-01T09:00:00+05:00") }), // Sunday before
      mv({ qty: 124, createdAt: at("2026-10-23T09:00:00+05:00") }),
    ], materials);
    expect(sheetsReceivedByPeriod(list, now)).toEqual({ week: 78, month: 82 });
  });
});
