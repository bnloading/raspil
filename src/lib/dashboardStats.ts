// Pure, framework-agnostic dashboard math — extracted from src/pages/admin/AdminReports.tsx so the
// same selectors can back both that page and the new admin dashboard page. No React, no Firebase
// imports: every function takes already-fetched arrays as plain arguments.

import type { ExpenseCategory, InventoryMovement, Material, Order, Payment } from "../types/domain";
import {
  bucketByPeriod,
  inRange,
  monthLabel,
  startOfDayAlmaty,
  startOfMonthAlmaty,
  startOfWeekAlmaty,
} from "./dates";

export interface DashboardInput {
  orders: Order[];
  payments: Payment[];
  movements: InventoryMovement[];
  materials: Material[];
  now?: Date;
}

/** Orders that are neither drafts (never submitted) nor already terminal. */
const TERMINAL_STATUSES = new Set(["delivered", "cancelled"]);

function isNonDraft(o: Order): boolean {
  return o.productionStatus !== "draft";
}

function isNonTerminal(o: Order): boolean {
  return o.productionStatus !== "draft" && !TERMINAL_STATUSES.has(o.productionStatus);
}

function orderCreatedAtSeconds(o: Order): number {
  return o.createdAt?.seconds ?? 0;
}

function isOverdue(o: Order, now: Date): boolean {
  if (!o.expectedCompletionAt) return false;
  return o.expectedCompletionAt.seconds * 1000 < now.getTime();
}

export function computeKpis(input: DashboardInput): {
  todayOrders: number;
  weekOrders: number;
  monthOrders: number;
  queueCount: number;
  cuttingCount: number;
  pvcPendingCount: number;
  readyCount: number;
  todayRevenueTiyn: number;
  weekRevenueTiyn: number;
  monthRevenueTiyn: number;
  unpaidTotalTiyn: number;
  totalDebtTiyn: number;
  sheetsToday: number;
  sheetsMonth: number;
  totalSheetsCut: number;
  lowStockCount: number;
} {
  const { orders, payments, movements, materials } = input;
  const now = input.now ?? new Date();
  const today = startOfDayAlmaty(now);
  const weekStart = startOfWeekAlmaty(now);
  const monthStart = startOfMonthAlmaty(now);

  const validPayments = payments.filter((p) => !p.reversed);
  const todayRevenueTiyn = validPayments.filter((p) => inRange(p.paymentDate, today)).reduce((s, p) => s + p.amountTiyn, 0);
  const weekRevenueTiyn = validPayments.filter((p) => inRange(p.paymentDate, weekStart)).reduce((s, p) => s + p.amountTiyn, 0);
  const monthRevenueTiyn = validPayments.filter((p) => inRange(p.paymentDate, monthStart)).reduce((s, p) => s + p.amountTiyn, 0);

  const todayOrders = orders.filter((o) => inRange(o.createdAt, today)).length;
  const weekOrders = orders.filter((o) => inRange(o.createdAt, weekStart)).length;
  const monthOrders = orders.filter((o) => inRange(o.createdAt, monthStart)).length;

  const queueCount = orders.filter((o) => o.productionStatus === "cutting_queue").length;
  const cuttingCount = orders.filter((o) => o.productionStatus === "cutting_started").length;
  const pvcPendingCount = orders.filter(
    (o) => o.productionStatus === "pvc_queue" || o.productionStatus === "pvc_started",
  ).length;
  const readyCount = orders.filter((o) => o.productionStatus === "ready").length;

  const unpaidTotalTiyn = orders.reduce((s, o) => s + (o.paymentStatus === "unpaid" ? o.totalTiyn : 0), 0);
  const totalDebtTiyn = orders.reduce((s, o) => s + (o.debtTiyn || 0), 0);

  const cuttingMovements = movements.filter((m) => m.type === "cutting_consumption");
  const sheetsToday = cuttingMovements.filter((m) => inRange(m.createdAt, today)).reduce((s, m) => s + -m.qty, 0);
  const sheetsMonth = cuttingMovements.filter((m) => inRange(m.createdAt, monthStart)).reduce((s, m) => s + -m.qty, 0);
  const totalSheetsCut = cuttingMovements.reduce((s, m) => s + -m.qty, 0);

  const lowStockCount = computeLowStock(materials).length;

  return {
    todayOrders,
    weekOrders,
    monthOrders,
    queueCount,
    cuttingCount,
    pvcPendingCount,
    readyCount,
    todayRevenueTiyn,
    weekRevenueTiyn,
    monthRevenueTiyn,
    unpaidTotalTiyn,
    totalDebtTiyn,
    sheetsToday,
    sheetsMonth,
    totalSheetsCut,
    lowStockCount,
  };
}

