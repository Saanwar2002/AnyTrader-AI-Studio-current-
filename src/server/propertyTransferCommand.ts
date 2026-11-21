import admin from "firebase-admin";

export interface BuildClaimPropertyTransferUpdateInput {
  property: Record<string, any>;
  newOwnerId: string;
  newOwnerEmail?: string | null;
  transferCode: string;
  transferredAtIso?: string;
}

/**
 * Builds the atomic property ownership transfer update payload.
 * Clears prior landlord/manager authorities and pending transfer targets
 * so the previous owner retains zero post-transfer read/write authority.
 */
export function buildClaimPropertyTransferUpdate(
  input: BuildClaimPropertyTransferUpdateInput
): Record<string, any> {
  const { property, newOwnerId, newOwnerEmail, transferCode } = input;
  const nowIso = input.transferredAtIso || new Date().toISOString();
  const previousOwnerId = String(property.ownerId || property.userId || property.landlordId || "");
  const history = Array.isArray(property.transferHistory) ? property.transferHistory : [];

  return {
    ownerId: newOwnerId,
    userId: newOwnerId,
    homeownerId: newOwnerId,
    landlordId: admin.firestore.FieldValue.delete(),
    managerId: admin.firestore.FieldValue.delete(),
    propertyManagerId: admin.firestore.FieldValue.delete(),
    assignedManagerId: admin.firestore.FieldValue.delete(),
    transferStatus: "completed",
    transferCode: null,
    transferExpiresAt: null,
    transferTargetEmail: null,
    transferTargetName: null,
    transferClaimedAt: nowIso,
    transferClaimedByUid: newOwnerId,
    previousOwnersCount: Number(property.previousOwnersCount || 0) + 1,
    transferHistory: [
      ...history,
      {
        transferredAt: nowIso,
        transferCode,
        fromOwnerUid: previousOwnerId,
        toOwnerUid: newOwnerId,
        toOwnerEmail: newOwnerEmail || null,
        propertyName: property.name || "Property",
      },
    ],
    updatedAt: nowIso,
  };
}
