import { BadRequestError, ConflictError, ForbiddenError } from "./httpErrors.ts";
import { collectFinancialReconciliationSnapshot } from "./financialReconciliationCollector.ts";
import {
  evaluateFinancialReconciliation,
  type FinancialReconciliationReport,
} from "./financialReconciliation.ts";
import { EscrowRecoveryEngine, type EscrowRecoveryEvidence } from "./escrowRecovery.ts";

export const MAX_RECONCILIATION_REPORT_LIMIT = 100;
export const DEFAULT_RECONCILIATION_REPORT_LIMIT = 20;
export const MAX_RECONCILIATION_REPORT_OFFSET = 500;

export interface ReconciliationReportQuery {
  limit?: number | string;
  offset?: number | string;
  cursor?: string;
  statusFilter?: string;
  includeAudit?: boolean | string;
}

export interface ReconciliationReportExecutionOptions {
  stripeClient?: any;
  includeAudit?: boolean;
  collectorOptions?: Record<string, any>;
}

export interface SanitizedReconciliationRecord {
  ledgerId: string;
  jobId: string;
  quoteId: string;
  milestoneId: string;
  amountPence: number;
  formattedAmount: string;
  platformFeePence: number | null;
  netPayoutPence: number | null;
  formattedPlatformFee: string;
  formattedNetPayout: string;
  feeVerificationStatus: "verified" | "unknown";
  status: string;
  transferStatus: string;
  reconciliationStatus: "reconciled" | "failed" | "pending_transfer" | "ambiguous" | "legacy_unstructured";
  timestamp: string;
  stripeTransferIdMasked?: string;
  schemaVariant: "v8_structured" | "v7_transitional" | "v6_legacy";
}

export interface ReconciliationFullAuditSummary {
  executed: boolean;
  findingCount?: number;
  criticalCount?: number;
  findings?: FinancialReconciliationReport["findings"];
  coverage?: Record<string, any>;
  unavailableReason?: string;
}

export interface ReconciliationReportResult {
  generatedAt: string;
  recordsCount: number;
  limit: number;
  offset: number;
  cursor: string | null;
  nextCursor: string | null;
  hasMore: boolean;
  summary: {
    totalPence: number;
    reconciledCount: number;
    failedCount: number;
    pendingCount: number;
    legacyCount: number;
    ambiguousCount: number;
    unknownFeeCount: number;
  };
  records: SanitizedReconciliationRecord[];
  fullAudit?: ReconciliationFullAuditSummary;
  isReadOnly: true;
}

/**
 * Validates and sanitizes report input parameters with fail-closed bounds checking.
 */
export function validateReconciliationReportParams(rawQuery: ReconciliationReportQuery): {
  limit: number;
  offset: number;
  cursor?: string;
  statusFilter?: string;
} {
  let limit = DEFAULT_RECONCILIATION_REPORT_LIMIT;
  if (rawQuery.limit !== undefined) {
    const parsedLimit = Number(rawQuery.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw new BadRequestError("Invalid limit parameter: must be a positive integer >= 1");
    }
    if (parsedLimit > MAX_RECONCILIATION_REPORT_LIMIT) {
      throw new BadRequestError(
        `Requested limit ${parsedLimit} exceeds maximum allowed limit of ${MAX_RECONCILIATION_REPORT_LIMIT}`
      );
    }
    limit = parsedLimit;
  }

  let offset = 0;
  if (rawQuery.offset !== undefined) {
    const parsedOffset = Number(rawQuery.offset);
    if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
      throw new BadRequestError("Invalid offset parameter: must be a non-negative integer >= 0");
    }
    if (parsedOffset > MAX_RECONCILIATION_REPORT_OFFSET) {
      throw new BadRequestError(
        `Requested offset ${parsedOffset} exceeds maximum bounded offset of ${MAX_RECONCILIATION_REPORT_OFFSET}; use cursor pagination instead.`
      );
    }
    offset = parsedOffset;
  }

  let cursor: string | undefined;
  if (rawQuery.cursor !== undefined && rawQuery.cursor !== null && String(rawQuery.cursor).trim() !== "") {
    const rawCursor = String(rawQuery.cursor).trim();
    if (rawCursor.length > 200) {
      throw new BadRequestError("Invalid cursor parameter.");
    }
    cursor = rawCursor;
  }

  let statusFilter: string | undefined;
  if (rawQuery.statusFilter) {
    const allowedFilters = ["all", "completed", "failed", "pending", "released", "disputed"];
    const sanitized = String(rawQuery.statusFilter).trim().toLowerCase();
    if (!allowedFilters.includes(sanitized)) {
      throw new BadRequestError(
        `Invalid statusFilter: '${sanitized}'. Allowed values: ${allowedFilters.join(", ")}`
      );
    }
    if (sanitized !== "all") {
      statusFilter = sanitized;
    }
  }

  return { limit, offset, ...(cursor ? { cursor } : {}), statusFilter };
}

