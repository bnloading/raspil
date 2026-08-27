import { EDGE_KEYS } from "../types/domain";
import type { CuttingPart, EdgeKey } from "../types/domain";

/**
 * Bulk PVC edge assignment for the dimensions editor.
 *
 * Edge geometry follows lib/pricing.ts's convention and must not drift from it: A (top) and
 * C (bottom) run along the part's WIDTH; B (right) and D (left) run along its LENGTH. Everything
 * here is pure so the same rules can be unit-tested and reused by any caller.
 */

export type BulkEdgeMode = "all" | "long" | "short" | "none";

export const BULK_EDGE_LABELS: Record<BulkEdgeMode, string> = {
  all: "4 жағына",
  long: "Ұзын 2 жағына",
  short: "Қысқа 2 жағына",
  none: "ПВХ жоқ",
};

/** The two edges running along the part's longer side. Ties resolve to B/D (the length pair). */
export function longEdges(part: Pick<CuttingPart, "lengthMm" | "widthMm">): EdgeKey[] {
  return part.lengthMm >= part.widthMm ? ["B", "D"] : ["A", "C"];
}

/** The two edges running along the part's shorter side — always the complement of longEdges(). */
export function shortEdges(part: Pick<CuttingPart, "lengthMm" | "widthMm">): EdgeKey[] {
  return part.lengthMm >= part.widthMm ? ["A", "C"] : ["B", "D"];
}

/** Which edges a bulk mode selects for one specific part. */
export function edgesForMode(part: Pick<CuttingPart, "lengthMm" | "widthMm">, mode: BulkEdgeMode): EdgeKey[] {
  switch (mode) {
    case "all":
      return [...EDGE_KEYS];
    case "long":
      return longEdges(part);
    case "short":
      return shortEdges(part);
    case "none":
      return [];
  }
}

/**
 * Applies a bulk edge mode to one part. Always rewrites all four edges so the result is exactly
 * the requested set — switching a part from "4 жағына" to "Ұзын 2 жағына" clears the other two
 * rather than leaving them stuck on.
 */
export function applyEdgeMode(part: CuttingPart, mode: BulkEdgeMode, pvcTypeId?: string): CuttingPart {
  const wanted = new Set(edgesForMode(part, mode));
  const edges = {} as CuttingPart["edges"];
  for (const edge of EDGE_KEYS) {
    const on = wanted.has(edge);
    edges[edge] = on
      ? { pvc: true, pvcTypeId: pvcTypeId ?? part.edges[edge]?.pvcTypeId, note: part.edges[edge]?.note }
      : { pvc: false, note: part.edges[edge]?.note };
  }
  return { ...part, edges };
}

/** Applies a bulk edge mode to every selected part, leaving the rest untouched. */
export function applyEdgeModeToSelection(
  parts: CuttingPart[],
  selectedIds: ReadonlySet<string>,
  mode: BulkEdgeMode,
  pvcTypeId?: string,
): CuttingPart[] {
  return parts.map((p) => (selectedIds.has(p.id) ? applyEdgeMode(p, mode, pvcTypeId) : p));
}

/** Re-points every already-PVC edge of the selected parts at a different PVC type (colour/thickness). */
export function applyPvcTypeToSelection(
  parts: CuttingPart[],
  selectedIds: ReadonlySet<string>,
  pvcTypeId: string,
): CuttingPart[] {
  return parts.map((p) => {
    if (!selectedIds.has(p.id)) return p;
    const edges = {} as CuttingPart["edges"];
    for (const edge of EDGE_KEYS) {
      const current = p.edges[edge];
      edges[edge] = current?.pvc ? { ...current, pvcTypeId } : { ...current, pvc: false };
    }
    return { ...p, edges };
  });
}

/**
 * "Алдыңғы қатардан көшіру" — copies the edge configuration of the row above onto each selected
 * row. Uses each selected row's own predecessor in the full list (not the first selected row), so
 * selecting a contiguous block propagates the block's preceding configuration down through it.
 * A selected row at index 0 has no predecessor and is left as-is.
 */
export function copyEdgesFromPreviousRow(parts: CuttingPart[], selectedIds: ReadonlySet<string>): CuttingPart[] {
  // Built iteratively rather than with map(): each row must copy from the row above *as already
  // updated*, so selecting a contiguous block cascades the configuration all the way down it
  // instead of every row reading the same stale original.
  const out: CuttingPart[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (index === 0 || !selectedIds.has(part.id)) {
      out.push(part);
      continue;
    }
    const source = out[index - 1];
    const edges = {} as CuttingPart["edges"];
    for (const edge of EDGE_KEYS) {
      const from = source.edges[edge];
      edges[edge] = from?.pvc
        ? { pvc: true, pvcTypeId: from.pvcTypeId, note: part.edges[edge]?.note }
        : { pvc: false, note: part.edges[edge]?.note };
    }
    out.push({ ...part, edges });
  }
  return out;
}

/** Toggles one edge on one part. */
export function toggleEdge(parts: CuttingPart[], partId: string, edge: EdgeKey, pvcTypeId?: string): CuttingPart[] {
  return parts.map((p) => {
    if (p.id !== partId) return p;
    const current = p.edges[edge];
    const next = !current?.pvc;
    return {
      ...p,
      edges: {
        ...p.edges,
        [edge]: next
          ? { pvc: true, pvcTypeId: current?.pvcTypeId ?? pvcTypeId, note: current?.note }
          : { pvc: false, note: current?.note },
      },
    };
  });
}

/** Duplicates every selected part, inserting each copy directly after its original. */
export function duplicateSelection(parts: CuttingPart[], selectedIds: ReadonlySet<string>): CuttingPart[] {
  const out: CuttingPart[] = [];
  for (const part of parts) {
    out.push(part);
    if (selectedIds.has(part.id)) {
      out.push({ ...part, id: crypto.randomUUID(), edges: { ...part.edges } });
    }
  }
  return out;
}

export function deleteSelection(parts: CuttingPart[], selectedIds: ReadonlySet<string>): CuttingPart[] {
  return parts.filter((p) => !selectedIds.has(p.id));
}

/** How many parts have at least one PVC edge — drives the "Белгіленді 142 / 186" progress line. */
export function markedPartCount(parts: CuttingPart[]): number {
  return parts.filter((p) => EDGE_KEYS.some((e) => p.edges[e]?.pvc)).length;
}

/** Case-insensitive search over part name and its dimensions ("720", "720x450", "450"). */
export function filterParts(parts: CuttingPart[], search: string): CuttingPart[] {
  const q = search.trim().toLowerCase();
  if (!q) return parts;
  const normalized = q.replace(/\s*[x×]\s*/g, "x");
  return parts.filter((p) => {
    const dims = `${p.lengthMm}x${p.widthMm}`;
    return (
      p.name.toLowerCase().includes(q) ||
      dims.includes(normalized) ||
      String(p.lengthMm).includes(q) ||
      String(p.widthMm).includes(q)
    );
  });
}

export type PvcFilter = "all" | "marked" | "unmarked";

export function applyPvcFilter(parts: CuttingPart[], filter: PvcFilter): CuttingPart[] {
  if (filter === "all") return parts;
  const isMarked = (p: CuttingPart) => EDGE_KEYS.some((e) => p.edges[e]?.pvc);
  return parts.filter((p) => (filter === "marked" ? isMarked(p) : !isMarked(p)));
}
