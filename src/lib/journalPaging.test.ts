import { describe, it, expect } from "vitest";
import { SHOW_ALL, pageWindow } from "./journalPaging";

describe("pageWindow", () => {
  it("opens on the last page, where today's work is", () => {
    // 63 orders, 50 to a page: the journal lands on page 2, showing 51–63.
    expect(pageWindow(63, 50, null)).toEqual({
      page: 2,
      totalPages: 2,
      from: 51,
      to: 63,
      olderCount: 50,
      newerCount: 0,
    });
  });

  it("reports what is hidden above, which is the count the manager is missing", () => {
    expect(pageWindow(63, 50, null).olderCount).toBe(50);
    expect(pageWindow(200, 25, null).olderCount).toBe(175);
  });

  it("counts both sides in the middle of the ledger", () => {
    const w = pageWindow(100, 25, 2);
    expect(w).toMatchObject({ page: 2, from: 26, to: 50, olderCount: 25, newerCount: 50 });
  });

  it("hides nothing on the first page of a short ledger", () => {
    expect(pageWindow(12, 50, null)).toEqual({
      page: 1,
      totalPages: 1,
      from: 1,
      to: 12,
      olderCount: 0,
      newerCount: 0,
    });
  });

  it("puts the whole ledger on one page for Барлығы", () => {
    expect(pageWindow(237, SHOW_ALL, null)).toEqual({
      page: 1,
      totalPages: 1,
      from: 1,
      to: 237,
      olderCount: 0,
      newerCount: 0,
    });
  });

  it("survives an empty ledger without inventing a row", () => {
    expect(pageWindow(0, 50, null)).toEqual({
      page: 1,
      totalPages: 1,
      from: 0,
      to: 0,
      olderCount: 0,
      newerCount: 0,
    });
    expect(pageWindow(0, SHOW_ALL, null)).toMatchObject({ from: 0, to: 0 });
  });

  it("clamps a pinned page that the list has shrunk out from under", () => {
    // Was on page 4, then a filter cut the ledger to 30 rows.
    expect(pageWindow(30, 25, 4)).toMatchObject({ page: 2, from: 26, to: 30 });
  });

  it("clamps a nonsense page rather than producing a negative slice", () => {
    expect(pageWindow(30, 25, 0)).toMatchObject({ page: 1, from: 1, to: 25 });
    expect(pageWindow(30, 25, -5)).toMatchObject({ page: 1, from: 1, to: 25 });
  });

  it("fills exactly when the total divides evenly", () => {
    expect(pageWindow(50, 25, null)).toMatchObject({ page: 2, from: 26, to: 50, olderCount: 25, newerCount: 0 });
  });

  it("treats a zero-length page as one row rather than dividing by nothing", () => {
    // Not reachable from the UI, but a stored page size of 1 must not loop or NaN.
    expect(pageWindow(3, 1, null)).toMatchObject({ page: 3, from: 3, to: 3, olderCount: 2 });
  });

  it("adds up: what is shown plus what is hidden is the whole ledger", () => {
    for (const [total, size, pinned] of [[63, 50, null], [200, 25, 3], [7, 25, null], [0, 50, null]] as const) {
      const w = pageWindow(total, size, pinned);
      const shown = w.to === 0 ? 0 : w.to - w.from + 1;
      expect(w.olderCount + shown + w.newerCount).toBe(total);
    }
  });
});