/**
 * Normalizes historical ledger entries across V6, V7, and V8 schemas while strictly redacting secrets.
 */
export function sanitizeAndClassifyLedgerRecord(docId: string, rawData: any): SanitizedReconciliationRecord {
  const data = rawData || {};

  let schemaVariant: "v8_structured" | "v7_transitional" | "v6_legacy" = "v6_legacy";
  if (data.idempotencyKey && String(data.idempotencyKey).startsWith("release:") && data.transferStatus) {
    schemaVariant = "v8_structured";
  } else if (data.verifiedAmount !== undefined || data.platformFeePence !== undefined || data.amountPence !== undefined) {
    schemaVariant = "v7_transitional";
  }

  let amountPence = 0;
  if (typeof data.verifiedAmount === "number") {
    amountPence = Math.round(data.verifiedAmount);
  } else if (typeof data.amountPence === "number") {
    amountPence = Math.round(data.amountPence);
  } else if (typeof data.amount === "number") {
    amountPence = Math.round(data.amount * 100);
  } else if (typeof data.totalAmount === "number") {
    amountPence = Math.round(data.totalAmount * 100);
  }

  let platformFeePence: number | null = null;
  if (typeof data.platformFeePence === "number" && Number.isFinite(data.platformFeePence)) {
    platformFeePence = Math.round(data.platformFeePence);
  } else if (typeof data.platformFee === "number" && Number.isFinite(data.platformFee)) {
    platformFeePence = Math.round(data.platformFee * 100);
  }

  let netPayoutPence: number | null = null;
  if (typeof data.netPayoutPence === "number" && Number.isFinite(data.netPayoutPence)) {
    netPayoutPence = Math.round(data.netPayoutPence);
  } else if (typeof data.netPayout === "number" && Number.isFinite(data.netPayout)) {
    netPayoutPence = Math.round(data.netPayout * 100);
  }

  const feeVerificationStatus: "verified" | "unknown" =
    platformFeePence !== null && netPayoutPence !== null ? "verified" : "unknown";

  const transferStatus = String(data.transferStatus || "none").toLowerCase();
  const rawStatus = String(data.status || "none").toLowerCase();
  let reconciliationStatus: "reconciled" | "failed" | "pending_transfer" | "ambiguous" | "legacy_unstructured" =
    "legacy_unstructured";

  if (transferStatus === "completed" && data.stripeTransferId) {
    reconciliationStatus = "reconciled";
  } else if (transferStatus === "failed") {
    reconciliationStatus = "failed";
  } else if (rawStatus === "released" && transferStatus !== "completed") {
    reconciliationStatus = "pending_transfer";
  } else if (schemaVariant === "v8_structured") {
    reconciliationStatus = transferStatus === "completed" ? "reconciled" : "pending_transfer";
  } else {
    reconciliationStatus = "legacy_unstructured";
  }

  let stripeTransferIdMasked: string | undefined;
  if (data.stripeTransferId && typeof data.stripeTransferId === "string") {
    const rawId = data.stripeTransferId;
    if (rawId.length > 8) {
      stripeTransferIdMasked = `${rawId.substring(0, 4)}...${rawId.substring(rawId.length - 4)}`;
    } else {
      stripeTransferIdMasked = "***";
    }
  }

  return {
    ledgerId: docId,
    jobId: String(data.jobId || "unknown_job"),
    quoteId: String(data.quoteId || "unknown_quote"),
    milestoneId: String(data.milestoneId || "m0"),
    amountPence,
    formattedAmount: `£${(amountPence / 100).toFixed(2)}`,
    platformFeePence,
    netPayoutPence,
    formattedPlatformFee:
      platformFeePence !== null ? `£${(platformFeePence / 100).toFixed(2)}` : "Unknown / Unverified",
    formattedNetPayout:
      netPayoutPence !== null ? `£${(netPayoutPence / 100).toFixed(2)}` : "Unknown / Unverified",
    feeVerificationStatus,
    status: rawStatus,
    transferStatus,
    reconciliationStatus,
    timestamp: data.createdAt || data.timestamp || new Date().toISOString(),
    stripeTransferIdMasked,
    schemaVariant,
  };
}

