import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";
import type { Material, PvcType } from "../types/domain";

/**
 * `activeOnly` must be true for any non-staff caller — firestore.rules only allows non-staff to
 * read materials where active==true, and list queries must filter to match the rule (see
 * firestore.rules header note) or the whole query is rejected.
 */
export function useMaterials(activeOnly: boolean) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = activeOnly
      ? query(collection(db, "materials"), where("active", "==", true), orderBy("name", "asc"))
      : query(collection(db, "materials"), orderBy("name", "asc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: Material[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<Material, "id">) }));
        setMaterials(list);
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, [activeOnly]);

  return { materials, loading };
}

export function usePvcTypes(activeOnly: boolean) {
  const [pvcTypes, setPvcTypes] = useState<PvcType[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = activeOnly
      ? query(collection(db, "pvcTypes"), where("active", "==", true))
      : collection(db, "pvcTypes");
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: PvcType[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<PvcType, "id">) }));
        setPvcTypes(list);
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, [activeOnly]);

  return { pvcTypes, loading };
}
