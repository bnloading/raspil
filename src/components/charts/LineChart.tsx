/** Minimal hand-rolled SVG line chart — no charting library dependency, mirrors BarChart.tsx's conventions. */
interface LineChartProps {
  data: { label: string; value: number }[];
  height?: number;
  valueFormatter?: (v: number) => string;
  area?: boolean;
  showDots?: boolean;
}

const VIEW_WIDTH = 600;
const PAD_LEFT = 44;
const PAD_RIGHT = 16;
const PAD_TOP = 16;
const PAD_BOTTOM = 16;
const GRID_LINES = 4;

export function LineChart({
  data,
  height = 240,
  valueFormatter = (v) => String(v),
  area = true,
  showDots = true,
}: LineChartProps) {
  if (data.length === 0) {
    return <p className="chart-empty">Дерек жоқ</p>;
  }

  const values = data.map((d) => d.value);
  const minVal = Math.min(0, ...values);
  const maxVal = Math.max(...values, 0);
  const range = maxVal - minVal || 1;

  const plotWidth = VIEW_WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = height - PAD_TOP - PAD_BOTTOM;
  const xDenominator = Math.max(1, data.length - 1);

  const xForIndex = (i: number) => PAD_LEFT + (i / xDenominator) * plotWidth;
  const yForValue = (v: number) => PAD_TOP + plotHeight - ((v - minVal) / range) * plotHeight;

  const points = data.map((d, i) => ({ x: xForIndex(i), y: yForValue(d.value), label: d.label, value: d.value }));
  const polylinePoints = points.map((p) => `${p.x},${p.y}`).join(" ");
  const areaPoints = `${polylinePoints} ${points[points.length - 1].x},${PAD_TOP + plotHeight} ${points[0].x},${PAD_TOP + plotHeight}`;

  const gridLines = Array.from({ length: GRID_LINES }, (_, i) => {
    const frac = i / (GRID_LINES - 1);
    const y = PAD_TOP + frac * plotHeight;
    const value = maxVal - frac * range;
    return { y, value };
  });

  const xLabelStep = data.length > 6 ? Math.ceil(data.length / 6) : 1;
  const xLabels = data.map((d, i) => (i % xLabelStep === 0 ? d.label : ""));

  return (
    <div>
      <svg className="line-chart-svg" viewBox={`0 0 ${VIEW_WIDTH} ${height}`} width="100%" height="auto">
        {gridLines.map((g, i) => (
          <g key={i}>
            <line x1={PAD_LEFT} y1={g.y} x2={VIEW_WIDTH - PAD_RIGHT} y2={g.y} stroke="var(--chart-grid)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <text x={PAD_LEFT - 6} y={g.y} textAnchor="end" dominantBaseline="middle" fontSize={9} fill="var(--text-light)">
              {valueFormatter(g.value)}
            </text>
          </g>
        ))}
        {area && (
          <polygon points={areaPoints} fill="var(--chart-area)" stroke="none" />
        )}
        <polyline
          points={polylinePoints}
          fill="none"
          stroke="var(--chart-line)"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {showDots &&
          points.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={4} fill="var(--chart-line)">
              <title>
                {p.label}: {valueFormatter(p.value)}
              </title>
            </circle>
          ))}
      </svg>
      <div className="line-chart-x-labels">
        {xLabels.map((label, i) => (
          <span key={i}>{label}</span>
        ))}
      </div>
    </div>
  );
}
