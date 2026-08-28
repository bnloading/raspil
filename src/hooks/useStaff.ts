import { useEffect, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import type { UserDoc, UserRole } from "../types/domain";

export interface StaffMember extends UserDoc {
  id: string;
}

/**
 * The staff this viewer is allowed to list.
 *
 * firestore.rules scopes a Manager's `list` on /users to `role in ['raspil','pvh']`, so the query
 * has to match: a list query fails entirely if any candidate document would be denied, and asking
 * for managers too would break the whole thing rather than just omitting them. An Admin may see
 * managers as well, so the role filter widens for them.
 */
export function useStaff() {
  const { userData } = useAuth();
  const role = userData?.role;
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!role) return;
    const roles: UserRole[] = role === "admin" ? ["manager", "raspil", "pvh"] : ["raspil", "pvh"];
    getDocs(query(collection(db, "users"), where("role", "in", roles)))
      .then((snap) => {
        setStaff(snap.docs.map((d) => ({ id: d.id, ...(d.data() as UserDoc) })));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [role]);

  return { staff, loading };
}
