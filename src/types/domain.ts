// Domain types for the cutting-workshop management system.
// Money fields are integer tiyn (1 ₸ = 100 tiyn) to avoid float rounding issues — see src/lib/money.ts.

import type { Timestamp } from "firebase/firestore";

/** Role strings match existing Firestore user docs — 'raspil'/'pvh' are kept as-is (not renamed) so existing accounts keep working. 'manager' is new: processes/prices/queues orders but cannot manage users or delete audit history (see src/lib/rbac.ts). */
export type UserRole = "admin" | "manager" | "raspil" | "pvh" | "customer";

export interface UserDoc {
  name: string;
  phone: string;
  email?: string;
  authEmail: string; // the identifier actually used with Firebase Auth (real email for staff, synthesized for customers)
  role: UserRole;
  blocked: boolean;
  createdAt?: Timestamp;
}

export type GrainDirection = "vertical" | "horizontal" | "any";
export type EdgeKey = "A" | "B" | "C" | "D";
export const EDGE_KEYS: EdgeKey[] = ["A", "B", "C", "D"];
export const EDGE_LABELS: Record<EdgeKey, string> = {
  A: "Жоғарғы жақ",
  B: "Оң жақ",
  C: "Төменгі жақ",
  D: "Сол жақ",
};

export interface PartEdge {
  pvc: boolean;
  pvcTypeId?: string;
  note?: string;
}

export interface CuttingPart {
  id: string;
  name: string;
  lengthMm: number;
  widthMm: number;
  qty: number;
  grainDirection: GrainDirection;
  rotationAllowed: boolean;
  materialId?: string;
  note?: string;
  edges: Record<EdgeKey, PartEdge>;
}

/**
 * What kind of sheet this is. Drives piece-rate pay, which differs per category (a cutter earns
 * more per ЛДСП sheet than per ХДФ), so it cannot be inferred from the name alone.
 */
export type MaterialCategory = "ldsp" | "hdf" | "countertop" | "other";

export const MATERIAL_CATEGORY_LABELS: Record<MaterialCategory, string> = {
  ldsp: "ЛДСП",
  hdf: "ХДФ",
  countertop: "Столешница",
  other: "Басқа",
};

export interface Material {
  id: string;
  name: string;
  /** Defaults to "ldsp" for materials created before categories existed. */
  category?: MaterialCategory;
  article: string;
  color: string;
  manufacturer?: string;
  thicknessMm: number;
  sheetLengthMm: number;
  sheetWidthMm: number;
  sellingPriceTiyn: number;
  initialQty: number;
  qtyOnHand: number; // physical full sheets currently in the warehouse (includes reserved)
  reservedQty: number; // subset of qtyOnHand earmarked for approved-but-not-yet-cut orders
  minStock: number;
  active: boolean;
  archived: boolean;
  imageUrl?: string;
  note?: string;
  grainDirectionRequired: boolean;
  createdAt?: Timestamp;
}

/** Admin-only collection, split out of `materials` because Firestore rules cannot redact individual fields per-role. */
export interface MaterialCost {
  purchasePriceTiyn: number;
}

/** One sheet type inside a multi-material order (see Order.items). */
export interface OrderMaterialLine {
  materialId: string;
  materialName: string;
  sheetQty: number;
  sheetPriceTiyn: number;
  pvcMeters: number;
  pvcPricePerMeterTiyn: number;
}

/** One colour's consumption on a single order (see Order.pvcByType). */
export interface PvcUsage {
  pvcTypeId: string;
  colorName: string;
  thicknessMm: number;
  meters: number;
  costTiyn: number;
}

export interface PvcType {
  id: string;
  thicknessMm: number;
  colorName: string;
  pricePerMeterTiyn: number;
  active: boolean;
}

export interface PaymentMethodDef {
  id: string;
  name: string;
  active: boolean;
  isMixed: boolean;
}

