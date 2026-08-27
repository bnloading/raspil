import { useState } from "react";

const QUICK_MINUTES = [5, 10, 15, 20, 30];

/**
 * Shared "how long will this take" picker used by both the cutting and PVC start/re-estimate
 * flows: five quick-pick buttons (spec: 5/10/15/20/30 minutes) plus a "Басқа" (custom) numeric
 * fallback. Purely a controlled-input UI piece — the caller decides what onConfirm does
 * (startCutting/updateCuttingEstimate/startPvc/updatePvcEstimate).
 */
export function DurationPicker({
  onConfirm,
  onCancel,
  confirmLabel,
  busy,
}: {
  onConfirm: (minutes: number) => void;
  onCancel: () => void;
  confirmLabel: string;
  busy?: boolean;
}) {
  const [custom, setCustom] = useState("");

  const submitCustom = () => {
    const n = parseInt(custom, 10);
    if (!Number.isFinite(n) || n <= 0) return;
    onConfirm(n);
  };

  return (
    <div className="wizard-actions">
      {QUICK_MINUTES.map((m) => (
        <button
          key={m}
          type="button"
          className="btn btn-outline btn-sm"
          disabled={busy}
          onClick={() => onConfirm(m)}
        >
          {m} минут
        </button>
      ))}
      <input
        type="number"
        className="estimated-time-input"
        placeholder="Басқа (мин)"
        value={custom}
        min={1}
        onChange={(e) => setCustom(e.target.value)}
      />
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !custom} onClick={submitCustom}>
        {confirmLabel}
      </button>
      <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={onCancel}>
        Болдырмау
      </button>
    </div>
  );
}
