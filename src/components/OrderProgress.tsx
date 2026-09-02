import { orderProgress, type StepState } from "../lib/orderProgress";
import { StepIcon } from "./StageIcon";
import type { Order } from "../types/domain";

/** What each state draws inside its circle. Colour carries the meaning; the glyph repeats it. */
const GLYPH: Record<StepState, string> = {
  done: "✓",
  active: "",
  problem: "!",
  pending: "",
  skipped: "–",
};

/**
 * "Өндіріс барысы" — Төлем → Распил → ПВХ → Дайын as a connected strip.
 *
 * The connector between two circles is filled only when the step before it is finished, so the
 * eye follows a solid line up to the point where the order actually stopped.
 */
export function OrderProgress({ order, compact = false }: { order: Order; compact?: boolean }) {
  const steps = orderProgress(order);

  return (
    <div className={`oprog${compact ? " is-compact" : ""}`}>
      {steps.map((step, i) => (
        <div className="oprog-step" key={step.key}>
          {i > 0 && <span className={`oprog-line is-${steps[i - 1].state}`} aria-hidden="true" />}
          <span className={`oprog-dot is-${step.state}`} title={`${step.label}: ${step.state}`}>
            {GLYPH[step.state]}
          </span>
          {/* Icon beside the word, never instead of it — a saw is recognised faster than
              "Распил" is read, but the label is what actually says which stage this is. */}
          {!compact && (
            <span className="oprog-label">
              <StepIcon step={step.key} className="oprog-icon" />
              {step.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
