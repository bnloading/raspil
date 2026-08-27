import type { PaymentStatus, ProductionStatus } from "../types/domain";
import {
  PAYMENT_STATUS_COLOR,
  PAYMENT_STATUS_LABELS,
  PRODUCTION_STATUS_COLOR,
  PRODUCTION_STATUS_LABELS,
} from "../lib/statuses";

export function ProductionStatusBadge({ status }: { status: ProductionStatus }) {
  return (
    <span className={`badge badge-${PRODUCTION_STATUS_COLOR[status]}`}>
      {PRODUCTION_STATUS_LABELS[status]}
    </span>
  );
}

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return (
    <span className={`badge badge-${PAYMENT_STATUS_COLOR[status]}`}>
      {PAYMENT_STATUS_LABELS[status]}
    </span>
  );
}
