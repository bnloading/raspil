import { dayKey, startOfDayAlmaty } from "./dates";
import { MDF_STAGES, MDF_STAGE_LABELS } from "../types/domain";
import type { MdfStage, Order } from "../types/domain";

/**
 * Pure МДФ-line dashboard math for the admin "МДФ өндірісі" board — mirrors dashboardStats.ts's
 * computeProductionBreakdown/computeCutterProductivity/isOverdue for the распил line, scoped to
 * `orderKind === "mdf_wrap"` and the 4-station mdfStage pointer instead of ProductionStatus.
 */

export interface MdfBoardColumn {
  key: string;
  label: string;
  count: number;
}

/** One column per station (Кезек → ЧПУ → Шкурка → Краска → Вакуум → Дайын), matching the mockup's
 *  kanban board. "Кезек" is everything paid-or-earlier that hasn't entered production yet. */
export function computeMdfBoard(orders: readonly Order[]): MdfBoardColumn[] {
  const counts: Record<string, number> = { queue: 0, cnc: 0, sanding: 0, painting: 0, vacuum: 0, ready: 0 };

  for (const o of orders) {
    if (o.orderKind !== "mdf_wrap") continue;
    if (o.productionStatus === "draft" || o.productionStatus === "cancelled") continue;
    if (o.productionStatus === "ready" || o.productionStatus === "delivered") {
      counts.ready += 1;
    } else if (o.productionStatus === "mdf_production" && o.mdfStage) {
      counts[o.mdfStage] += 1;
    } else {
      counts.queue += 1;
    }
  }

  return [
    { key: "queue", label: "Кезек", count: counts.queue },
    ...MDF_STAGES.map((s) => ({ key: s, label: MDF_STAGE_LABELS[s], count: counts[s] })),
    { key: "ready", label: "Дайын", count: counts.ready },
  ];
}

/** Orders past their expected completion date and not yet ready — the board's overdue alert. */
export function computeMdfOverdue(orders: readonly Order[], now: Date = new Date()): Order[] {
  return orders.filter(
    (o) =>
      o.orderKind === "mdf_wrap" &&
      o.productionStatus === "mdf_production" &&
      o.mdfStage &&
      o.mdfStageJobs?.[o.mdfStage]?.expectedCompletionAt &&
      o.mdfStageJobs[o.mdfStage]!.expectedCompletionAt!.toMillis() < now.getTime(),
  );
}

/** How many orders each named worker touched at one station today (started or finished it) — the
 *  board's per-worker "Бүгін жүктеме" chip. */
export function computeMdfWorkerLoadToday(
  orders: readonly Order[],
  stage: MdfStage,
  now: Date = new Date(),
): Map<string, number> {
  const today = dayKey(now);
  const map = new Map<string, number>();
  for (const o of orders) {
    if (o.orderKind !== "mdf_wrap") continue;
    const job = o.mdfStageJobs?.[stage];
    const at = job?.completedAt ?? job?.startedAt;
    if (!job?.byName || !at || dayKey(at.toDate()) !== today) continue;
    map.set(job.byName, (map.get(job.byName) ?? 0) + 1);
  }
  return map;
}

/** m² finished (vacuum completed) per day over the last 7 days, oldest first — for the board's bar chart. */
export function computeMdfWeeklyOutput(orders: readonly Order[], now: Date = new Date()): { label: string; value: number }[] {
  const WEEKDAY_SHORT = ["Жс", "Дс", "Сс", "Ср", "Бс", "Жм", "Сб"];
  const days: { key: string; label: string }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(startOfDayAlmaty(now).getTime() - i * 86_400_000);
    days.push({ key: dayKey(d), label: WEEKDAY_SHORT[d.getDay()] });
  }
  const totals = new Map(days.map((d) => [d.key, 0]));

  for (const o of orders) {
    if (o.orderKind !== "mdf_wrap") continue;
    const finishedAt = o.mdfStageJobs?.vacuum?.completedAt;
    if (!finishedAt) continue;
    const key = dayKey(finishedAt.toDate());
    if (totals.has(key)) totals.set(key, (totals.get(key) ?? 0) + (o.mdfAreaM2 ?? 0));
  }

  return days.map((d) => ({ label: d.label, value: Math.round((totals.get(d.key) ?? 0) * 10) / 10 }));
}
