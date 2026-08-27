import { describe, it, expect } from "vitest";
import { formatDateDMY, monthKey, bucketByPeriod, monthLabel } from "./dates";

describe("formatDateDMY", () => {
  it("formats as DD.MM.YYYY", () => {
    // 2026-03-05T12:00:00Z is still 2026-03-05 in Asia/Almaty (UTC+5)
    const d = new Date(Date.UTC(2026, 2, 5, 12, 0, 0));
    expect(formatDateDMY(d)).toBe("05.03.2026");
  });
});

describe("monthly bucketing is dynamic, not hardcoded", () => {
  it("produces a bucket for whatever month the data actually falls in", () => {
    const events = [
      { at: new Date(Date.UTC(2026, 0, 15)) }, // Jan 2026
      { at: new Date(Date.UTC(2026, 0, 20)) }, // Jan 2026
      { at: new Date(Date.UTC(2026, 1, 3)) },  // Feb 2026
    ];
    const buckets = bucketByPeriod(events, (e) => e.at, "month");
    expect([...buckets.keys()]).toEqual(["2026-01", "2026-02"]);
    expect(buckets.get("2026-01")).toHaveLength(2);
  });

  it("a brand-new month with no prior code changes still appears once data exists", () => {
    // Simulates "the app has been running and August 2026 just started" — no month list is
    // hardcoded anywhere; the bucket set comes purely from the timestamps passed in.
    const events = [{ at: new Date(Date.UTC(2026, 7, 1)) }]; // Aug 2026
    const buckets = bucketByPeriod(events, (e) => e.at, "month");
    expect([...buckets.keys()]).toEqual([monthKey(events[0].at)]);
    expect(monthKey(events[0].at)).toBe("2026-08");
  });

  it("buckets are sorted ascending regardless of input order", () => {
    const events = [
      { at: new Date(Date.UTC(2026, 5, 1)) },
      { at: new Date(Date.UTC(2026, 0, 1)) },
      { at: new Date(Date.UTC(2026, 2, 1)) },
    ];
    const buckets = bucketByPeriod(events, (e) => e.at, "month");
    expect([...buckets.keys()]).toEqual(["2026-01", "2026-03", "2026-06"]);
  });
});

describe("monthLabel", () => {
  it("renders a Kazakh month name with year", () => {
    expect(monthLabel("2026-01")).toBe("Қаңтар 2026");
  });
});