/**
 * Generates an operator-only, bounded, read-only financial reconciliation report.
 */
export async function generateFinancialReconciliationReport(
  db: any,
  rawParams: ReconciliationReportQuery,
  caller: { uid: string; isAdmin: boolean },
  options?: ReconciliationReportExecutionOptions
): Promise<ReconciliationReportResult> {
  if (!caller || !caller.isAdmin) {
    throw new ForbiddenError("Administrator privilege required to access financial reconciliation reports");
  }

  if (!db) {
    throw new BadRequestError("Database connection unavailable for reconciliation reporting");
  }

  const { limit, offset, cursor, statusFilter } = validateReconciliationReportParams(rawParams);

  let queryRef = db.collection("payment_ledger");
  if (statusFilter) {
    queryRef = queryRef.where("transferStatus", "==", statusFilter);
  }
  if (typeof queryRef.orderBy === "function") {
    queryRef = queryRef.orderBy("__name__");
  }
  if (cursor && typeof queryRef.startAfter === "function") {
    if (typeof db.collection("payment_ledger").doc === "function") {
      const cursorSnap = await db.collection("payment_ledger").doc(cursor).get();
      if (cursorSnap?.exists) {
        queryRef = queryRef.startAfter(cursorSnap);
      } else {
        queryRef = queryRef.startAfter(cursor);
      }
    } else {
      queryRef = queryRef.startAfter(cursor);
    }
  }

  const fetchWindow = offset + limit + 1;
  const snapshot = await queryRef.limit(fetchWindow).get();
  let allDocs: any[] = snapshot?.docs || [];
  // Fallback for deterministic ordering & cursor filtering on minimal unit-test mocks
  if (typeof queryRef.orderBy !== "function") {
    allDocs = [...allDocs].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  if (cursor && typeof queryRef.startAfter !== "function") {
    const idx = allDocs.findIndex((d) => d.id === cursor);
    if (idx >= 0) allDocs = allDocs.slice(idx + 1);
  }
  const pagedDocs = allDocs.slice(offset, offset + limit);
  const hasMore = allDocs.length > offset + limit;
  const nextCursor = hasMore && pagedDocs.length > 0 ? pagedDocs[pagedDocs.length - 1].id : null;

  const records: SanitizedReconciliationRecord[] = [];
  let totalPence = 0;
  let reconciledCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let legacyCount = 0;
  let ambiguousCount = 0;
  let unknownFeeCount = 0;

  for (const doc of pagedDocs) {
    const docData = typeof doc.data === "function" ? doc.data() : doc.data;
    const sanitized = sanitizeAndClassifyLedgerRecord(doc.id, docData);
    records.push(sanitized);

    totalPence += sanitized.amountPence;
    if (sanitized.feeVerificationStatus === "unknown") unknownFeeCount++;
    if (sanitized.reconciliationStatus === "reconciled") reconciledCount++;
    else if (sanitized.reconciliationStatus === "failed") failedCount++;
    else if (sanitized.reconciliationStatus === "pending_transfer") pendingCount++;
    else if (sanitized.reconciliationStatus === "ambiguous") ambiguousCount++;
    else legacyCount++;
  }

  let fullAudit: ReconciliationFullAuditSummary | undefined;
  const shouldRunFullAudit =
    Boolean(options?.includeAudit) ||
    rawParams.includeAudit === true ||
    String(rawParams.includeAudit || "").toLowerCase() === "true";

  if (shouldRunFullAudit) {
    if (!options?.stripeClient) {
      fullAudit = {
        executed: false,
        unavailableReason: "Stripe client is not configured; full FIN-05 collector audit skipped.",
      };
    } else {
      try {
        const collected = await collectFinancialReconciliationSnapshot(
          db,
          options.stripeClient,
          options.collectorOptions || {}
        );
        const evaluated = evaluateFinancialReconciliation(collected.snapshot);
        fullAudit = {
          executed: true,
          findingCount: evaluated.findingCount,
          criticalCount: evaluated.criticalCount,
          findings: evaluated.findings,
          coverage: collected.coverage,
        };
      } catch (auditErr: any) {
        fullAudit = {
          executed: false,
          unavailableReason: auditErr?.message || "FIN-05 full reconciliation audit failed to collect snapshot.",
        };
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    recordsCount: records.length,
    limit,
    offset,
    cursor: cursor || null,
    nextCursor,
    hasMore,
    summary: {
      totalPence,
      reconciledCount,
      failedCount,
      pendingCount,
      legacyCount,
      ambiguousCount,
      unknownFeeCount,
    },
    records,
    ...(fullAudit ? { fullAudit } : {}),
    isReadOnly: true,
  };
}

export interface ReconciliationOperatorActionInput {
  db: any;
  stripeClient?: any;
  caller: { uid: string; email?: string; isAdmin: boolean };
  action: "inspect_escrow" | "repair_escrow_ledger" | "acknowledge_finding" | "escalate_finding";
  jobId?: string;
  quoteId?: string;
  milestoneId?: string;
  idempotencyKey?: string;
  findingCode?: string;
  entityId?: string;
  note?: string;
}

export async function executeReconciliationOperatorAction(input: ReconciliationOperatorActionInput): Promise<{
  success: boolean;
  action: string;
  evidence?: EscrowRecoveryEvidence;
  ledgerUpdated?: boolean;
  recordedActionId?: string;
}> {
  const { db, stripeClient, caller, action, jobId, quoteId, milestoneId, idempotencyKey, findingCode, entityId, note } = input;

  if (!caller?.isAdmin) {
    throw new ForbiddenError("Administrator privilege required for financial reconciliation actions.");
  }
  if (!db) {
    throw new BadRequestError("Database connection unavailable.");
  }

  const nowIso = new Date().toISOString();

  if (action === "inspect_escrow" || action === "repair_escrow_ledger") {
    if (!jobId || !quoteId || !milestoneId || !idempotencyKey) {
      throw new BadRequestError("jobId, quoteId, milestoneId, and idempotencyKey are required to inspect or repair escrow.");
    }
    const evidence = await EscrowRecoveryEngine.inspectTransferEvidence(
      db,
      { jobId, quoteId, milestoneId, idempotencyKey },
      { stripe: stripeClient }
    );

    if (action === "inspect_escrow") {
      return { success: true, action, evidence };
    }

    if (evidence.status !== "RESOLVED_EXACT_MATCH") {
      throw new ConflictError(
        `Cannot auto-repair escrow ledger unless Stripe transfer evidence is RESOLVED_EXACT_MATCH (got ${evidence.status}: ${evidence.unresolvedReason || "manual review required"}).`
      );
    }

    const repairRes = await EscrowRecoveryEngine.applyLedgerEvidenceRepair(db, idempotencyKey, evidence);
    try {
      await db.collection("admin_audit_logs").add({
        action: "reconciliation_repair_ledger",
        targetId: `${jobId}:${milestoneId}`,
        targetType: "payment_ledger",
        details: `Operator repaired escrow ledger entry for key ${idempotencyKey} -> transfer ${evidence.matchedTransferId}. Note: ${note || "none"}`,
        adminId: caller.uid,
        adminEmail: caller.email || null,
        timestamp: nowIso,
      });
    } catch {
      // Non-fatal
    }

    return {
      success: repairRes.success,
      action,
      evidence,
      ledgerUpdated: repairRes.ledgerUpdated,
    };
  }

  if (action === "acknowledge_finding" || action === "escalate_finding") {
    if (!findingCode || !entityId) {
      throw new BadRequestError("findingCode and entityId are required.");
    }
    const recordId = `${findingCode}_${entityId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 140);
    await db.collection("reconciliation_operator_actions").doc(recordId).set(
      {
        findingCode,
        entityId,
        status: action === "acknowledge_finding" ? "acknowledged" : "escalated",
        note: String(note || "").slice(0, 1000),
        operatorUid: caller.uid,
        operatorEmail: caller.email || null,
        updatedAt: nowIso,
      },
      { merge: true }
    );

    try {
      await db.collection("admin_audit_logs").add({
        action: `reconciliation_${action}`,
        targetId: recordId,
        targetType: "reconciliation_finding",
        details: `Operator ${action} on ${findingCode} (${entityId}): ${note || "No note"}`,
        adminId: caller.uid,
        adminEmail: caller.email || null,
        timestamp: nowIso,
      });
    } catch {
      // Non-fatal
    }

    return {
      success: true,
      action,
      recordedActionId: recordId,
    };
  }

  throw new BadRequestError(`Unsupported reconciliation operator action: '${action}'`);
}
