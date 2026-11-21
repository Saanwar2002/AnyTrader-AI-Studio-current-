import { ForbiddenError } from "../httpErrors";

export interface JobIntelligenceAccessInput {
  jobExists: boolean;
  jobData?: Record<string, any> | null;
  userUid?: string | null;
  isAdminUser: boolean;
}

/**
 * Fails closed on derived job intelligence reads whenever the parent job document
 * is missing, unless the caller holds verified platform admin authority.
 */
export function assertCanReadJobIntelligence(input: JobIntelligenceAccessInput): void {
  const uid = String(input.userUid || "").trim();
  if (!uid) {
    throw new ForbiddenError("Forbidden: authenticated user required");
  }

  if (input.isAdminUser) {
    return;
  }

  if (!input.jobExists || !input.jobData) {
    throw new ForbiddenError("Forbidden: unauthorized to read orphaned job intelligence");
  }

  const jd = input.jobData;
  const isOwner =
    jd.homeownerId === uid ||
    jd.userId === uid ||
    jd.ownerId === uid ||
    jd.posterId === uid ||
    jd.customerId === uid;
  const isAssigned =
    jd.assignedTraderId === uid ||
    jd.acceptedTraderId === uid ||
    jd.acceptedTradespersonId === uid;

  if (!isOwner && !isAssigned) {
    throw new ForbiddenError("Forbidden: unauthorized to read job intelligence");
  }
}
