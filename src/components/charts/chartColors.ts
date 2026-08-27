// Single place that knows the `--chart-*` CSS custom-property token names, so the dashboard's
// donut legend colors (computed in src/lib/dashboardStats.ts) and the chart components below
// never drift out of sync.

export const CHART_COLOR_TOKENS = {
  green: "--chart-green",
  blue: "--chart-blue",
  amber: "--chart-amber",
  red: "--chart-red",
  gray: "--chart-gray",
  line: "--chart-line",
  area: "--chart-area",
  grid: "--chart-grid",
  track: "--chart-track",
} as const;

export type ChartColorToken = keyof typeof CHART_COLOR_TOKENS;

/**
 * Returns `var(--token-name)` for direct use as an SVG fill/stroke/inline-style value. All
 * consumers in this app are SVG/inline-style, so the raw `var()` reference is sufficient — no
 * getComputedStyle resolution to a hex value is needed.
 */
export function getCssVar(name: string): string {
  return `var(${name})`;
}
