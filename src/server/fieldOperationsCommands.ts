import { BadRequestError, ForbiddenError, NotFoundError, ServiceUnavailableError } from "./httpErrors.ts";

const IMMUTABLE_OWNERSHIP_FIELDS = ["businessId", "ownerId", "uid", "createdBy", "createdAt"] as const;

export interface FieldEntityUpdateInput {
  db: any;
  collectionName: "field_agents" | "dispatch_routes";
  entityId: string;
  callerUid: string;
  isAdmin?: boolean;
  updates: Record<string, any>;
}

/**
 * AT-FIELD-01: Validates ownership immutability (`businessId` / `ownerId`) on
 * field-agent and dispatch-route updates so tenants cannot hijack or reassign
 * entities across business accounts.
 */
export function assertFieldOwnershipImmutability(
  existingData: Record<string, any>,
  proposedUpdates: Record<string, any>
): void {
  if (!proposedUpdates || typeof proposedUpdates !== "object" || Array.isArray(proposedUpdates)) {
    throw new BadRequestError("Invalid update payload.");
  }

  for (const key of IMMUTABLE_OWNERSHIP_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(proposedUpdates, key)) {
      const nextVal = proposedUpdates[key];
      const existingVal = existingData[key];
      if (nextVal !== existingVal) {
        throw new ForbiddenError(
          `Ownership field '${key}' is immutable and cannot be reassigned.`
        );
      }
    }
  }
}

export async function updateFieldEntityWithOwnershipGuard(
  input: FieldEntityUpdateInput
): Promise<{ id: string; collection: string; updatedAt: string }> {
  const { db, collectionName, entityId, callerUid, isAdmin = false, updates } = input;
  if (!db) {
    throw new ServiceUnavailableError("Database unavailable.");
  }
  if (!callerUid) {
    throw new ForbiddenError("Authentication required.");
  }
  if (!entityId || typeof entityId !== "string") {
    throw new BadRequestError("Entity ID is required.");
  }

  const docRef = db.collection(collectionName).doc(entityId);
  const nowIso = new Date().toISOString();

  await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(docRef);
    if (!snap || !snap.exists) {
      throw new NotFoundError(`${collectionName} record '${entityId}' not found.`);
    }
    const existing = (typeof snap.data === "function" ? snap.data() : snap.data) || {};
    const ownerUid = existing.businessId || existing.ownerId || "";
    if (!isAdmin && ownerUid !== callerUid) {
      throw new ForbiddenError("You do not have permission to modify this dispatch resource.");
    }

    // Even for admins, prevent silent cross-tenant reassignment unless done via dedicated transfer
    assertFieldOwnershipImmutability(existing, updates);

    const safePatch: Record<string, any> = {};
    for (const [k, v] of Object.entries(updates)) {
      if ((IMMUTABLE_OWNERSHIP_FIELDS as readonly string[]).includes(k)) continue;
      if (v !== undefined) safePatch[k] = v;
    }
    safePatch.updatedAt = nowIso;

    await tx.update(docRef, safePatch);
  });

  return { id: entityId, collection: collectionName, updatedAt: nowIso };
}
