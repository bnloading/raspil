import { type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { Spinner } from "./components";
import type { UserRole } from "./types/domain";
import { roleHome } from "./lib/rbac";

/**
 * Central auth/role guard — replaces the "redirect if not authed/wrong role" useEffect that used
 * to be copy-pasted into every page (Admin.tsx, Worker.tsx, Setup.tsx each had their own copy).
 */
export function RouteGuard({
  roles,
  children,
}: {
  roles?: UserRole[];
  children: ReactNode;
}) {
  const { user, userData, loading } = useAuth();

  if (loading) return <Spinner />;
  if (!user || !userData) return <Navigate to="/login" replace />;
  if (userData.blocked) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(userData.role)) {
    return <Navigate to={roleHome(userData.role)} replace />;
  }
  return <>{children}</>;
}
