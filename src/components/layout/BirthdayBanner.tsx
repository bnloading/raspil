import { useTodaysBirthdays } from "../../hooks/useBirthdays";

/**
 * "Бүгін N-тың туған күні!" — shown at the top of every staff page (see AppShell), for whoever's
 * /birthdays entry matches today. Reads a collection every signed-in user may read (see
 * BirthdayDoc's own doc comment in types/domain.ts), but AppShell only renders this for staff —
 * a customer has no reason to be told a workshop employee's birthday.
 */
export function BirthdayBanner() {
  const names = useTodaysBirthdays();
  if (names.length === 0) return null;

  const who = names.length === 1
    ? `${names[0]}-тың`
    : `${names.slice(0, -1).join(", ")} және ${names[names.length - 1]}-тың`;

  return (
    <div className="birthday-banner" role="status">
      🎉 Бүгін {who} туған күні! Құттықтаймыз!
    </div>
  );
}