/** Admin-managed monthly-income allocation config — e.g. "5% of revenue goes to equipment upkeep". */
export interface ExpenseCategory {
  id: string;
  name: string; // e.g. "Станок", "Жалақы", "Жалдау ақысы"
  percentage: number; // 0-100, this category's share of monthly revenue
  active: boolean;
  createdAt?: Timestamp;
}

/**
 * The single master workflow-stage field (spec: "INTERNAL ORDER STATUSES"). Deliberately includes
 * payment-shaped stages (waiting_payment/partially_paid/paid) alongside pure production stages —
 * this is the *workflow position*, kept in sync with (but not a replacement for) the independent
 * `paymentStatus` field below, which is always derived purely from paidTiyn vs totalTiyn.
 */
export type ProductionStatus =
  | "draft" // Черновик
  | "submitted" // Жіберілді
  | "manager_review" // Менеджер тексеріп жатыр
  | "price_calculated" // Бағасы есептелді
  | "waiting_payment" // Төлем күтілуде
  | "partially_paid" // Жартылай төленді
  | "paid" // Төленді
  | "cutting_queue" // Распил кезегінде
  | "cutting_started" // Распил басталды
  | "cutting_completed" // Распил аяқталды
  | "pvc_queue" // ПВХ кезегінде
  | "pvc_started" // ПВХ басталды
  | "pvc_completed" // ПВХ аяқталды
  | "ready" // Дайын
  | "delivered" // Клиентке берілді
  | "cancelled"; // Бас тартылды

/** Always derived from paidTiyn vs totalTiyn (src/lib/statuses.ts computePaymentStatus) — never set by hand. */
export type PaymentStatus = "unpaid" | "partial" | "paid" | "overpaid" | "refunded";

export interface Order {
  id: string;
  orderNumber: string;
  customerId?: string;
  customerName: string;
  customerPhone: string;
  /**
   * Where the sheet comes from. "shop" = bought from us (materialId points at our catalogue);
   * "customer" = the customer brings their own, so there is no catalogue entry and no material
   * cost — only the name they gave, which the Manager prices manually.
   */
  materialSource?: "shop" | "customer";
  /** Free-text sheet name when materialSource is "customer". */
  customerMaterialName?: string;

  /** Primary/default material for parts that don't specify their own — see CuttingPart.materialId
   *  for the multi-material case (e.g. ЛДСП parts + a separate ХДФ part in one order).
   *  Empty string when the customer supplies their own sheet. */
  materialId: string;
  materialSnapshot: {
    name: string;
    article: string;
    color: string;
    thicknessMm: number;
    sheetLengthMm: number;
    sheetWidthMm: number;
    sellingPriceTiyn: number;
  };
  productionStatus: ProductionStatus;
  paymentStatus: PaymentStatus;
  priority: number;
  /** Order number of the order immediately ahead of this one in the "queued" list (denormalized by
   *  AdminOrders' queue-reorder save so a customer can see "which order is ahead of me" without a
   *  cross-order Firestore query their own security rules would deny). Null once at the front. */
  queueAheadOrderNumber?: string | null;

  assignedManagerId?: string;
  assignedManagerName?: string;
  managerAcceptedAt?: Timestamp;
  assignedCutterId?: string;
  assignedCutterName?: string;
  assignedPvcId?: string;
  assignedPvcName?: string;

