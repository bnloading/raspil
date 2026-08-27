/** Minimal hand-rolled SVG bar chart — no charting library dependency for a handful of reports charts. */
export function BarChart({
  data,
  valueFormatter = (v) => String(v),
  height = 180,
}: {
  data: { label: string; value: number }[];
  valueFormatter?: (v: number) => string;
  height?: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const barWidth = 100 / Math.max(1, data.length);

  if (data.length === 0) {
    return <p className="chart-empty">Дерек жоқ</p>;
  }

  return (
    <div className="bar-chart" style={{ height }}>
      <div className="bar-chart-bars">
        {data.map((d, i) => (
          <div key={i} className="bar-chart-col" style={{ width: `${barWidth}%` }}>
            <div className="bar-chart-value">{valueFormatter(d.value)}</div>
            <div
              className="bar-chart-bar"
              style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }}
              title={`${d.label}: ${valueFormatter(d.value)}`}
            />
            <div className="bar-chart-label">{d.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