/** Materials at or below their minimum stock threshold (available = qtyOnHand - reservedQty). Most-critical (biggest deficit) first. */
export function computeLowStock(materials: Material[]): Material[] {
  return materials
    .filter((m) => m.active && m.qtyOnHand - m.reservedQty <= m.minStock)
    .sort((a, b) => a.qtyOnHand - a.reservedQty - a.minStock - (b.qtyOnHand - b.reservedQty - b.minStock));
}

/** Monthly order-value totals in TENGE (not tiyn), ready to feed BarChart/LineChart directly. */
export function computeMonthlyRevenue(
  orders: Order[],
  field: "createdAt" | "approvedAt" = "createdAt",
): { label: string; value: number }[] {
  const nonDraft = orders.filter(isNonDraft);
  const monthly = bucketByPeriod(nonDraft, (o) => o[field], "month");
  return [...monthly.entries()].map(([key, list]) => ({
    label: monthLabel(key),
    value: list.reduce((s, o) => s + o.totalTiyn, 0) / 100,
  }));
}

const PRODUCTION_BREAKDOWN_BUCKETS = [
  { key: "completed", label: "Аяқталды", statuses: new Set(["ready", "delivered"]), color: "var(--chart-green)" },
  {
    key: "in_progress",
    label: "Жұмыста",
    statuses: new Set(["cutting_queue", "cutting_started", "cutting_completed", "pvc_queue", "pvc_started", "pvc_completed"]),
    color: "var(--chart-blue)",
  },
  {
    key: "queued",
    label: "Кезекте",
    statuses: new Set(["submitted", "manager_review", "price_calculated", "waiting_payment", "partially_paid", "paid"]),
    color: "var(--chart-amber)",
  },
  { key: "overdue", label: "Кідіріс", statuses: new Set(["cancelled"]), color: "var(--chart-red)" },
] as const;

/**
 * Four-bucket production-status breakdown for the dashboard donut chart. Excludes drafts entirely
 * (matching AdminReports' "nonDraft" convention). Every non-draft order lands in exactly one
 * bucket: "rejected" or an overdue non-terminal order both count as "Кідіріс" even though their
 * raw status would otherwise map elsewhere, so bucket values always sum to the non-draft count.
 */
export function computeProductionBreakdown(
  orders: Order[],
  now: Date = new Date(),
): { key: string; label: string; value: number; color: string }[] {
  const counts = new Map<string, number>(PRODUCTION_BREAKDOWN_BUCKETS.map((b) => [b.key, 0]));

  for (const o of orders) {
    if (!isNonDraft(o)) continue;
    let bucketKey: string;
    if (o.productionStatus === "cancelled") {
      bucketKey = "overdue";
    } else if (o.productionStatus !== "delivered" && isOverdue(o, now)) {
      bucketKey = "overdue";
    } else {
      const match = PRODUCTION_BREAKDOWN_BUCKETS.find((b) => b.statuses.has(o.productionStatus));
      bucketKey = match ? match.key : "queued";
    }
    counts.set(bucketKey, (counts.get(bucketKey) ?? 0) + 1);
  }

  return PRODUCTION_BREAKDOWN_BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    value: counts.get(b.key) ?? 0,
    color: b.color,
  }));
}

export function computePaymentSummary(orders: Order[]): {
  paidCount: number;
  partialCount: number;
  unpaidCount: number;
  totalValueTiyn: number;
  totalReceivedTiyn: number;
  debtTiyn: number;
  avgOrderTiyn: number;
  discountsTiyn: number;
} {
  const nonDraft = orders.filter(isNonDraft);
  const totalOrders = nonDraft.length;
  const totalValueTiyn = nonDraft.reduce((s, o) => s + o.totalTiyn, 0);
  const totalReceivedTiyn = nonDraft.reduce((s, o) => s + o.paidTiyn, 0);
  const paidCount = nonDraft.filter((o) => o.paymentStatus === "paid" || o.paymentStatus === "overpaid").length;
  const partialCount = nonDraft.filter((o) => o.paymentStatus === "partial").length;
  const unpaidCount = nonDraft.filter((o) => o.paymentStatus === "unpaid").length;
  const debtTiyn = nonDraft.reduce((s, o) => s + o.debtTiyn, 0);
  const avgOrderTiyn = totalOrders > 0 ? Math.round(totalValueTiyn / totalOrders) : 0;
  const discountsTiyn = nonDraft.reduce((s, o) => s + o.discountTiyn, 0);

  return { paidCount, partialCount, unpaidCount, totalValueTiyn, totalReceivedTiyn, debtTiyn, avgOrderTiyn, discountsTiyn };
}

