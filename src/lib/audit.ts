import { addDoc, collection, serverTimestamp, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";
import type { UserDoc } from "../types/domain";

/**
 * Records one audit-log entry. IP address is intentionally omitted — there's no server to observe
 * the real client IP in this Firestore-only architecture (documented limitation).
 */
export async function logAudit(
  db: Firestore,
  actor: { user: User; userData: UserDoc },
  entry: {
    action: string;
    entityType: string;
    entityId: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    comment?: string;
  },
): Promise<void> {
  await addDoc(collection(db, "auditLogs"), {
    userId: actor.user.uid,
    userName: actor.userData.name,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    comment: entry.comment ?? null,
    createdAt: serverTimestamp(),
  });
}
