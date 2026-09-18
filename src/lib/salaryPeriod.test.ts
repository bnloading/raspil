import { describe, it, expect } from "vitest";
import {
  currentPeriodKey,
  periodContains,
  periodContainsDay,
  periodKindOf,
  periodLabel,
  salaryPeriodKind,
  shiftPeriod,
} from "./salaryPeriod";

/** Noon Almaty, so nothing here can be moved across a day by the timezone offset. */
const at = (day: string) => new Date(`${day}T12:00:00+05:00`);

describe("salaryPeriodKind — who is paid weekly", () => {
  it("settles распил every week", () => {
    expect(salaryPeriodKind("raspil")).toBe("week");
  });

  it("leaves every other station on the month", () => {
    for (const role of ["pvh", "cnc", "sanding", "painting", "vacuum", "manager", "admin"] as const) {
      expect(salaryPeriodKind(role)).toBe("month");
    }
    expect(salaryPeriodKind(undefined)).toBe("month");
  });
});

describe("periodKindOf — reading a key's shape", () => {
  it("tells a month from a week by the key alone, with no stored flag", () => {
    expect(periodKindOf("2026-09")).toBe("month");
    expect(periodKindOf("2026-09-14")).toBe("week");
  });
});

describe("periodContains", () => {
  it("holds Monday through Sunday, and nothing either side", () => {
    // 2026-09-14 is a Monday; the week it opens ends Sunday 2026-09-20.
    expect(periodContains("2026-09-14", at("2026-09-14"))).toBe(true);
    expect(periodContains("2026-09-14", at("2026-09-20"))).toBe(true);
    expect(periodContains("2026-09-14", at("2026-09-13"))).toBe(false);
    expect(periodContains("2026-09-14", at("2026-09-21"))).toBe(false);
  });

  it("still reads a month key exactly as before", () => {
    expect(periodContains("2026-09", at("2026-09-01"))).toBe(true);
    expect(periodContains("2026-09", at("2026-09-30"))).toBe(true);
    expect(periodContains("2026-09", at("2026-08-31"))).toBe(false);
  });

  it("keeps a week that straddles two months whole", () => {
    // Mon 28 Sep – Sun 4 Oct: the cutter's week does not end because the month does.
    expect(periodContains("2026-09-28", at("2026-09-30"))).toBe(true);
    expect(periodContains("2026-09-28", at("2026-10-04"))).toBe(true);
  });
});

describe("periodContainsDay — attendance keys", () => {
  it("bounds a week inclusively at both ends", () => {
    expect(periodContainsDay("2026-09-14", "2026-09-14")).toBe(true);
    expect(periodContainsDay("2026-09-14", "2026-09-20")).toBe(true);
    expect(periodContainsDay("2026-09-14", "2026-09-21")).toBe(false);
    expect(periodContainsDay("2026-09-14", "2026-09-13")).toBe(false);
  });

  it("matches a month by prefix", () => {
    expect(periodContainsDay("2026-09", "2026-09-30")).toBe(true);
    expect(periodContainsDay("2026-09", "2026-10-01")).toBe(false);
  });
});

describe("shiftPeriod", () => {
  it("steps a week by exactly seven days, month boundaries included", () => {
    expect(shiftPeriod("2026-09-14", -1)).toBe("2026-09-07");
    expect(shiftPeriod("2026-09-14", 1)).toBe("2026-09-21");
    expect(shiftPeriod("2026-09-28", 1)).toBe("2026-10-05");
    expect(shiftPeriod("2026-01-05", -1)).toBe("2025-12-29");
  });

  it("steps a month by one month, year boundaries included", () => {
    expect(shiftPeriod("2026-09", 1)).toBe("2026-10");
    expect(shiftPeriod("2026-01", -1)).toBe("2025-12");
    expect(shiftPeriod("2026-12", 1)).toBe("2027-01");
  });
});

describe("currentPeriodKey and periodLabel", () => {
  it("puts a Wednesday in the week its Monday opened", () => {
    expect(currentPeriodKey("week", at("2026-09-16"))).toBe("2026-09-14");
    expect(currentPeriodKey("month", at("2026-09-16"))).toBe("2026-09");
  });

  it("labels each period the way its own page reads it", () => {
    expect(periodLabel("2026-09-14")).toBe("14–20 қыр");
    expect(periodLabel("2026-09")).toContain("2026");
  });
});
