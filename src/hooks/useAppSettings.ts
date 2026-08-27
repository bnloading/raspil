import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import type { ApplicationSettings } from "../types/domain";

const DEFAULTS: ApplicationSettings = {
  cuttingPricePerSheetTiyn: 5_000_000, // documented default: 50 000 ₸ per sheet, admin-editable
  pvcThicknessOptionsMm: [0.4, 1, 2],
  companyName: "Цех Трекер",
};

export function useAppSettings() {
  const [settings, setSettings] = useState<ApplicationSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, "applicationSettings", "global"),
      (snap) => {
        setSettings(snap.exists() ? { ...DEFAULTS, ...(snap.data() as ApplicationSettings) } : DEFAULTS);
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, []);

  return { settings, loading };
}
