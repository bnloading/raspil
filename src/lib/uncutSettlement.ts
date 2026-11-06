import type { OrderLineJob } from "../types/domain";

/**
 * What the rack owes or is owed after a journal edit to an order whose sheets were already taken
 * — the lines not cut yet (the owner, 06.11: «қайтару кезінде bug-тар болып минус етілмей қалды
 * ма, артық қосылды ма — бәрін тексеріп көр»).
 *
 * A line the saw has cut is settled by lib/journalOrders.ts resettleCorrectedCuts. A line still in
 * the queue was left for the cut to settle — the cutter's confirmed count against what was taken —
 * and that is right while it stays the same material. It is not right for:
 *
 *   - a line whose material was changed (Кашемир → Вотан): the sheets were taken from Кашемир, and
 *     the cut would settle only the difference against Вотан, so Кашемир never got them back;
 *   - a line deleted from the row: the sheets it held went with it and never came back;
 *   - an order handed over whole («распилсіз берілді»): it never reaches the saw, so a count
 *     corrected afterwards (№533, 4 → 5 листов МДФ бізден) never reached the rack at all.
 *
 * `before` is the order's lines as they were before the edit, `after` as the edit left them
 * (lib/orderLines.ts syncLineJobs, which keeps a line's place by its index).
 */
export interface UncutSettlement {
  /** Per material: sheets to take now (> 0) or to give back (< 0). */
  deltas: Map<string, number>;
  /** `after`, with what each uncut line now holds. */
  jobs: OrderLineJob[];
}

export function planUncutSettlement(
  before: readonly OrderLineJob[],
  after: readonly OrderLineJob[],
  opts: { withoutCutting: boolean; tracked: (materialId: string) => boolean },
): UncutSettlement {
  const deltas = new Map<string, number>();
  const add = (materialId: string, qty: number) => {
    if (!materialId || qty === 0) return;
    deltas.set(materialId, (deltas.get(materialId) ?? 0) + qty);
  };
  const cut = (j: OrderLineJob | undefined) => !!j?.cuttingCompletedAt;

  // Everything the uncut lines held before the edit goes back… — except a line the saw finished
  // since the page was opened: the cut settled it against what it held (consumeLineForCutting),
  // and giving that back again would put cut sheets on the rack.
  for (const j of before) {
    if (cut(j) || cut(after[j.index])) continue;
    add(j.materialId, -(j.consumedQty ?? 0));
  }

  // …and each uncut line takes what it holds now.
  const jobs = after.map((j) => {
    if (cut(j)) return j;
    const prev = before[j.index];
    let holds: number;
    if (opts.withoutCutting) {
      // Handed over whole: what the row says is what left the rack — there is no cut to settle it.
      holds = opts.tracked(j.materialId) ? j.sheetQty : 0;
    } else if (prev && !cut(prev) && prev.materialId === j.materialId) {
      // Same material, still in the queue: the cut settles any change of count, as before.
      holds = prev.consumedQty ?? 0;
    } else {
      // A new material on this line (or a line added): nothing is held for it; the cut takes it.
      holds = 0;
    }
    add(j.materialId, holds);
    return { ...j, consumedQty: holds };
  });

  for (const [id, qty] of deltas) if (qty === 0) deltas.delete(id);
  return { deltas, jobs };
}
