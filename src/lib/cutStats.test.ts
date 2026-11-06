import { describe, it, expect } from "vitest";
import type { Timestamp } from "firebase/firestore";
import type { MaterialCategory, Order, OrderLineJob } from "../types/domain";
import { monthRange, sheetsCutBetween } from "./cutStats";

const at = (iso: string) => ({ seconds: Math.floor(Date.parse(iso) / 1000), nanoseconds: 0 }) as unknown as Timestamp;
const categories = new Map<string, MaterialCategory>([
  ["kash", "ldsp"], ["hdf", "hdf"], ["top", "countertop"], ["mdf", "mdf"], ["egger", "other"],
]);
const job = (materialId: string, sheetQty: number, cutAt?: string, over: Partial<OrderLineJob> = {}): OrderLineJob => ({
  index: 0, materialId, materialName: materialId, sheetQty, pvcMeters: 0,
  ...(cutAt ? { cuttingCompletedAt: at(cutAt), cuttingByName: "Олжас" } : {}), ...over,
});
let seq = 0;
const order = (lineJobs: OrderLineJob[], over: Partial<Order> = {}): Order =>
  ({ id: `o${++seq}`, orderNumber: `ORD-2026-000${seq}`, productionStatus: "ready", lineJobs, ...over }) as Order;
const [nov, dec] = monthRange("2026-11");

describe("sheetsCutBetween — what the saw really cut in a month", () => {
  it("splits лист, МДФ, ХДФ and столешница, at the count the cutter confirmed", () => {
    const cut = sheetsCutBetween([
      order([job("kash", 8, "2026-11-03T19:16:00+05:00", { confirmedSheets: 7 }), job("hdf", 2, "2026-11-03T19:17:00+05:00")]),
      order([job("top", 1, "2026-11-04T10:00:00+05:00"), job("mdf", 4, "2026-11-04T11:00:00+05:00")]),
      order([job("egger", 3, "2026-11-05T09:00:00+05:00")]),
    ], categories, nov, dec);
    expect(cut).toEqual({ ldsp: 10, mdf: 4, hdf: 2, countertop: 1, orders: 3 });
  });

  it("leaves out lines not cut yet, cut in another month, and struck-off rows", () => {
    const cut = sheetsCutBetween([
      order([job("kash", 5)]), // still queued
      order([job("kash", 6, "2026-10-31T23:30:00+05:00")]), // October, Almaty time
      order([job("kash", 9, "2026-11-02T10:00:00+05:00")], { productionStatus: "cancelled" }),
      order([job("kash", 4, "2026-11-02T10:00:00+05:00")], { mergedIntoOrderId: "o1" }),
      order([job("kash", 2, "2026-11-02T10:00:00+05:00")], { cutWorkVoided: true }),
      order([job("mdf", 13, "2026-11-02T10:00:00+05:00")], { orderKind: "mdf_wrap" }),
    ], categories, nov, dec);
    expect(cut).toEqual({ ldsp: 0, mdf: 0, hdf: 0, countertop: 0, orders: 0 });
  });

  it("reads an order older than line jobs by its own cut", () => {
    const old = { id: "old", orderNumber: "ORD-2026-000100", productionStatus: "delivered", materialId: "kash",
      materialSnapshot: { name: "ЛДСП Кашемир" }, estimatedSheets: 6, confirmedSheets: 5,
      cuttingCompletedAt: at("2026-11-10T12:00:00+05:00"), assignedCutterName: "Сүндет" } as unknown as Order;
    expect(sheetsCutBetween([old], categories, nov, dec)).toMatchObject({ ldsp: 5, orders: 1 });
  });

  it("names a deleted countertop or ХДФ by the line's own name", () => {
    const cut = sheetsCutBetween([
      order([job("gone-1", 2, "2026-11-04T10:00:00+05:00", { materialName: "Столешница Симал Бежевый" }),
        job("gone-2", 3, "2026-11-04T10:00:00+05:00", { materialName: "ХДФ ақ" })]),
    ], categories, nov, dec);
    expect(cut).toMatchObject({ countertop: 2, hdf: 3, ldsp: 0 });
  });

  it("spans the Almaty calendar month, December into January included", () => {
    expect(monthRange("2026-12").map((d) => d.toISOString())).toEqual(["2026-11-30T19:00:00.000Z", "2026-12-31T19:00:00.000Z"]);
  });
});
