// Kazakhstan date formatting (DD.MM.YYYY, Asia/Almaty) and dynamic report-period bucketing.
// Bucketing is always derived from the actual data's timestamps (or an explicit `now`), never a
// hardcoded month list, so new months/years appear automatically without a code change.

const ALMATY_TZ = "Asia/Almaty";

function toDate(input: Date | number | { seconds: number }): Date {
  if (input instanceof Date) return input;
  if (typeof input === "number") return new Date(input);
  return new Date(input.seconds * 1000);
}

export function formatDateDMY(input: Date | number | { seconds: number }): string {
  const d = toDate(input);
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: ALMATY_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

export function formatDateTimeDMY(input: Date | number | { seconds: number }): string {
  const d = toDate(input);
  const date = formatDateDMY(d);
  const time = new Intl.DateTimeFormat("ru-RU", {
    timeZone: ALMATY_TZ,
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
  return `${date}, ${time}`;
}

/** YYYY-MM-DD key in Asia/Almaty, for grouping by day. */
export function dayKey(input: Date | number | { seconds: number }): string {
  const d = toDate(input);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ALMATY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${day}`;
}

/** YYYY-MM key in Asia/Almaty, for grouping by month. */
export function monthKey(input: Date | number | { seconds: number }): string {
  return dayKey(input).slice(0, 7);
}

/** YYYY key in Asia/Almaty, for grouping by year. */
export function yearKey(input: Date | number | { seconds: number }): string {
  return dayKey(input).slice(0, 4);
}

const MONTH_LABELS = [
  "Қаңтар", "Ақпан", "Наурыз", "Сәуір", "Мамыр", "Маусым",
  "Шілде", "Тамыз", "Қыркүйек", "Қазан", "Қараша", "Желтоқсан",
];

export function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${MONTH_LABELS[parseInt(m, 10) - 1]} ${y}`;
}

/**
 * Buckets a list of items by day/week/month/year using each item's own date, then returns keys
 * sorted ascending. This is how "a new month automatically appears in reports" is satisfied: the
 * bucket set is computed from the data present, not a static calendar.
 */
export function bucketByPeriod<T>(
  items: T[],
  getDate: (item: T) => Date | number | { seconds: number } | undefined,
  granularity: "day" | "month" | "year",
): Map<string, T[]> {
  const keyFn = granularity === "day" ? dayKey : granularity === "month" ? monthKey : yearKey;
  const map = new Map<string, T[]>();
  for (const item of items) {
    const date = getDate(item);
    if (!date) continue;
    const key = keyFn(date);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return new Map([...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

export function startOfDayAlmaty(d: Date = new Date()): Date {
  const key = dayKey(d);
  return new Date(`${key}T00:00:00+05:00`);
}

export function startOfWeekAlmaty(d: Date = new Date()): Date {
  const start = startOfDayAlmaty(d);
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: ALMATY_TZ, weekday: "short" }).format(d);
  const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const idx = order.indexOf(dow);
  start.setDate(start.getDate() - (idx === -1 ? 0 : idx));
  return start;
}

export function startOfMonthAlmaty(d: Date = new Date()): Date {
  const key = monthKey(d);
  return new Date(`${key}-01T00:00:00+05:00`);
}

export function inRange(
  input: Date | number | { seconds: number } | undefined,
  from?: Date,
  to?: Date,
): boolean {
  if (!input) return false;
  const d = toDate(input);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}
