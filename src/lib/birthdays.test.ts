import { describe, it, expect } from "vitest";
import { monthDayOf } from "./birthdays";

describe("monthDayOf", () => {
  it("strips the year off a YYYY-MM-DD date", () => {
    expect(monthDayOf("1998-03-15")).toBe("03-15");
  });

  it("keeps zero-padding on single-digit months and days", () => {
    expect(monthDayOf("2000-01-05")).toBe("01-05");
  });

  it("matches regardless of birth year", () => {
    expect(monthDayOf("1990-12-31")).toBe(monthDayOf("2005-12-31"));
  });
});
