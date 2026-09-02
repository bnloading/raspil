import { describe, it, expect } from "vitest";
import { offsetFromDateHeader, requestMidpoint } from "./serverClock";

describe("offsetFromDateHeader", () => {
  const device = Date.UTC(2026, 8, 2, 12, 0, 0);

  it("measures how far ahead the server is", () => {
    // Device says 12:00:00, server says 12:10:00 — the device is ten minutes behind.
    expect(offsetFromDateHeader("Wed, 02 Sep 2026 12:10:00 GMT", device)).toBe(10 * 60_000);
  });

  it("measures how far behind the server is", () => {
    expect(offsetFromDateHeader("Wed, 02 Sep 2026 11:55:00 GMT", device)).toBe(-5 * 60_000);
  });

  it("is zero when the two clocks agree", () => {
    expect(offsetFromDateHeader("Wed, 02 Sep 2026 12:00:00 GMT", device)).toBe(0);
  });

  it("trusts the device rather than failing when there is no usable header", () => {
    expect(offsetFromDateHeader(null, device)).toBe(0);
    expect(offsetFromDateHeader(undefined, device)).toBe(0);
    expect(offsetFromDateHeader("", device)).toBe(0);
    expect(offsetFromDateHeader("not a date", device)).toBe(0);
  });

  it("applied to the device clock, lands on server time", () => {
    const offset = offsetFromDateHeader("Wed, 02 Sep 2026 12:10:00 GMT", device);
    expect(device + offset).toBe(Date.UTC(2026, 8, 2, 12, 10, 0));
  });
});

describe("requestMidpoint", () => {
  it("charges half the round trip, not all of it", () => {
    expect(requestMidpoint(1000, 1400)).toBe(1200);
  });

  it("is the instant itself when the reply was immediate", () => {
    expect(requestMidpoint(1000, 1000)).toBe(1000);
  });
});