  estimatedSheets: number;
  confirmedSheets?: number;
  pvcMetersTotal: number;
  /** Blended PVC rate (₸/m, in tiyn) for this order as a whole. The per-part breakdown in
   *  `parts[].edges[].pvcTypeId` stays the source of truth for orders built through OrderBuilder;
   *  this is what the Manager journal edits directly for walk-in orders typed straight into the
   *  ledger, where there is no per-part edge data to derive a rate from. */
  pvcPricePerMeterTiyn?: number;
  /**
   * Metres of each PVC colour this order consumed, denormalized from `parts[].edges[].pvcTypeId`
   * when the order is submitted.
   *
   * Kept on the order so "how much of each colour went out this month" is answerable by reading
   * orders alone, instead of fanning out to every order's `parts` subcollection. Absent on orders
   * created before this existed and on walk-in orders typed straight into the journal, which carry
   * only a blended metre total with no colour attached — see lib/pvcUsage.ts for how both are
   * reported rather than silently dropped.
   */
  pvcByType?: PvcUsage[];
  /**
   * Material lines when one order covers several sheet types — "5 лист Ақ + 3 лист ХДФ + 5 лист
   * Кашемир" is one order to the customer and one job to the cutter, even though the journal is
   * a row-per-material ledger and produced it as several rows.
   *
   * Absent, or a single entry, means the order is exactly what materialId/materialSnapshot say —
   * which is every order created before merging existed, so those keep working untouched.
   */
  items?: OrderMaterialLine[];
  /**
   * Set when this order was folded into another by the journal's "Біріктіру". The row is cancelled
   * rather than deleted — a number quoted to a customer should stay findable, and this app does not
   * delete financial records — but it is no longer separate business, so the ledger hides it.
   */
  mergedIntoOrderId?: string;


  materialCostTiyn: number;
  cuttingCostTiyn: number;
  pvcCostTiyn: number;
  hdfCostTiyn: number;
  extraServicesTiyn: number;
  deliveryCostTiyn: number;
  discountTiyn: number;
  totalTiyn: number;
  paidTiyn: number;
  debtTiyn: number;

  /** Set once the Manager clicks "Бағаны клиентке жіберу" — before this, totalTiyn is only the
   *  customer's own estimate from OrderBuilder and must not be treated as authoritative. */
  pricePublished: boolean;
  pricePublishedAt?: Timestamp;
  pricePublishedByUid?: string;
  pricePublishedByName?: string;

  /** Set (with a required reason, admin-only) when an order enters CUTTING_QUEUE without being
   *  fully paid — the strict-workflow override the spec requires an audit trail for. */
  paymentGateOverride?: boolean;
  paymentGateOverrideReason?: string;

  customerNote?: string;
  adminNote?: string;
  productionNote?: string;
  isDraft: boolean;

  /** Legacy single estimate field, kept for the worker-assignment UI that predates split
   *  cutting/PVC estimates below — new code should prefer cuttingEstimatedMinutes/pvcEstimatedMinutes. */
  estimatedMinutes?: number;

  cuttingQueuedAt?: Timestamp;
  cuttingStartedAt?: Timestamp;
  cuttingEstimatedMinutes?: number;
  cuttingExpectedCompletionAt?: Timestamp;
  cuttingCompletedAt?: Timestamp;
  cuttingActualMinutes?: number;

  pvcQueuedAt?: Timestamp;
  pvcStartedAt?: Timestamp;
  pvcEstimatedMinutes?: number;
  pvcExpectedCompletionAt?: Timestamp;
  pvcCompletedAt?: Timestamp;
  pvcActualMinutes?: number;

  readyAt?: Timestamp;
  deliveredAt?: Timestamp;

  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  submittedAt?: Timestamp;
  /** @deprecated kept for old records created before the manager-review stage existed; new code sets managerAcceptedAt instead. */
  approvedAt?: Timestamp;
  expectedCompletionAt?: Timestamp;
  cuttingConsumedAt?: Timestamp;
  cuttingConsumedMovementId?: string;
  cancelledAt?: Timestamp;
  cancelReason?: string;
}

/** Where an order sits on the public workshop board. Deliberately coarser than ProductionStatus:
 *  the board is a shop-floor progress view, not the internal 16-state machine. */
export type WorkshopBoardStage = "queue" | "cutting" | "pvc_wait" | "pvc" | "ready";

/**
 * A fully anonymized, publicly-readable snapshot of one order currently on the shop floor — the
 * "Цех жұмысы" board every signed-in customer can see. Deliberately excludes
 * customerId/customerName/phone/pricing/dimensions or anything else that would let one customer
 * identify or track another's order; a customer recognises their own row by matching orderNumber
 * against orders they already own. See firestore.rules for the read rule (any signed-in user) vs.
 * `orders` (owner-only), and lib/workshopActivity.ts for how rows are kept in sync.
 */
