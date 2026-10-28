import type { MdfStage, Order } from "../types/domain";
import { MDF_STAGES } from "../types/domain";

/**
 * Which stations a МДФ order passes, and in what order.
 *
 * Film and paint are two ways to finish a panel, never both: a film order goes ЧПУ → Шкурка →
 * Вакуум, a paint order ЧПУ → Шкурка → Краска. Every order used to be sent through all four, so a
 * film order sat at «Краска» — where nobody paints — and the vacuum station never got it to finish
 * (№562, 28.10). An order with no finish recorded is film: the line is the wrap line, and every
 * order written before the choice existed was wrapped.
 */
export function mdfRouteFor(order: Pick<Order, "mdfFinish">): MdfStage[] {
  return order.mdfFinish === "paint" ? ["cnc", "sanding", "painting"] : ["cnc", "sanding", "vacuum"];
}

/** The station after `stage` on this order's route — undefined once the order is finished. */
export function nextMdfStage(order: Pick<Order, "mdfFinish">, stage: MdfStage): MdfStage | undefined {
  const route = mdfRouteFor(order);
  const at = route.indexOf(stage);
  if (at >= 0) return route[at + 1];
  // A station off the route (an order re-finished while it was there): the next one along the
  // line that the route does pass.
  return route.find((s) => MDF_STAGES.indexOf(s) > MDF_STAGES.indexOf(stage));
}

/**
 * Where an order in production belongs now: the first station of its route that has not been
 * finished on it. Undefined when every one has — the order is done.
 */
export function mdfStageFor(order: Pick<Order, "mdfFinish" | "mdfStageJobs">): MdfStage | undefined {
  return mdfRouteFor(order).find((s) => !order.mdfStageJobs?.[s]?.completedAt);
}

/** Will this order still reach `stage`, from where it is now? For a station's «келе жатыр» list. */
export function mdfOrderHeadingTo(order: Pick<Order, "mdfFinish" | "mdfStage">, stage: MdfStage): boolean {
  if (!order.mdfStage) return false;
  const route = mdfRouteFor(order);
  return route.includes(stage) && route.indexOf(order.mdfStage) < route.indexOf(stage);
}
