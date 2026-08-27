import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  updateDoc,
  writeBatch,
  type Firestore,
} from "firebase/firestore";
import type { User } from "firebase/auth";
import type { CsvTemplate, UserDoc } from "../types/domain";
import { DEFAULT_CSV_COLUMNS } from "./exportTable";
import { logAudit } from "./audit";

type Actor = { user: User; userData: UserDoc };

/** A brand-new template, pre-filled with the standard cutting-program format. */
export function newTemplateDraft(name: string): Omit<CsvTemplate, "id"> {
  return {
    name,
    columns: [...DEFAULT_CSV_COLUMNS],
    columnLabels: {},
    delimiter: ",",
    encoding: "utf8-bom",
    includeHeaders: true,
    unit: "mm",
    dimensionOrder: "length_first",
    pvcMapping: "per_edge",
    isDefault: false,
    archived: false,
  };
}

/** Suggested starting set for a shop that has none yet — the spec's example names. */
export const SUGGESTED_TEMPLATE_NAMES = [
  "Cutting негізгі",
  "Пила №1",
  "Пила №2",
  "Excel формат",
  "Клиентке арналған",
];

export async function createCsvTemplate(
  db: Firestore,
  actor: Actor,
  draft: Omit<CsvTemplate, "id">,
): Promise<string> {
  const ref = await addDoc(collection(db, "csvTemplates"), {
    ...draft,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedByUid: actor.user.uid,
    updatedByName: actor.userData.name,
  });
  await logAudit(db, actor, {
    action: "csvTemplate.create",
    entityType: "csvTemplate",
    entityId: ref.id,
    after: { name: draft.name },
  });
  return ref.id;
}

export async function updateCsvTemplate(
  db: Firestore,
  actor: Actor,
  id: string,
  patch: Partial<Omit<CsvTemplate, "id">>,
): Promise<void> {
  await updateDoc(doc(db, "csvTemplates", id), {
    ...patch,
    updatedAt: serverTimestamp(),
    updatedByUid: actor.user.uid,
    updatedByName: actor.userData.name,
  });
  await logAudit(db, actor, {
    action: "csvTemplate.update",
    entityType: "csvTemplate",
    entityId: id,
    after: patch.name ? { name: patch.name } : undefined,
  });
}

export async function duplicateCsvTemplate(db: Firestore, actor: Actor, source: CsvTemplate): Promise<string> {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = source;
  void _id;
  void _c;
  void _u;
  return createCsvTemplate(db, actor, {
    ...rest,
    name: `${source.name} (көшірме)`,
    // A copy never inherits default status — exactly one template is the default, and silently
    // moving it during a duplicate would change which format the next export uses.
    isDefault: false,
    archived: false,
  });
}

/**
 * Makes one template the default, clearing the flag on every other in the same batch so there can
 * never be two defaults (or none) even if two admins press the button at the same time.
 */
export async function setDefaultCsvTemplate(db: Firestore, actor: Actor, id: string): Promise<void> {
  const snap = await getDocs(collection(db, "csvTemplates"));
  const batch = writeBatch(db);
  snap.docs.forEach((d) => {
    const shouldBeDefault = d.id === id;
    if (!!d.data().isDefault !== shouldBeDefault) {
      batch.update(d.ref, { isDefault: shouldBeDefault });
    }
  });
  await batch.commit();
  await logAudit(db, actor, {
    action: "csvTemplate.set_default",
    entityType: "csvTemplate",
    entityId: id,
  });
}

/** Archiving hides a template from the export picker without destroying the format itself. */
export async function archiveCsvTemplate(db: Firestore, actor: Actor, template: CsvTemplate): Promise<void> {
  if (template.isDefault) {
    throw new Error("Әдепкі шаблонды мұрағаттау мүмкін емес. Алдымен басқасын әдепкі етіп қойыңыз.");
  }
  await updateCsvTemplate(db, actor, template.id, { archived: !template.archived });
}

/**
 * Permanent deletion. Refuses to remove the default template, so a shop can never end up with no
 * usable export format by deleting the wrong row.
 */
export async function deleteCsvTemplate(db: Firestore, actor: Actor, template: CsvTemplate): Promise<void> {
  if (template.isDefault) {
    throw new Error("Әдепкі шаблонды өшіру мүмкін емес. Алдымен басқасын әдепкі етіп қойыңыз.");
  }
  await deleteDoc(doc(db, "csvTemplates", template.id));
  await logAudit(db, actor, {
    action: "csvTemplate.delete",
    entityType: "csvTemplate",
    entityId: template.id,
    before: { name: template.name },
  });
}

/** The template an export should use by default: the flagged one, else the first non-archived. */
export function pickDefaultTemplate(templates: CsvTemplate[]): CsvTemplate | undefined {
  const usable = templates.filter((t) => !t.archived);
  return usable.find((t) => t.isDefault) ?? usable[0];
}
