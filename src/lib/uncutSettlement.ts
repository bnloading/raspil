import type { OrderLineJob } from "../types/domain";

/**
 * What the rack owes or is owed after a journal edit to an order whose sheets were already taken
 * — the lines not cut yet (the owner, 06.11: «қайтару кезінде bug-тар болып минус етілмей қалды
 * ма, артық қосылды ма — бәрін тексеріп көр»).
 *
 * A line the saw has cut is settled by lib/journalOrders.ts resettleCorrectedCuts. A line not cut
 * yet holds what its row says, exactly as the queue took it (consumeStockOnQueue) — so an edit
 * settles it at once, and the rack never shows sheets the journal no longer asks for:
 *
 *   - a new count (№806, Вотан 6 → 5, 12.11): the sixth sheet goes back now, not when the cutter
 *     confirms the cut («6 лист минус етілген қалпында қалып қойып тұр»);
 *   - a line whose material was changed (Кашемир → Вотан): Кашемир gets its sheets back, Вотан
 *     gives them;
 *   - a line deleted from the row: the sheets it held go back;
 *   - an order handed over whole («распилсіз берілді»): it never reaches the saw, so this is the
 *     only place a corrected count (№533, 4 → 5 листов МДФ бізден) reaches the rack.
 *
 * The cut then settles only what the cutter's count differs from the row by.
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

  // …and each uncut line takes what its row says now — what the queue would have taken for it.
  const jobs = after.map((j) => {
    if (cut(j)) return j;
    const holds = j.materialId && j.sheetQty > 0 && opts.tracked(j.materialId) ? j.sheetQty : 0;
    add(j.materialId, holds);
    return { ...j, consumedQty: holds };
  });

  for (const [id, qty] of deltas) if (qty === 0) deltas.delete(id);
  return { deltas, jobs };
}
