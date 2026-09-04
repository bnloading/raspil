import { doc, serverTimestamp, Timestamp, updateDoc, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";
import type { MdfStage, MdfStageJob, Order, UserDoc } from "../types/domain";
import { MDF_STAGES, MDF_STAGE_LABELS } from "../types/domain";
import { canEnterCuttingQueue } from "./statuses";
import { syncWorkshopBoard } from "./workshopActivity";
import { writeStatusHistory, notify, notifyManagers, logAudit } from "./orderStatus";

type Actor = { user: User; userData: UserDoc };

/**
 * МДФ mirror of orderStatus.ts's enterCuttingQueue/startCuttingLine/completeCuttingLine trio, but
 * generic over the 4 sequential stations instead of one hand-written function pair per station —
 * see MdfStage's doc comment in types/domain.ts for why the stage machine is shaped this way.
 * Reuses orderStatus.ts's private notification/audit/history helpers rather than duplicating them.
 */

/** Once a МДФ order is fully paid, it enters production at the first station (ЧПУ). No warehouse
 *  stock is touched — the МДФ line has no material catalogue selection (see Order.orderKind). */
export async function enterMdfProduction(
  db: Firestore,
  actor: Actor,
  order: Order,
  opts: { isAdmin: boolean; overrideReason?: string; queuePosition: number },
): Promise<void> {
  const gateOk = canEnterCuttingQueue(order.paymentStatus);
  if (!gateOk && (!opts.isAdmin || !opts.overrideReason?.trim())) {
    throw new Error("Тек толық төленген заказды өндіріске жіберуге болады");
  }

  const orderRef = doc(db, "orders", order.id);
  const firstStage: MdfStage = MDF_STAGES[0];
  await updateDoc(orderRef, {
    productionStatus: "mdf_production",
    priority: opts.queuePosition,
    mdfStage: firstStage,
    mdfStageJobs: {},
    ...(!gateOk ? { paymentGateOverride: true, paymentGateOverrideReason: opts.overrideReason } : {}),
  });
  await writeStatusHistory(
    db, actor, order.id, "production", order.productionStatus, "mdf_production",
    !gateOk ? opts.overrideReason : undefined,
  );
  if (!gateOk) {
    await logAudit(db, actor, {
      action: "order.payment_gate_override",
      entityId: order.id,
      before: { paymentStatus: order.paymentStatus },
      comment: opts.overrideReason,
    });
  }
  await logAudit(db, actor, { action: "order.sent_to_mdf_production", entityId: order.id });
  await syncWorkshopBoard(db, { ...order, productionStatus: "mdf_production", priority: opts.queuePosition, mdfStage: firstStage });
  await notify(db, order.customerId, "МДФ өндірісіне қосылды", `${order.orderNumber} ${MDF_STAGE_LABELS[firstStage]} кезегінде`, order.id);
}

/** A worker starts their station on an order already queued for it — "queued for me" is derived as
 *  order.mdfStage === stage with no startedAt yet, not a separate status value. */
export async function startMdfStage(
  db: Firestore,
  actor: Actor,
  order: Order,
  stage: MdfStage,
  estimatedMinutes: number,
): Promise<void> {
  const now = Timestamp.now();
  const expected = new Date(Date.now() + estimatedMinutes * 60000);
  const nextStageJobs: Partial<Record<MdfStage, MdfStageJob>> = {
    ...order.mdfStageJobs,
    [stage]: {
      ...order.mdfStageJobs?.[stage],
      startedAt: now,
      estimatedMinutes,
      expectedCompletionAt: Timestamp.fromDate(expected),
      byUid: actor.user.uid,
      byName: actor.userData.name,
    },
  };

  await updateDoc(doc(db, "orders", order.id), { mdfStageJobs: nextStageJobs });
  await writeStatusHistory(
    db, actor, order.id, "production", order.productionStatus, order.productionStatus,
    `${MDF_STAGE_LABELS[stage]} басталды`, estimatedMinutes,
  );
  await syncWorkshopBoard(db, { ...order, mdfStageJobs: nextStageJobs });
  await notifyManagers(
    db, `${MDF_STAGE_LABELS[stage]} басталды`,
    `${order.orderNumber}: ${MDF_STAGE_LABELS[stage]} басталды (шамамен ${estimatedMinutes} мин)`, order.id,
  );
  await notify(db, order.customerId, `${MDF_STAGE_LABELS[stage]} басталды`, `${order.orderNumber} өндірісте`, order.id);
}

/** A worker finishes their station. Advances mdfStage to the next station, or — after vacuum, the
 *  last one — marks the order "ready". No per-line "all lines done?" gate like cutting/PVC need,
 *  since a МДФ order is always one job. */
export async function completeMdfStage(db: Firestore, actor: Actor, order: Order, stage: MdfStage): Promise<void> {
  const job = order.mdfStageJobs?.[stage];
  const startedAtMs = job?.startedAt ? job.startedAt.toMillis() : undefined;
  const actualMinutes = startedAtMs ? Math.max(0, Math.round((Date.now() - startedAtMs) / 60000)) : undefined;
  const nextStageJobs: Partial<Record<MdfStage, MdfStageJob>> = {
    ...order.mdfStageJobs,
    [stage]: {
      ...job,
      completedAt: Timestamp.now(),
      byUid: actor.user.uid,
      byName: actor.userData.name,
      ...(actualMinutes !== undefined ? { actualMinutes } : {}),
    },
  };

  const orderRef = doc(db, "orders", order.id);
  const nextStage = MDF_STAGES[MDF_STAGES.indexOf(stage) + 1];

  if (nextStage) {
    await updateDoc(orderRef, { mdfStageJobs: nextStageJobs, mdfStage: nextStage });
    await writeStatusHistory(
      db, actor, order.id, "production", order.productionStatus, order.productionStatus,
      `${MDF_STAGE_LABELS[stage]} аяқталды`,
    );
    await syncWorkshopBoard(db, { ...order, mdfStageJobs: nextStageJobs, mdfStage: nextStage });
    await notifyManagers(
      db, `${MDF_STAGE_LABELS[stage]} аяқталды`,
      `${order.orderNumber}: ${MDF_STAGE_LABELS[stage]} аяқталды, ${MDF_STAGE_LABELS[nextStage]} кезегінде`, order.id,
    );
  } else {
    await updateDoc(orderRef, { mdfStageJobs: nextStageJobs, productionStatus: "ready", readyAt: serverTimestamp() });
    await writeStatusHistory(db, actor, order.id, "production", order.productionStatus, "ready", "Вакуум аяқталды");
    await syncWorkshopBoard(db, { ...order, mdfStageJobs: nextStageJobs, productionStatus: "ready" });
    await notifyManagers(db, "МДФ дайын", `${order.orderNumber}: МДФ өндірісі толық аяқталды, заказ дайын`, order.id);
    await notify(db, order.customerId, "Заказыңыз дайын", `${order.orderNumber} толығымен дайын!`, order.id);
  }
  await logAudit(db, actor, { action: "order.mdf_stage_completed", entityId: order.id, after: { stage } });
}
