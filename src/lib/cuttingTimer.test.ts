import { describe, it, expect } from "vitest";
import { formatClock, readCuttingTimer } from "./cuttingTimer";

const MIN = 60_000;
const started = Date.UTC(2026, 8, 2, 10, 0, 0);
/** Started at 10:00, estimated 45 minutes, so it is due at 10:45. */
const expected = started + 45 * MIN;

describe("formatClock", () => {
  it("reads as a stopwatch under an hour", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(9)).toBe("00:09");
    expect(formatClock(309)).toBe("05:09");
    expect(formatClock(3599)).toBe("59:59");
  });

  it("adds an unpadded hour once it passes one", () => {
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(4350)).toBe("1:12:30");
  });

  it("treats negative time as zero — the sign belongs to the label", () => {
    expect(formatClock(-30)).toBe("00:00");
  });
});

describe("readCuttingTimer", () => {
  it("counts down from the estimate while there is time left", () => {
    const t = readCuttingTimer(started, expected, started + 10 * MIN);
    expect(t.label).toBe("35:00");
    expect(t.caption).toBe("Қалды");
    expect(t.overdue).toBe(false);
    expect(t.elapsedSeconds).toBe(600);
    expect(t.remainingSeconds).toBe(2100);
  });

  it("keeps counting once the estimate runs out, and says so", () => {
    const t = readCuttingTimer(started, expected, started + 50 * MIN);
    expect(t.label).toBe("+05:00");
    expect(t.caption).toBe("Мерзімнен асты");
    expect(t.overdue).toBe(true);
    expect(t.remainingSeconds).toBe(-300);
  });

  it("is exactly on the line at the due moment, not yet overdue", () => {
    const t = readCuttingTimer(started, expected, expected);
    expect(t.overdue).toBe(false);
    expect(t.label).toBe("00:00");
  });

  it("fills the bar from nothing to full across the estimate, then stops at full", () => {
    expect(readCuttingTimer(started, expected, started).progress).toBe(0);
    expect(readCuttingTimer(started, expected, started + 15 * MIN).progress).toBeCloseTo(1 / 3, 5);
    expect(readCuttingTimer(started, expected, expected).progress).toBe(1);
    expect(readCuttingTimer(started, expected, started + 90 * MIN).progress).toBe(1);
  });

  it("just counts up when the line was started without an estimate", () => {
    const t = readCuttingTimer(started, null, started + 7 * MIN);
    expect(t.label).toBe("07:00");
    expect(t.caption).toBe("Басталды");
    // No estimate means nothing to be late for.
    expect(t.overdue).toBe(false);
    expect(t.progress).toBe(0);
  });

  it("never reports negative elapsed time when a device clock is behind", () => {
    const t = readCuttingTimer(started, expected, started - 5 * MIN);
    expect(t.elapsedSeconds).toBe(0);
    expect(t.progress).toBe(0);
  });

  it("does not divide by zero on a zero-length estimate", () => {
    const t = readCuttingTimer(started, started, started + MIN);
    expect(Number.isFinite(t.progress)).toBe(true);
    expect(t.progress).toBe(1);
    expect(t.overdue).toBe(true);
  });
});
