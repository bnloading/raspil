import { describe, it, expect } from "vitest";
import {
  formatDateDMY,
  formatRelativeDateTime,
  monthKey,
  bucketByPeriod,
  monthLabel,
  weekKey,
  weekLabel,
} from "./dates";

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

describe("weekKey", () => {
  const at = (iso: string) => new Date(`${iso}T12:00:00+05:00`);

  it("keys by the Monday that starts the Almaty week", () => {
    expect(weekKey(at("2026-08-31"))).toBe("2026-08-31"); // 31 Aug 2026 is itself a Monday
  });

  it("groups every day of the same week under that Monday", () => {
    const monday = weekKey(at("2026-08-31"));
    expect(weekKey(at("2026-09-01"))).toBe(monday); // Tuesday
    expect(weekKey(at("2026-09-03"))).toBe(monday); // Thursday
    expect(weekKey(at("2026-09-06"))).toBe(monday); // Sunday, still this week
    expect(weekKey(at("2026-09-07"))).not.toBe(monday); // next Monday
  });
});

describe("weekLabel", () => {
  it("reads as one range within a single month", () => {
    // 2026-08-04 is a Tuesday; its Monday is 2026-08-03, week ends 2026-08-09.
    expect(weekLabel(weekKey(new Date("2026-08-04T12:00:00+05:00")))).toBe("3–9 там");
  });

  it("names both months when the week crosses one", () => {
    expect(weekLabel("2026-08-31")).toBe("31 там – 6 қыр");
  });
});

describe("formatRelativeDateTime", () => {
  // Almaty is UTC+5, so these UTC instants are the Almaty times named beside them.
  const now = Date.UTC(2026, 8, 2, 7, 0, 0); // 02.09.2026 12:00 Almaty

  it("says бүгін for something changed earlier today", () => {
    expect(formatRelativeDateTime(Date.UTC(2026, 8, 2, 5, 24), now)).toBe("бүгін, 10:24");
  });

  it("says кеше for yesterday, whatever the hour", () => {
    expect(formatRelativeDateTime(Date.UTC(2026, 8, 1, 10, 30), now)).toBe("кеше, 15:30");
    expect(formatRelativeDateTime(Date.UTC(2026, 8, 1, 15, 5), now)).toBe("кеше, 20:05");
  });

  it("falls back to a date without the year for anything older", () => {
    expect(formatRelativeDateTime(Date.UTC(2026, 7, 31, 4, 15), now)).toBe("31.08, 09:15");
  });

  it("uses the Almaty calendar day, not the viewer's", () => {
    // 22:30 UTC on the 1st is 03:30 Almaty on the 2nd — today, not yesterday.
    expect(formatRelativeDateTime(Date.UTC(2026, 8, 1, 22, 30), now)).toBe("бүгін, 03:30");
  });

  it("accepts a Firestore-shaped timestamp", () => {
    expect(formatRelativeDateTime({ seconds: Date.UTC(2026, 8, 2, 5, 24) / 1000 }, now))
      .toBe("бүгін, 10:24");
  });
});
