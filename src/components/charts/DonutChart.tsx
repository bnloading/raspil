/** Minimal hand-rolled SVG donut chart — no charting library dependency, mirrors BarChart.tsx's conventions. */
interface DonutChartProps {
  data: { label: string; value: number; color: string }[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string | number;
  legend?: boolean;
}

export function DonutChart({
  data,
  size = 180,
  thickness = 22,
  centerLabel,
  centerValue,
  legend = true,
}: DonutChartProps) {
  const total = data.reduce((s, d) => s + d.value, 0);

  if (data.length === 0 || total <= 0) {
    return <p className="chart-empty">Дерек жоқ</p>;
  }

  const strokeWidth = thickness * (100 / size);
  const nonZero = data.filter((d) => d.value > 0);
  const percents = nonZero.map((d) => (d.value / total) * 100);
  const slices = nonZero.map((d, i) => ({
    ...d,
    percent: percents[i],
    offset: -percents.slice(0, i).reduce((s, p) => s + p, 0),
  }));

  return (
    <div className="donut-chart-wrap">
      <div className="donut-chart-svg-wrap" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" width={size} height={size}>
          <circle r="42" cx="50" cy="50" fill="none" stroke="var(--chart-track)" strokeWidth={strokeWidth} />
          <g transform="rotate(-90 50 50)">
            {slices.map((s, i) => (
              <circle
                key={i}
                r="42"
                cx="50"
                cy="50"
                fill="none"
                stroke={s.color}
                strokeWidth={strokeWidth}
                strokeLinecap="butt"
                pathLength={100}
                strokeDasharray={`${s.percent} ${100 - s.percent}`}
                strokeDashoffset={s.offset}
              >
                <title>
                  {s.label}: {s.value} ({Math.round(s.percent)}%)
                </title>
              </circle>
            ))}
          </g>
        </svg>
        {(centerLabel !== undefined || centerValue !== undefined) && (
          <div className="donut-center">
            {centerValue !== undefined && <div className="value">{centerValue}</div>}
            {centerLabel !== undefined && <div className="label">{centerLabel}</div>}
          </div>
        )}
      </div>
      {legend && (
        <div className="chart-legend">
          {data.map((d, i) => (
            <div key={i} className="chart-legend-row">
              <span className="legend-dot" style={{ background: d.color }} />
              <span>{d.label}</span>
              <strong>
                {d.value} ({total > 0 ? Math.round((d.value / total) * 100) : 0}%)
              </strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
