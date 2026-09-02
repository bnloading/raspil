/**
 * Which slice of the ledger is on screen, and what is hidden either side of it.
 *
 * The journal runs oldest first, like the paper book it replaced, and opens on the LAST page so
 * the manager lands on today's work rather than on the day the shop opened. That is the right
 * default and it was also quietly confusing: with fifty rows to a page, opening the journal on
 * page two showed thirteen orders and everything older sat behind a pager at the bottom of the
 * screen, which reads as "my old orders are gone" rather than "there is another page".
 *
 * So the window now reports what it is hiding, and the table says so in a row of its own.
 */

/** The "Барлығы" page size — one page holding everything. */
export const SHOW_ALL = 0;

export interface PageWindow {
  /** 1-based and clamped into range, so a pinned page survives the list shrinking under it. */
  page: number;
  totalPages: number;
  /** 1-based index of the first row shown; 0 when there is nothing to show. */
  from: number;
  /** 1-based index of the last row shown; 0 when there is nothing to show. */
  to: number;
  /** Rows above the window — older orders, since the ledger runs oldest first. */
  olderCount: number;
  /** Rows below the window — newer orders. */
  newerCount: number;
}

export function pageWindow(total: number, pageSize: number, pinnedPage: number | null): PageWindow {
  // max(total, 1) keeps the arithmetic sane on an empty ledger, where every count is zero anyway.
  const size = pageSize === SHOW_ALL ? Math.max(total, 1) : Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(total / size));
  // Null means "wherever the newest rows are", which is the last page.
  const page = Math.min(Math.max(pinnedPage ?? totalPages, 1), totalPages);

  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = total === 0 ? 0 : Math.min(page * size, total);

  return {
    page,
    totalPages,
    from,
    to,
    olderCount: total === 0 ? 0 : from - 1,
    newerCount: total === 0 ? 0 : total - to,
  };
}