export interface WorkshopActivityEntry {
  id: string; // == the order's id, so sync/clear is a simple set/delete by orderId
  orderNumber: string;
  stage: WorkshopBoardStage;
  queuePosition: number;
  needsPvc: boolean;
  /** Minutes the worker estimated for the stage currently in progress; 0 when nothing is running. */
  estimatedMinutes: number;
  startedAt: Timestamp | null;
  updatedAt: Timestamp;
}

// ─────────────────────────────────── Invoices ───────────────────────────────────

export interface InvoiceLine {
  name: string;
  qty: number;
  unit: string; // "лист", "м", "дана", "қызмет"
  unitPriceTiyn: number;
  totalTiyn: number;
}

/**
 * "Накладной" — an immutable financial snapshot of one order at the moment the Manager issued it.
 *
 * The figures are frozen copies, never live references: reprinting last month's invoice must show
 * what was actually agreed then, even if the order has been edited since. Issuing again creates a
 * new version rather than mutating this one, so the history is preserved.
 */
export interface Invoice {
  id: string;
  orderId: string;
  orderNumber: string;
  invoiceNumber: string; // INV-{year}-{seq}
  version: number;
  customerId?: string;
  customerName: string;
  customerPhone: string;
  lines: InvoiceLine[];
  subtotalTiyn: number;
  discountTiyn: number;
  totalTiyn: number;
  paidTiyn: number;
  debtTiyn: number;
  paymentMethods: string[];
  note?: string;
  issuedByUid: string;
  issuedByName: string;
  issuedAt?: Timestamp;
  /**
   * The PDF binary is NOT stored remotely — it is regenerated on demand from this snapshot by
   * lib/invoicePdf.ts (Firebase Storage would require leaving the Spark plan). Because every
   * figure above is frozen, regenerating always produces the same document, so the customer's
   * download and the Manager's are the same invoice.
   */
  pdfStorage?: "on_demand";
  /** Set when the Manager pushes it to the customer's account; until then it's a draft the
   *  customer cannot see (firestore.rules gates customer reads on this flag). */
  sentToCustomer: boolean;
  sentAt?: Timestamp;
}

// ─────────────────────────────── Attendance & salary ───────────────────────────────

export type AttendanceStatus = "present" | "absent" | "late" | "dayoff" | "sick";

export const ATTENDANCE_LABELS: Record<AttendanceStatus, string> = {
  present: "Келді",
  absent: "Келмеді",
  late: "Кешікті",
  dayoff: "Демалыс",
  sick: "Ауырып қалды",
};

/** One employee-day. Document id is `${userId}_${date}` so marking the same day twice updates
 *  rather than duplicating — the natural idempotency key for a daily register. */
