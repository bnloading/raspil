/**
 * A line's material as people read it.
 *
 * A customer's own sheet is entered against one placeholder, «Сырттан келетін лист», and until
 * 09.11 nothing said what the sheet actually was — the owner: «Сырттан келетін лист белгілеген
 * кезінде аты жазылатын болсын». The journal now takes that name (OrderMaterialLine.externalName)
 * and every screen that names the line reads it through here:
 *
 *   full    — «Сырттан келетін лист · Эггер Дуб Галифакс»: the cutter's card, the invoice, the
 *             customer's breakdown, the export.
 *   compact — «Сырттан: Эггер Дуб Галифакс»: the journal's narrow «Лист» cell, where the long
 *             placeholder would push the name itself out of sight.
 *
 * A line with no such name reads exactly as before.
 */
export function materialLabel(
  line: { materialName?: string; externalName?: string },
  { compact = false }: { compact?: boolean } = {},
): string {
  const name = (line.materialName ?? "").trim();
  const own = (line.externalName ?? "").trim();
  if (!own) return name;
  if (!compact) return name ? `${name} · ${own}` : own;
  // «Сырттан келетін лист Эггер» keeps its «Эггер»; the bare placeholder keeps nothing but «Сырттан».
  const rest = name.replace(/^сырттан\s+келетін(\s+лист)?\s*/iu, "").trim();
  return `Сырттан${rest ? ` ${rest}` : ""}: ${own}`;
}
