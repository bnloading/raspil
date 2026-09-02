import type { PaymentMethodDef, PvcType } from "../types/domain";

/**
 * What each ledger column shows, and which of them a manager is allowed to hide.
 *
 * The journal grew from one "Құрамы" cell that crammed sheets and ПВХ together into two columns
 * that each answer one question — "how many sheets?" and "how many metres, in which colour?" —
 * because those are counted by two different people at two different machines. A wider table is
 * only affordable if the manager can put away what they don't use, which is what the "Бағандар"
 * menu is for: identity, money and the action button always stay, everything else is optional.
 */
export type JournalColumnId = "sheets" | "pvc" | "total" | "pay" | "method" | "progress" | "date";

export const JOURNAL_COLUMNS: { id: JournalColumnId; label: string; locked?: boolean }[] = [
  { id: "sheets", label: "Лист саны" },
  { id: "pvc", label: "ПВХ" },
  // The agreed sum and what came in against it are the two numbers this page exists for — they
  // are listed so the menu reads as the whole table, but they cannot be switched off.
  { id: "total", label: "Жалпы сома", locked: true },
  { id: "pay", label: "Төлем", locked: true },
  { id: "method", label: "Төлем түрі" },
  { id: "progress", label: "Өндіріс барысы" },
  { id: "date", label: "Күні" },
];

const HIDEABLE = new Set(JOURNAL_COLUMNS.filter((c) => !c.locked).map((c) => c.id));

export const JOURNAL_COLUMNS_KEY = "journalHiddenColumns";

/** Reads the remembered set, ignoring anything stale or locked so an old value can't blank a column that no longer hides. */
export function parseHiddenColumns(raw: string | null): Set<JournalColumnId> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is JournalColumnId => typeof id === "string" && HIDEABLE.has(id as JournalColumnId)));
  } catch {
    return new Set();
  }
}

/** Immutable toggle — a locked column is a no-op rather than an error, so the menu can render it disabled. */
export function toggleHiddenColumn(hidden: ReadonlySet<JournalColumnId>, id: JournalColumnId): Set<JournalColumnId> {
  const next = new Set(hidden);
  if (!HIDEABLE.has(id)) return next;
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** How many `<td>`s a row spans right now — the empty/loading rows have to match or the table shears. */
export function journalColumnCount(hidden: ReadonlySet<JournalColumnId>): number {
  // pick + who + actions are always on screen.
  return 3 + JOURNAL_COLUMNS.filter((c) => !hidden.has(c.id)).length;
}

/** The shape both a saved order line and an unsaved draft line share. */
export interface LineSummaryInput {
  materialName: string;
  sheetQty: number;
  pvcMeters: number;
  pvcTypeId?: string;
  pvcColorName?: string;
}

export interface CellSummary {
  /** The figure read at a glance — "13 лист", "176 м". */
  headline: string;
  /** What it is made of, read only when the headline raises a question — "Ақ 8 · ХДФ 5". */
  detail: string;
}

/**
 * "13 лист" over "Ақ 8 · ХДФ 5".
 *
 * A merged order is several sheet types under one number, and a single total hides which of them
 * the cutter is short of. Naming each material with its own count is what makes the row usable at
 * the saw without opening it.
 */
export function sheetSummary(lines: readonly LineSummaryInput[]): CellSummary {
  const total = lines.reduce((sum, l) => sum + l.sheetQty, 0);
  if (total <= 0) return { headline: "—", detail: "" };

  const byMaterial = new Map<string, number>();
  for (const line of lines) {
    if (line.sheetQty <= 0) continue;
    const name = line.materialName.trim() || "Материал";
    byMaterial.set(name, (byMaterial.get(name) ?? 0) + line.sheetQty);
  }

  // One material needs no breakdown — "Ақ 13" under "13 лист" says nothing twice.
  const detail =
    byMaterial.size === 1
      ? [...byMaterial.keys()][0]
      : [...byMaterial.entries()].map(([name, qty]) => `${name} ${qty}`).join(" · ");

  return { headline: `${total} лист`, detail };
}

/**
 * "176 м" over "Ақ · 1 мм".
 *
 * Metres are ordered by the roll they come off, so the colour and thickness belong next to the
 * figure: the ПВХ station picks the roll from this line, and a metre total with no colour on it is
 * a number nobody can act on.
 */
export function pvcSummary(
  lines: readonly LineSummaryInput[],
  pvcTypesById?: ReadonlyMap<string, Pick<PvcType, "colorName" | "thicknessMm">>,
): CellSummary {
  const meters = lines.reduce((sum, l) => sum + l.pvcMeters, 0);
  if (meters <= 0) return { headline: "—", detail: "" };

  const colors: string[] = [];
  for (const line of lines) {
    if (line.pvcMeters <= 0) continue;
    const type = line.pvcTypeId ? pvcTypesById?.get(line.pvcTypeId) : undefined;
    const name = (type?.colorName ?? line.pvcColorName ?? "").trim();
    if (!name) continue;
    // Thickness only when the catalogue still knows it: a colour retired since the order was
    // written keeps its name, and inventing a thickness for it would be worse than leaving it off.
    const label = type ? `${name} · ${type.thicknessMm} мм` : name;
    if (!colors.includes(label)) colors.push(label);
  }

  return {
    headline: `${Math.round(meters)} м`,
    detail: colors.length === 0 ? "түсі таңдалмаған" : colors.join(" · "),
  };
}

/**
 * Which colour a payment-method pill wears.
 *
 * The methods are seeded documents, not an enum, so the map is keyed on the ids the shop actually
 * uses and anything else falls back to a neutral tone rather than borrowing a colour that already
 * means something. Kaspi red and Нұр green are how the counter already talks about them.
 */
const METHOD_TONES: Record<string, string> = {
  cash: "violet",
  kaspi: "red",
  pay: "sky",
  nur: "green",
  balim: "indigo",
  mixed: "amber",
};

export function methodTone(methodId: string | null | undefined): string {
  if (!methodId) return "none";
  return METHOD_TONES[methodId] ?? "slate";
}

/**
 * Which method a row is filed under, for the "Төлем түрі" column and the method filter.
 *
 * An order paid half in cash and half by Kaspi is neither, so it reports "mixed" — collapsing it
 * to whichever payment happened to be last would put real money in the wrong column of the filter.
 */
export function methodIdOf(methodIds: readonly string[]): string | null {
  if (methodIds.length === 0) return null;
  if (methodIds.length > 1) return "mixed";
  return methodIds[0];
}

/** The label the pill prints — the method's own name, or the shop's word for each edge case. */
export function methodLabelOf(
  methodId: string | null,
  methods: readonly PaymentMethodDef[],
  fallbackName?: string,
): string {
  if (!methodId) return "Таңдалмаған";
  if (methodId === "mixed") return "Аралас";
  return methods.find((m) => m.id === methodId)?.name ?? fallbackName ?? methodId;
}