export interface AttendanceRecord {
  id: string;
  userId: string;
  userName: string;
  date: string; // YYYY-MM-DD in Asia/Almaty (see lib/dates.ts dayKey)
  status: AttendanceStatus;
  checkIn?: string; // "HH:MM"
  checkOut?: string;
  workedHours?: number;
  comment?: string;
  recordedByUid: string;
  recordedByName: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

/**
 * How a worker's pay is computed. MANUAL is the default and stays the default until the real
 * formula is provided — it means "Admin types the amount", so nothing is ever invented.
 */
export type SalaryMode =
  | "MANUAL"
  | "FIXED_MONTHLY"
  | "PER_SHEET"
  | "PER_PVC_METER"
  | "PER_ORDER"
  | "HOURLY"
  | "MIXED";

export const SALARY_MODE_LABELS: Record<SalaryMode, string> = {
  MANUAL: "Қолмен",
  FIXED_MONTHLY: "Айлық бекітілген",
  PER_SHEET: "Лист үшін",
  PER_PVC_METER: "ПВХ метрі үшін",
  PER_ORDER: "Заказ үшін",
  HOURLY: "Сағаттық",
  MIXED: "Аралас",
};

/** Per-worker pay configuration. Document id == userId: one active rule per worker. */
export interface SalaryRule {
  id: string;
  userId: string;
  mode: SalaryMode;
  fixedMonthlyTiyn?: number;
  /** Piece rate for a plain ЛДСП sheet. */
  perSheetTiyn?: number;
  /** Piece rates for the other sheet categories — a cutter is paid differently for ХДФ and for
   *  a countertop than for ЛДСП. Each falls back to perSheetTiyn when not set. */
  perHdfSheetTiyn?: number;
  perCountertopTiyn?: number;
  perPvcMeterTiyn?: number;
  perOrderTiyn?: number;
  hourlyTiyn?: number;
  /** Deducted per absent day when the mode includes attendance-based pay. */
  absentDayDeductionTiyn?: number;
  updatedAt?: Timestamp;
  updatedByUid?: string;
  updatedByName?: string;
}

export type SalaryStatus = "calculating" | "calculated" | "confirmed" | "paid";

export const SALARY_STATUS_LABELS: Record<SalaryStatus, string> = {
  calculating: "Есептелуде",
  calculated: "Есептелді",
  confirmed: "Расталды",
  paid: "Төленді",
};

/** One worker's pay for one month. Document id is `${userId}_${periodKey}`. */
export interface SalaryEntry {
  id: string;
  userId: string;
  userName: string;
  periodKey: string; // YYYY-MM
  mode: SalaryMode;
  baseTiyn: number;
  /** Measured work in the period — what the per-unit modes multiply. */
  sheetsCut: number;
  /** sheetsCut broken down by material category, since each is paid at its own rate. */
  ldspSheets?: number;
  hdfSheets?: number;
  countertopSheets?: number;
  pvcMeters: number;
  ordersCompleted: number;
  presentDays: number;
  absentDays: number;
  workedHours: number;
  bonusTiyn: number;
  deductionTiyn: number;
  adjustmentTiyn: number;
  finalTiyn: number;
  status: SalaryStatus;
  paidAt?: Timestamp;
  confirmedAt?: Timestamp;
  updatedAt?: Timestamp;
}

/** An Admin correction to a salary entry. Always carries a reason; never edits history in place. */
export interface SalaryAdjustment {
  id: string;
  userId: string;
  periodKey: string;
  amountTiyn: number; // signed: positive = bonus, negative = deduction
  reason: string;
  createdByUid: string;
  createdByName: string;
  createdAt?: Timestamp;
}

/**
 * Money handed to a worker before payday.
 *
 * Kept separate from SalaryAdjustment, which records a decision (a bonus, a fine). An advance is
 * cash that physically changed hands: the Manager records it at the counter, the worker sees it on
 * their own salary page, and it comes off what is still owed at month end rather than off what was
 * earned. Mistakes are reversed, never deleted — this is a money record.
 */
export interface SalaryAdvance {
  id: string;
  userId: string;
  userName: string;
  /** YYYY-MM in Asia/Almaty — the month the advance counts against. */
  periodKey: string;
  /** Always positive: the amount handed over. */
  amountTiyn: number;
  note?: string;
  paidAt?: Timestamp;
  recordedByUid: string;
  recordedByName: string;
  reversed?: boolean;
  reversalReason?: string;
  reversedByName?: string;
  createdAt?: Timestamp;
}

export interface StatusHistoryEntry {
  id: string;
  field: "production" | "payment";
  prevStatus: string;
  newStatus: string;
  userId: string;
  userName: string;
  comment?: string;
  estimatedMinutes?: number;
  createdAt?: Timestamp;
}

export interface Payment {
  id: string;
  orderId: string;
  amountTiyn: number;
  methodId: string;
  methodName: string;
  paymentDate: Timestamp;
  recordedByUid: string;
  recordedByName: string;
  comment?: string;
  receiptNumber?: string;
  groupId?: string;
  reversed: boolean;
  reversalReason?: string;
  reversalOf?: string;
  createdAt?: Timestamp;
}

export type InventoryMovementType =
  | "initial"
  | "receipt"
  | "reservation"
  | "reservation_release"
  | "cutting_consumption"
  | "return"
  | "manual_correction"
  | "write_off"
  | "reversal";

export interface InventoryMovement {
  id: string;
  materialId: string;
  type: InventoryMovementType;
  qty: number; // signed
  orderId?: string;
  userId: string;
  userName: string;
  comment?: string;
  balanceBefore: number;
  balanceAfter: number;
  createdAt?: Timestamp;
}

export interface InventoryReservation {
  id: string;
  materialId: string;
  orderId: string;
  qty: number;
  status: "active" | "released";
  createdAt?: Timestamp;
  releasedAt?: Timestamp;
}

export interface LeftoverPiece {
  id: string;
  materialId: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  qty: number;
  storageLocation?: string;
  sourceOrderId?: string;
  usable: boolean;
  createdAt?: Timestamp;
  createdByUid: string;
}

export interface AppNotification {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  orderId?: string;
  read: boolean;
  createdAt?: Timestamp;
}

export interface AuditLogEntry {
  id: string;
  userId: string;
  userName: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  comment?: string;
  createdAt?: Timestamp;
}

export interface ApplicationSettings {
  cuttingPricePerSheetTiyn: number;
  pvcThicknessOptionsMm: number[];
  companyName: string;
}

/** The columns the cutting-program CSV export can include, in the spec's default order. */
export type CsvColumnKey =
  | "orderNumber"
  | "customerName"
  | "partNumber"
  | "partName"
  | "material"
  | "materialThickness"
  | "lengthMm"
  | "widthMm"
  | "quantity"
  | "grainDirection"
  | "rotationAllowed"
  | "pvcEdgeA"
  | "pvcEdgeB"
  | "pvcEdgeC"
  | "pvcEdgeD"
  | "pvcThickness"
  | "pvcColour"
  | "note";

/** Dimension unit the export writes. Source data is always millimetres; this converts on the way out. */
export type CsvUnit = "mm" | "cm" | "m";

/** Which of length/width the cutting program expects first. Never silently swaps the values —
 *  it swaps the COLUMNS, so a part's real dimensions always land under the right heading. */
export type CsvDimensionOrder = "length_first" | "width_first";

/**
 * How PVC edges map to columns:
 *  - "per_edge": four separate A/B/C/D columns (the default, matching the spec's field list)
 *  - "combined": one column listing the enabled edges, e.g. "A,B,D" — what saws that take a single
 *    edging field expect.
 */
export type CsvPvcMapping = "per_edge" | "combined";

/** Cutting-program CSV format. Shared by CsvTemplate and the ad-hoc export path. */
export interface CsvExportSettings {
  columns: CsvColumnKey[]; // order = column order; a key's absence = excluded
  delimiter: "," | ";";
  encoding: "utf8-bom" | "utf8" | "windows-1251";
  includeHeaders: boolean;
  /** Per-column header overrides; falls back to CSV_COLUMN_LABELS when absent. */
  columnLabels?: Partial<Record<CsvColumnKey, string>>;
  unit?: CsvUnit;
  dimensionOrder?: CsvDimensionOrder;
  pvcMapping?: CsvPvcMapping;
}

/**
 * A named, reusable cutting-program export format — one document per saw/program
 * ("Пила №1", "Excel формат", …). Replaces the previous single global settings doc; several may
 * exist, exactly one is the default, and archiving hides a template without destroying the format
 * a past export was produced with.
 */
export interface CsvTemplate extends CsvExportSettings {
  id: string;
  name: string;
  isDefault: boolean;
  archived: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  updatedByUid?: string;
  updatedByName?: string;
}
