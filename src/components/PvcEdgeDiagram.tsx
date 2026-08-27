import { EDGE_KEYS, EDGE_LABELS, type EdgeKey, type PartEdge } from "../types/domain";

/** Clickable rectangle: A=top, B=right, C=bottom, D=left. Selected edges are highlighted. */
export function PvcEdgeDiagram({
  edges,
  onToggle,
  size = 140,
}: {
  edges: Record<EdgeKey, PartEdge>;
  onToggle: (edge: EdgeKey) => void;
  size?: number;
}) {
  const w = size;
  const h = size * 0.7;
  const stroke = 10;

  const edgeLine: Record<EdgeKey, { x1: number; y1: number; x2: number; y2: number }> = {
    A: { x1: 0, y1: 0, x2: w, y2: 0 },
    B: { x1: w, y1: 0, x2: w, y2: h },
    C: { x1: w, y1: h, x2: 0, y2: h },
    D: { x1: 0, y1: h, x2: 0, y2: 0 },
  };

  return (
    <div className="pvc-edge-diagram" role="group" aria-label="ПВХ жиектерін таңдау">
      <svg viewBox={`${-stroke} ${-stroke} ${w + stroke * 2} ${h + stroke * 2}`} width={size} height={size * 0.7 + stroke * 2}>
        <rect x={0} y={0} width={w} height={h} fill="var(--card)" stroke="var(--border)" strokeWidth={1} />
        {EDGE_KEYS.map((edge) => {
          const line = edgeLine[edge];
          const selected = edges[edge]?.pvc;
          return (
            <line
              key={edge}
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke={selected ? "var(--accent)" : "var(--border)"}
              strokeWidth={stroke}
              strokeLinecap="round"
              className="pvc-edge-line"
              onClick={() => onToggle(edge)}
              role="button"
              aria-pressed={!!selected}
              aria-label={`${EDGE_LABELS[edge]}${selected ? " — ПВХ таңдалды" : ""}`}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle(edge);
                }
              }}
            />
          );
        })}
      </svg>
      <div className="pvc-edge-legend">
        {EDGE_KEYS.map((edge) => (
          <button
            key={edge}
            type="button"
            className={`pvc-edge-chip${edges[edge]?.pvc ? " selected" : ""}`}
            onClick={() => onToggle(edge)}
          >
            {edge} — {EDGE_LABELS[edge]}
          </button>
        ))}
      </div>
    </div>
  );
}