/** Non-terminal orders (not delivered/rejected/draft) for the dashboard's "orders queue" table. */
export function computeQueueOrders(orders: Order[], limit = 8): Order[] {
  return orders
    .filter(isNonTerminal)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || orderCreatedAtSeconds(a) - orderCreatedAtSeconds(b))
    .slice(0, limit);
}

/** Payment totals by method, in TENGE, excluding reversed payments. */
export function computeMethodBreakdown(payments: Payment[]): { label: string; value: number }[] {
  const valid = payments.filter((p) => !p.reversed);
  const map = new Map<string, number>();
  for (const p of valid) map.set(p.methodName, (map.get(p.methodName) || 0) + p.amountTiyn);
  return [...map.entries()].map(([label, value]) => ({ label, value: value / 100 }));
}

export function computeCutterProductivity(orders: Order[]): Map<string, number> {
  const cutOrders = orders.filter((o) => o.cuttingConsumedAt);
  const map = new Map<string, number>();
  for (const o of cutOrders) {
    if (!o.assignedCutterName) continue;
    map.set(o.assignedCutterName, (map.get(o.assignedCutterName) || 0) + 1);
  }
  return map;
}

const PVC_DONE_STATUSES = new Set(["pvc_completed", "ready", "delivered"]);

export function computePvcProductivity(orders: Order[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const o of orders) {
    if (!o.assignedPvcName || !PVC_DONE_STATUSES.has(o.productionStatus)) continue;
    map.set(o.assignedPvcName, (map.get(o.assignedPvcName) || 0) + 1);
  }
  return map;
}

export function computeMaterialCutBreakdown(movements: InventoryMovement[], materials: Material[]): { label: string; value: number }[] {
  const cuttingMovements = movements.filter((m) => m.type === "cutting_consumption");
  const map = new Map<string, number>();
  for (const m of cuttingMovements) {
    const material = materials.find((mat) => mat.id === m.materialId);
    const name = material?.name ?? m.materialId;
    map.set(name, (map.get(name) || 0) + -m.qty);
  }
  return [...map.entries()].map(([label, value]) => ({ label, value }));
}

// Cycled for however many active expense categories exist — matches the token list in
// src/components/charts/chartColors.ts (green/blue/amber/red/gray are the only categorical tokens
// there; line/area/grid/track are axis/decoration tokens, not data-series colors).
const INCOME_ALLOCATION_COLORS = [
  "var(--chart-blue)",
  "var(--chart-green)",
  "var(--chart-amber)",
  "var(--chart-red)",
  "var(--chart-gray)",
];

/**
 * Splits monthly revenue (in tiyn) across admin-configured expense categories, converting each
 * slice to whole tenge (dividing by 100, same as computeMonthlyRevenue). Inactive categories are
 * excluded entirely. If the active categories' percentages sum to less than 100, a trailing
 * synthetic "Таза пайда" (net profit) bucket is appended so the chart always accounts for the full
 * revenue amount; if they sum to >=100, no such bucket is added (never show a negative/zero slice).
 */
export function computeIncomeAllocation(
  categories: ExpenseCategory[],
  totalRevenueTiyn: number,
): { label: string; value: number; color: string }[] {
  const active = categories.filter((c) => c.active);

  if (active.length === 0) {
    if (totalRevenueTiyn <= 0) return [];
    return [{ label: "Таза пайда", value: Math.round(totalRevenueTiyn / 100), color: "var(--chart-gray)" }];
  }

  const result = active.map((c, i) => ({
    label: c.name,
    value: Math.round(totalRevenueTiyn * (c.percentage / 100) / 100),
    color: INCOME_ALLOCATION_COLORS[i % INCOME_ALLOCATION_COLORS.length],
  }));

  const allocatedPct = active.reduce((s, c) => s + c.percentage, 0);
  if (allocatedPct < 100) {
    const remainingPct = 100 - allocatedPct;
    result.push({
      label: "Таза пайда",
      value: Math.round(totalRevenueTiyn * (remainingPct / 100) / 100),
      color: "var(--chart-gray)",
    });
  }

  return result;
}
