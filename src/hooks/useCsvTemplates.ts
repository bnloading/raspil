import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { pickDefaultTemplate } from "../lib/csvTemplates";
import type { CsvTemplate } from "../types/domain";

/** Named cutting-program export formats. Readable by Admin and Manager (see firestore.rules). */
export function useCsvTemplates() {
  const [templates, setTemplates] = useState<CsvTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "csvTemplates"),
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<CsvTemplate, "id">) }));
        setTemplates(list.sort((a, b) => a.name.localeCompare(b.name, "kk")));
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, []);

  const active = useMemo(() => templates.filter((t) => !t.archived), [templates]);
  const defaultTemplate = useMemo(() => pickDefaultTemplate(templates), [templates]);

  return { templates, active, defaultTemplate, loading };
}
