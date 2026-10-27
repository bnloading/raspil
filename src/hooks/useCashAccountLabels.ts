import { useAuth } from "../AuthContext";
import { cashAccountHints, cashAccountLabels } from "../lib/cashbox";
import { departmentOf } from "../lib/rbac";

/** The viewer's own line's names for the Касса pots — «Ахжол» on МДФ where ЛДСП says «Нұр». */
export function useCashAccountLabels() {
  const { userData } = useAuth();
  const department = userData ? departmentOf(userData) : "ldsp";
  return { labels: cashAccountLabels(department), hints: cashAccountHints(department) };
}
