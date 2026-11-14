import { describe, it, expect } from "vitest";
import type { Timestamp } from "firebase/firestore";
import type { MaterialCategory, Order, OrderLineJob } from "../types/domain";
import { cutterBoard, jobsOfKind } from "./cutterBoard";
import { lineKind, materialKind } from "./lineCategory";

const at = { seconds: 1, nanoseconds: 0 } as unknown as Timestamp;
const catalogue = new Map<string, MaterialCategory>([
  ["ldsp-ak", "ldsp"], ["hdf", "hdf"], ["top-mramor", "countertop"], ["dub-kera", "countertop"],
]);
const job = (index: number, materialId: string, materialName: string, extra: Partial<OrderLineJob> = {}): OrderLineJob =>
  ({ index, materialId, materialName, sheetQty: 2, pvcMeters: 0, ...extra }) as OrderLineJob;
const order = (id: string, priority: number, productionStatus: Order["productionStatus"], lineJobs: OrderLineJob[]): Order =>
  ({ id, priority, productionStatus, lineJobs, items: [] }) as unknown as Order;

describe("stock kinds (the owner, 14.11: лист and столешница apart)", () => {
  it("puts only countertops under «Столешница», by the catalogue, whatever the name says", () => {
    expect(materialKind({ category: "countertop" })).toBe("countertop");
    for (const category of ["ldsp", "hdf", "mdf", "other", undefined] as const) expect(materialKind({ category })).toBe("sheet");
    // «Дуб Кера» has no «Столешница» in its name — the catalogue still makes it one.
    expect(lineKind({ materialId: "dub-kera", materialName: "Дуб Кера" }, catalogue)).toBe("countertop");
    expect(lineKind({ materialId: "gone", materialName: "Столешница Симал Бежевый" }, catalogue)).toBe("countertop");
    expect(lineKind({ materialId: "hdf", materialName: "ХДФ" }, catalogue)).toBe("sheet");
  });
});

describe("cutterBoard", () => {
  // Динко: 4 листа Ақ and 2 столешницы on one order.
  const dinko = order("dinko", 1, "cutting_queue", [
    job(0, "ldsp-ak", "ЛДСП Ақ Томск", { sheetQty: 4 }),
    job(1, "top-mramor", "Столешница Белый мрамор", { sheetQty: 2 }),
    job(2, "", "", { sheetQty: 0 }), // a blank line is nobody's work
  ]);

  it("splits one order between the sheet page and the countertop page", () => {
    expect(jobsOfKind(dinko, "sheet", catalogue).map((j) => j.materialName)).toEqual(["ЛДСП Ақ Томск"]);
    expect(jobsOfKind(dinko, "countertop", catalogue).map((j) => j.materialName)).toEqual(["Столешница Белый мрамор"]);
    expect(cutterBoard([dinko], "sheet", catalogue).queued.map((o) => o.id)).toEqual(["dinko"]);
    expect(cutterBoard([dinko], "countertop", catalogue).queued.map((o) => o.id)).toEqual(["dinko"]);
  });

  it("drops an order from a page once that page's lines are cut, and keeps it on the other", () => {
    const sheetsDone = order("dinko", 1, "cutting_started", [
      job(0, "ldsp-ak", "ЛДСП Ақ Томск", { cuttingStartedAt: at, cuttingCompletedAt: at }),
      job(1, "top-mramor", "Столешница Белый мрамор"),
    ]);
    expect(cutterBoard([sheetsDone], "sheet", catalogue)).toEqual({ inProgress: [], queued: [] });
    // Started on the order, but not this countertop: it waits on «Столешница», not «at work».
    expect(cutterBoard([sheetsDone], "countertop", catalogue)).toEqual({ inProgress: [], queued: [sheetsDone] });
  });

  it("is at work on a page only when a line of that page's kind is started", () => {
    const onSaw = order("o", 3, "cutting_started", [
      job(0, "ldsp-ak", "ЛДСП Ақ Томск", { cuttingStartedAt: at }),
      job(1, "top-mramor", "Столешница Белый мрамор"),
    ]);
    expect(cutterBoard([onSaw], "sheet", catalogue).inProgress).toEqual([onSaw]);
    expect(cutterBoard([onSaw], "countertop", catalogue).queued).toEqual([onSaw]);
  });

  it("lists only orders at the saw, waiting ones in queue order", () => {
    const late = order("late", 5, "cutting_queue", [job(0, "ldsp-ak", "ЛДСП Ақ Томск")]);
    const early = order("early", 2, "cutting_queue", [job(0, "hdf", "ХДФ")]);
    const atPvc = order("pvc", 0, "pvc_queue", [job(0, "ldsp-ak", "ЛДСП Ақ Томск")]);
    const onlyTops = order("tops", 1, "cutting_queue", [job(0, "dub-kera", "Дуб Кера")]);
    expect(cutterBoard([late, atPvc, early, onlyTops], "sheet", catalogue).queued.map((o) => o.id)).toEqual(["early", "late"]);
    expect(cutterBoard([late, atPvc, early, onlyTops], "countertop", catalogue).queued.map((o) => o.id)).toEqual(["tops"]);
  });
});
