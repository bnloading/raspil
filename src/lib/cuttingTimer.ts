/**
 * The countdown a cutter watches while a line is on the saw.
 *
 * Starting a line already records how long it was estimated to take and when it is therefore due
 * (`cuttingStartedAt`, `cuttingEstimatedMinutes`, `cuttingExpectedCompletionAt` — see
 * lib/orderStatus.ts). Until now the card printed the due time as a date and left the arithmetic
 * to the person holding the sheet: "Мерзімі: 02.09.2026 14:30" answers "when", never "how long
 * have I got". A running clock answers the question actually being asked, and keeps answering it
 * after the estimate runs out, which is when it matters most.
 *
 * Nothing here decides anything — the line is finished when the cutter presses Дайын and counts
 * the sheets, exactly as before. This only tells them where they are.
 */

export interface TimerReading {
  /** Since the saw started, never negative even if a clock is skewed. */
  elapsedSeconds: number;
  /** Until the estimate runs out; negative once it has. */
  remainingSeconds: number;
  overdue: boolean;
  /** How far through the estimate, 0..1 and clamped — for the bar. */
  progress: number;
  /** "12:34" while there is time left, "+05:12" once there is not. */
  label: string;
  /** What the label means, so the colour is never the only thing saying it. */
  caption: string;
}

/**
 * "05:09", or "1:12:30" once it passes an hour.
 *
 * Minutes are padded but hours are not, so the common case reads as a stopwatch rather than as a
 * timestamp. Negative input is treated as zero: the sign belongs to the caller's label, not here.
 */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Where a running line is, right now.
 *
 * `expectedAtMs` is optional because a line started before estimates were recorded has no due
 * time. That is not an error and must not read as "overdue" — the clock simply counts up, which
 * is still more use than nothing.
 */
export function readCuttingTimer(
  startedAtMs: number,
  expectedAtMs: number | null,
  nowMs: number,
): TimerReading {
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));

  if (expectedAtMs === null) {
    return {
      elapsedSeconds,
      remainingSeconds: 0,
      overdue: false,
      progress: 0,
      label: formatClock(elapsedSeconds),
      caption: "Басталды",
    };
  }

  const remainingSeconds = Math.floor((expectedAtMs - nowMs) / 1000);
  const overdue = remainingSeconds < 0;
  const totalSeconds = Math.max(1, Math.floor((expectedAtMs - startedAtMs) / 1000));

  return {
    elapsedSeconds,
    remainingSeconds,
    overdue,
    progress: Math.min(1, Math.max(0, elapsedSeconds / totalSeconds)),
    label: overdue ? `+${formatClock(-remainingSeconds)}` : formatClock(remainingSeconds),
    caption: overdue ? "Мерзімнен асты" : "Қалды",
  };
}
