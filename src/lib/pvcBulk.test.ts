import { describe, it, expect } from "vitest";
import {
  longEdges,
  shortEdges,
  edgesForMode,
  applyEdgeMode,
  applyEdgeModeToSelection,
  applyPvcTypeToSelection,
  copyEdgesFromPreviousRow,
  toggleEdge,
  duplicateSelection,
  deleteSelection,
  markedPartCount,
  filterParts,
  applyPvcFilter,
} from "./pvcBulk";
import { computePartPvcMeters, totalPvcMeters } from "./pricing";
import { EDGE_KEYS } from "../types/domain";
import type { CuttingPart, EdgeKey } from "../types/domain";

function part(overrides: Partial<CuttingPart> = {}): CuttingPart {
  return {
    id: overrides.id ?? "p1",
    name: "Бөлшек",
    lengthMm: 720,
    widthMm: 450,
    qty: 1,
    grainDirection: "any",
    rotationAllowed: false,
    edges: { A: { pvc: false }, B: { pvc: false }, C: { pvc: false }, D: { pvc: false } },
    ...overrides,
  };
}

const onEdges = (p: CuttingPart): EdgeKey[] => EDGE_KEYS.filter((e) => p.edges[e]?.pvc);

describe("edge geometry matches lib/pricing.ts's convention", () => {
  it("B and D are the long edges when length >= width", () => {
    expect(longEdges({ lengthMm: 720, widthMm: 450 })).toEqual(["B", "D"]);
    expect(shortEdges({ lengthMm: 720, widthMm: 450 })).toEqual(["A", "C"]);
  });

  it("A and C are the long edges when width > length", () => {
    expect(longEdges({ lengthMm: 300, widthMm: 1200 })).toEqual(["A", "C"]);
    expect(shortEdges({ lengthMm: 300, widthMm: 1200 })).toEqual(["B", "D"]);
  });

  it("a square part resolves the tie to the length pair, and the two sets stay complementary", () => {
    const square = { lengthMm: 500, widthMm: 500 };
    expect(longEdges(square)).toEqual(["B", "D"]);
    expect([...longEdges(square), ...shortEdges(square)].sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("the long pair really is the longer one, measured the way pricing.ts measures it", () => {
    const p = part({ lengthMm: 720, widthMm: 450 });
    const longOnly = applyEdgeMode(p, "long");
    const shortOnly = applyEdgeMode(p, "short");
    expect(computePartPvcMeters(longOnly)).toBeGreaterThan(computePartPvcMeters(shortOnly));
  });
});

describe("edgesForMode", () => {
  it("all selects every edge; none selects nothing", () => {
    expect(edgesForMode({ lengthMm: 720, widthMm: 450 }, "all")).toEqual(["A", "B", "C", "D"]);
    expect(edgesForMode({ lengthMm: 720, widthMm: 450 }, "none")).toEqual([]);
  });
});

describe("applyEdgeMode", () => {
  it("switching modes clears edges the new mode does not want", () => {
    const all = applyEdgeMode(part(), "all");
    expect(onEdges(all)).toEqual(["A", "B", "C", "D"]);
    const narrowed = applyEdgeMode(all, "long");
    expect(onEdges(narrowed)).toEqual(["B", "D"]);
  });

  it("'ПВХ жоқ' clears every edge", () => {
    const cleared = applyEdgeMode(applyEdgeMode(part(), "all"), "none");
    expect(onEdges(cleared)).toEqual([]);
  });

  it("stamps the chosen PVC type onto the edges it turns on", () => {
    const p = applyEdgeMode(part(), "all", "pvc-white-2mm");
    for (const e of EDGE_KEYS) expect(p.edges[e].pvcTypeId).toBe("pvc-white-2mm");
  });

  it("keeps each edge's existing PVC type when no new type is given", () => {
    const seeded = applyEdgeMode(part(), "all", "pvc-a");
    const relabelled = applyEdgeMode(seeded, "long");
    expect(relabelled.edges.B.pvcTypeId).toBe("pvc-a");
  });

  it("does not mutate the input part", () => {
    const original = part();
    applyEdgeMode(original, "all");
    expect(onEdges(original)).toEqual([]);
  });
});

describe("applyEdgeModeToSelection", () => {
  const parts = [part({ id: "a" }), part({ id: "b" }), part({ id: "c" })];

  it("touches only the selected parts", () => {
    const next = applyEdgeModeToSelection(parts, new Set(["a", "c"]), "all");
    expect(onEdges(next[0])).toHaveLength(4);
    expect(onEdges(next[1])).toHaveLength(0);
    expect(onEdges(next[2])).toHaveLength(4);
  });

  it("an empty selection changes nothing", () => {
    const next = applyEdgeModeToSelection(parts, new Set(), "all");
    expect(next.every((p) => onEdges(p).length === 0)).toBe(true);
  });

  it("applies per-part geometry, so mixed orientations each get their own long pair", () => {
    const mixed = [part({ id: "tall", lengthMm: 800, widthMm: 300 }), part({ id: "wide", lengthMm: 300, widthMm: 800 })];
    const next = applyEdgeModeToSelection(mixed, new Set(["tall", "wide"]), "long");
    expect(onEdges(next[0])).toEqual(["B", "D"]);
    expect(onEdges(next[1])).toEqual(["A", "C"]);
  });
});

describe("applyPvcTypeToSelection", () => {
  it("re-points existing PVC edges without turning new ones on", () => {
    const parts = [applyEdgeMode(part({ id: "a" }), "long", "old"), part({ id: "b" })];
    const next = applyPvcTypeToSelection(parts, new Set(["a", "b"]), "new");
    expect(next[0].edges.B.pvcTypeId).toBe("new");
    expect(next[0].edges.A.pvc).toBe(false);
    expect(onEdges(next[1])).toHaveLength(0);
  });
});

describe("copyEdgesFromPreviousRow", () => {
  it("copies the row above onto each selected row", () => {
    const parts = [applyEdgeMode(part({ id: "a" }), "all", "t1"), part({ id: "b" }), part({ id: "c" })];
    const next = copyEdgesFromPreviousRow(parts, new Set(["b"]));
    expect(onEdges(next[1])).toEqual(["A", "B", "C", "D"]);
    expect(next[1].edges.A.pvcTypeId).toBe("t1");
    expect(onEdges(next[2])).toHaveLength(0);
  });

  it("propagates down a contiguous block, each row taking its own predecessor", () => {
    const parts = [applyEdgeMode(part({ id: "a" }), "all"), part({ id: "b" }), part({ id: "c" }), part({ id: "d" })];
    const next = copyEdgesFromPreviousRow(parts, new Set(["b", "c"]));
    expect(onEdges(next[1])).toHaveLength(4);
    expect(onEdges(next[2])).toHaveLength(4);
    expect(onEdges(next[3])).toHaveLength(0);
  });

  it("leaves a selected first row alone — it has no predecessor", () => {
    const parts = [part({ id: "a" }), applyEdgeMode(part({ id: "b" }), "all")];
    const next = copyEdgesFromPreviousRow(parts, new Set(["a"]));
    expect(onEdges(next[0])).toHaveLength(0);
  });
});

describe("toggleEdge", () => {
  it("turns a single edge on and off again", () => {
    let parts = [part({ id: "a" })];
    parts = toggleEdge(parts, "a", "A", "t1");
    expect(parts[0].edges.A).toMatchObject({ pvc: true, pvcTypeId: "t1" });
    parts = toggleEdge(parts, "a", "A");
    expect(parts[0].edges.A.pvc).toBe(false);
  });

  it("leaves other parts and other edges untouched", () => {
    const parts = toggleEdge([part({ id: "a" }), part({ id: "b" })], "a", "B");
    expect(onEdges(parts[0])).toEqual(["B"]);
    expect(onEdges(parts[1])).toEqual([]);
  });
});

describe("duplicate / delete selection", () => {
  it("inserts each copy directly after its original with a fresh id", () => {
    const parts = [part({ id: "a", name: "A" }), part({ id: "b", name: "B" })];
    const next = duplicateSelection(parts, new Set(["a"]));
    expect(next.map((p) => p.name)).toEqual(["A", "A", "B"]);
    expect(next[1].id).not.toBe("a");
  });

  it("copies the edge configuration into the duplicate", () => {
    const parts = [applyEdgeMode(part({ id: "a" }), "all", "t1")];
    const next = duplicateSelection(parts, new Set(["a"]));
    expect(onEdges(next[1])).toEqual(["A", "B", "C", "D"]);
  });

  it("deletes exactly the selected rows", () => {
    const parts = [part({ id: "a" }), part({ id: "b" }), part({ id: "c" })];
    expect(deleteSelection(parts, new Set(["a", "c"])).map((p) => p.id)).toEqual(["b"]);
  });
});

describe("progress, search and filtering", () => {
  it("counts parts with at least one PVC edge", () => {
    const parts = [applyEdgeMode(part({ id: "a" }), "long"), part({ id: "b" }), applyEdgeMode(part({ id: "c" }), "all")];
    expect(markedPartCount(parts)).toBe(2);
  });

  it("searches by name and by dimensions in either notation", () => {
    const parts = [
      part({ id: "a", name: "Есік панелі", lengthMm: 720, widthMm: 450 }),
      part({ id: "b", name: "Сөре", lengthMm: 568, widthMm: 300 }),
    ];
    expect(filterParts(parts, "есік").map((p) => p.id)).toEqual(["a"]);
    expect(filterParts(parts, "720x450").map((p) => p.id)).toEqual(["a"]);
    expect(filterParts(parts, "720 × 450").map((p) => p.id)).toEqual(["a"]);
    expect(filterParts(parts, "568").map((p) => p.id)).toEqual(["b"]);
    expect(filterParts(parts, "").map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("filters by marked / unmarked PVC state", () => {
    const parts = [applyEdgeMode(part({ id: "a" }), "all"), part({ id: "b" })];
    expect(applyPvcFilter(parts, "marked").map((p) => p.id)).toEqual(["a"]);
    expect(applyPvcFilter(parts, "unmarked").map((p) => p.id)).toEqual(["b"]);
    expect(applyPvcFilter(parts, "all")).toHaveLength(2);
  });
});

describe("PVC metres stay correct after bulk edits", () => {
  it("'4 жағына' on a 720×450 ×2 part = perimeter × qty ÷ 1000", () => {
    const p = applyEdgeMode(part({ lengthMm: 720, widthMm: 450, qty: 2 }), "all");
    // (450 + 720 + 450 + 720) × 2 / 1000
    expect(computePartPvcMeters(p)).toBeCloseTo(4.68, 5);
  });

  it("'Ұзын 2 жағына' counts only the two length edges", () => {
    const p = applyEdgeMode(part({ lengthMm: 720, widthMm: 450, qty: 2 }), "long");
    expect(computePartPvcMeters(p)).toBeCloseTo((720 * 2 * 2) / 1000, 5);
  });

  it("'Қысқа 2 жағына' counts only the two width edges", () => {
    const p = applyEdgeMode(part({ lengthMm: 720, widthMm: 450, qty: 2 }), "short");
    expect(computePartPvcMeters(p)).toBeCloseTo((450 * 2 * 2) / 1000, 5);
  });

  it("clearing PVC returns the part to zero metres", () => {
    const p = applyEdgeMode(applyEdgeMode(part({ qty: 5 }), "all"), "none");
    expect(computePartPvcMeters(p)).toBe(0);
  });

  it("a 200-part bulk apply totals the same as summing each part individually", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      part({ id: `p${i}`, lengthMm: 400 + i, widthMm: 300, qty: (i % 3) + 1 }),
    );
    const ids = new Set(many.map((p) => p.id));
    const applied = applyEdgeModeToSelection(many, ids, "all");
    const expected = applied.reduce((s, p) => s + computePartPvcMeters(p), 0);
    expect(totalPvcMeters(applied)).toBeCloseTo(expected, 6);
    expect(markedPartCount(applied)).toBe(200);
  });
});
