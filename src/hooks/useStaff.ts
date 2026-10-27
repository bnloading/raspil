import { useEffect, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { departmentOf } from "../lib/rbac";
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
 *
 * Only the viewer's own line: ЛДСП and МДФ run as two businesses (lib/rbac.ts departmentOf()), so
 * an advance, a payout from Касса or a salary on one side never offers the other side's people.
 */
export function useStaff() {
  const { userData } = useAuth();
  const role = userData?.role;
  const department = userData ? departmentOf(userData) : "ldsp";
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!role) return;
    const staffRoles: UserRole[] = ["raspil", "pvh", "cnc", "sanding", "painting", "vacuum"];
    const roles: UserRole[] = role === "admin" ? ["manager", ...staffRoles] : staffRoles;
    getDocs(query(collection(db, "users"), where("role", "in", roles)))
      .then((snap) => {
        setStaff(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as UserDoc) }))
            .filter((member) => departmentOf(member) === department),
        );
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [role, department]);

  return { staff, loading };
}
