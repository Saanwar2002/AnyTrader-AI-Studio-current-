/**
 * Server-Authoritative Manual Invoice Creation (AT-CJ-INVOICE-06)
 * Validates trader profile & HMRC VAT registration before permitting VAT-itemized invoices.
 */
import { z } from "zod";
import { BadRequestError, ForbiddenError, NotFoundError } from "./httpErrors.ts";
import { evaluateVatEligibility } from "../lib/vatValidation.ts";
import { CanonicalIdentity } from "./identity.ts";
import { getDynamicFirestoreConfigs, resolveAnyTraderCommission } from "./pricingCatalog.ts";
import { sanitizeOfficialBankDetails } from "./slice2MoneyFlowHelpers.ts";

export const CREATE_MANUAL_INVOICE_SCHEMA = z.object({
  clientName: z.string().trim().min(1, "Client name is required").max(200),
  clientAddress: z.string().trim().max(400).optional().default(""),
  title: z.string().trim().min(1, "Job or service title is required").max(250),
  items: z.array(
    z.object({
      description: z.string().trim().min(1, "Line item description is required").max(300),
      amount: z.number().nonnegative("Item amount cannot be negative").max(1000000),
    })
  ).min(1, "At least one invoice line item is required").max(50),
  includeVat: z.boolean().optional().default(false),
  vatRate: z.number().min(0).max(25).optional(),
  dueDate: z.string().trim().max(40).optional(),
}).strict();

export type CreateManualInvoiceInput = z.infer<typeof CREATE_MANUAL_INVOICE_SCHEMA>;

export async function createManualInvoiceCommand(options: {
  db: any;
  identity: CanonicalIdentity;
  rawBody: unknown;
}): Promise<{ id: string; invoice: Record<string, any> }> {
  const { db, identity, rawBody } = options;
  if (!db) throw new BadRequestError("Database service is not initialized.");
  if (!identity?.uid) throw new ForbiddenError("Authentication required.");

  const parsed = CREATE_MANUAL_INVOICE_SCHEMA.safeParse(rawBody);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.errors.map((e) => e.message).join("; "));
  }

  const input = parsed.data;
  const userSnap = await db.collection("users").doc(identity.uid).get();
  const userData = userSnap.exists
    ? (typeof userSnap.data === "function" ? userSnap.data() : userSnap.data) || {}
    : {};

  const wantsVat = Boolean(input.includeVat) || Number(input.vatRate || 0) > 0;
  const vatEligibility = evaluateVatEligibility(userData);

  if (wantsVat && !vatEligibility.eligible) {
    throw new ForbiddenError(
      vatEligibility.reason || "Verified UK VAT registration is required to issue VAT-itemized invoices."
    );
  }

  const subtotal = Math.round(
    input.items.reduce((sum, item) => sum + Number(item.amount || 0), 0) * 100
  ) / 100;

  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    throw new BadRequestError("Invoice subtotal must be greater than £0.00.");
  }

  const appliedVatRate = wantsVat && vatEligibility.eligible ? 20 : 0;
  const vatAmount = appliedVatRate > 0 ? Math.round(subtotal * (appliedVatRate / 100) * 100) / 100 : 0;
  const totalAmount = Math.round((subtotal + vatAmount) * 100) / 100;
  const nowIso = new Date().toISOString();
  const dueDate =
    input.dueDate && /^\d{4}-\d{2}-\d{2}/.test(input.dueDate)
      ? input.dueDate
      : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const invoiceRef = db.collection("invoices").doc();
  const invoiceRecord = {
    id: invoiceRef.id,
    traderId: identity.uid,
    traderName: userData.businessName || userData.companyName || userData.displayName || userData.name || "TradeOS Specialist",
    tradespersonVatNumber: vatEligibility.eligible ? vatEligibility.vatNumber : "",
    vatRegistered: vatEligibility.eligible,
    clientName: input.clientName,
    clientAddress: input.clientAddress,
    title: input.title,
    items: input.items.map((item) => ({
      description: item.description,
      amount: Math.round(Number(item.amount) * 100) / 100,
    })),
    subtotal,
    vatAmount,
    vatRate: appliedVatRate,
    amount: totalAmount,
    status: "unpaid",
    paid: false,
    isPaid: false,
    payoutTransferred: false,
    payoutStatus: "unpaid",
    dueDate,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await invoiceRef.set(invoiceRecord);
  return { id: invoiceRef.id, invoice: invoiceRecord };
}

function isProInvoiceTrader(traderProfile: Record<string, any>): boolean {
  const rawTier = String(traderProfile.tierId || traderProfile.tier || "").trim().toLowerCase();
  const terminalStatus = ["canceled", "cancelled", "unpaid", "incomplete_expired"].includes(
    String(traderProfile.subscriptionStatus || "").toLowerCase()
  );
  const tierIsPro =
    !(traderProfile.subscriptionType === "tier" && terminalStatus) &&
    (rawTier.includes("pro") || rawTier.includes("premium") || rawTier.includes("gold") || rawTier.includes("platinum") || rawTier.includes("silver") || rawTier.includes("elite"));
  return Boolean(
    tierIsPro ||
    traderProfile.hasVerifiedVideoProSubscription ||
    traderProfile.isProInvoiceSubscriber ||
    traderProfile.isPro
  );
}

/**
 * Server-Authoritative Official Job Invoice Creation / Retrieval (Slice 2 Money Flow Fix)
 * - Enforces participant-only access (homeowner, assigned tradesperson, or admin)
 * - Writes canonical traderId + tradespersonId + homeownerId so Firestore rules always permit reads
 * - Syncs authoritative paid status from job/milestones (upgrading unpaid -> paid automatically)
 * - Never fabricates hardcoded placeholder bank details
 */
export async function createOrGetJobInvoiceCommand(options: {
  db: any;
  identity: CanonicalIdentity;
  jobId: string;
}): Promise<{ id: string; invoice: Record<string, any>; created: boolean }> {
  const { db, identity, jobId } = options;
  if (!db) throw new BadRequestError("Database service is not initialized.");
  if (!identity?.uid) throw new ForbiddenError("Authentication required.");
  const cleanJobId = String(jobId || "").trim();
  if (!cleanJobId || cleanJobId.includes("/")) {
    throw new BadRequestError("A valid jobId is required.");
  }

  const jobRef = db.collection("jobs").doc(cleanJobId);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) {
    throw new NotFoundError(`Job '${cleanJobId}' not found.`);
  }
  const jobData = (typeof jobSnap.data === "function" ? jobSnap.data() : jobSnap.data) || {};

  const homeownerId = String(jobData.homeownerId || jobData.userId || jobData.ownerId || "").trim();
  let acceptedQuote: Record<string, any> | null = null;
  if (jobData.acceptedQuoteId) {
    const qSnap = await jobRef.collection("quotes").doc(String(jobData.acceptedQuoteId)).get();
    if (qSnap.exists) {
      acceptedQuote = { id: qSnap.id, ...((typeof qSnap.data === "function" ? qSnap.data() : qSnap.data) || {}) };
    }
  }
  if (!acceptedQuote) {
    const quotesSnap = await jobRef.collection("quotes").where("status", "==", "accepted").get();
    if (quotesSnap?.docs?.length > 0) {
      const d = quotesSnap.docs[0];
      acceptedQuote = { id: d.id, ...((typeof d.data === "function" ? d.data() : d.data) || {}) };
    }
  }
  if (!acceptedQuote) {
    throw new BadRequestError("An accepted quote is required before generating an official job invoice.");
  }

  const traderId = String(
    acceptedQuote.tradespersonId ||
    acceptedQuote.traderId ||
    jobData.acceptedTradespersonId ||
    jobData.acceptedTraderId ||
    ""
  ).trim();

  const isParticipant =
    identity.accountType === "admin" ||
    (homeownerId && identity.uid === homeownerId) ||
    (traderId && identity.uid === traderId);

  if (!isParticipant) {
    throw new ForbiddenError("Only the job homeowner, assigned tradesperson, or an admin can access this job invoice.");
  }

  const milestones = Array.isArray(acceptedQuote.milestones) ? acceptedQuote.milestones : [];
  const allMilestonesReleased =
    milestones.length > 0 &&
    milestones.every(
      (m: any) =>
        ["released", "funds_released"].includes(String(m?.status || "").toLowerCase()) &&
        m?.releaseStatus !== "reconciliation_required" &&
        m?.releaseStatus !== "failed"
    );
  const jobIsPaid = Boolean(
    jobData.isPaid === true ||
    jobData.paymentStatus === "paid" ||
    jobData.paymentStatus === "handshake_complete" ||
    allMilestonesReleased
  );

  const invoiceDocId = `INV_${cleanJobId}`;
  const invoiceRef = db.collection("invoices").doc(invoiceDocId);
  const existingSnap = await invoiceRef.get();
  const nowIso = new Date().toISOString();

  if (existingSnap.exists) {
    const existing = (typeof existingSnap.data === "function" ? existingSnap.data() : existingSnap.data) || {};
    const patch: Record<string, any> = {};
    if (traderId && !existing.traderId) patch.traderId = traderId;
    if (traderId && !existing.tradespersonId) patch.tradespersonId = traderId;
    if (homeownerId && !existing.homeownerId) patch.homeownerId = homeownerId;
    if (jobIsPaid && (existing.status !== "paid" || existing.isPaid !== true || existing.paid !== true)) {
      patch.status = "paid";
      patch.paid = true;
      patch.isPaid = true;
      patch.paidAt = existing.paidAt || nowIso;
    }
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = nowIso;
      await invoiceRef.set(patch, { merge: true });
      return { id: invoiceDocId, invoice: { id: invoiceDocId, ...existing, ...patch }, created: false };
    }
    return { id: invoiceDocId, invoice: { id: invoiceDocId, ...existing }, created: false };
  }

  const [traderSnap, homeownerSnap, { globalTiers, globalConfig }] = await Promise.all([
    traderId ? db.collection("users").doc(traderId).get() : Promise.resolve(null),
    homeownerId ? db.collection("users").doc(homeownerId).get() : Promise.resolve(null),
    getDynamicFirestoreConfigs(db),
  ]);
  const traderProfile = traderSnap?.exists
    ? ((typeof traderSnap.data === "function" ? traderSnap.data() : traderSnap.data) || {})
    : {};
  const homeownerProfile = homeownerSnap?.exists
    ? ((typeof homeownerSnap.data === "function" ? homeownerSnap.data() : homeownerSnap.data) || {})
    : {};

  const isPro = isProInvoiceTrader(traderProfile);
  const laborAmount = Math.round(Number(acceptedQuote.amount || 0) * 100) / 100;
  const materialsAmount = Math.round(Number(jobData.materialsCost || acceptedQuote.materialsCost || 0) * 100) / 100;
  const explicitQuoteFee = Number(acceptedQuote.platformFee);
  let platformFee = 0;
  if (
    acceptedQuote.platformFee !== undefined &&
    acceptedQuote.platformFee !== null &&
    Number.isFinite(explicitQuoteFee) &&
    explicitQuoteFee >= 0 &&
    explicitQuoteFee <= laborAmount
  ) {
    platformFee = Math.round(explicitQuoteFee * 100) / 100;
  } else if (laborAmount > 0) {
    const resolvedComm = await resolveAnyTraderCommission({
      amountPence: Math.round(laborAmount * 100),
      traderData: traderProfile,
      globalTiers,
      globalConfig,
      explicitCommissionRate:
        typeof acceptedQuote.appliedCommissionRate === "number" ? acceptedQuote.appliedCommissionRate : undefined,
      explicitCapGbp:
        typeof acceptedQuote.commissionCapGbp === "number" ? acceptedQuote.commissionCapGbp : undefined,
    });
    platformFee = Math.round(resolvedComm.platformFeePence) / 100;
  }

  const subtotal = Math.round((laborAmount + materialsAmount) * 100) / 100;
  const vatEvaluation = evaluateVatEligibility(traderProfile);
  const vatRate = vatEvaluation.eligible ? 20 : 0;
  const vatAmount = vatEvaluation.eligible ? Math.round(subtotal * 0.2 * 100) / 100 : 0;
  const totalAmount = Math.round((subtotal + vatAmount) * 100) / 100;

  const invoiceNumber = `INV-${new Date().getFullYear()}-${cleanJobId.slice(-6).toUpperCase()}`;
  const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const verifiedBankDetails = isPro ? sanitizeOfficialBankDetails(traderProfile) : undefined;

  const invoiceRecord: Record<string, any> = {
    id: invoiceDocId,
    invoiceNumber,
    jobId: cleanJobId,
    jobTitle: jobData.title || "Trade Service",
    category: jobData.category || "General Trade",
    postcode: jobData.postcode || "UK",
    homeownerId,
    homeownerName: homeownerProfile.name || homeownerProfile.displayName || jobData.homeownerName || "Homeowner",
    homeownerEmail: homeownerProfile.email || jobData.homeownerEmail || "",
    homeownerAddress: jobData.address || jobData.postcode || "",
    traderId,
    tradespersonId: traderId,
    tradespersonName: traderProfile.name || traderProfile.displayName || traderProfile.businessName || "Tradesperson",
    tradespersonBusinessName:
      traderProfile.businessName || traderProfile.companyName || traderProfile.name || "Independent Tradesperson",
    tradespersonVatNumber: vatEvaluation.eligible ? vatEvaluation.vatNumber : "",
    vatRegistered: vatEvaluation.eligible,
    vatRate,
    tradespersonLogoUrl: traderProfile.photoURL || traderProfile.logoUrl || "",
    tradespersonPhone: traderProfile.phone || traderProfile.phoneNumber || "",
    ...(verifiedBankDetails ? { tradespersonBankDetails: verifiedBankDetails } : {}),
    tier: isPro ? "pro" : "free",
    status: jobIsPaid ? "paid" : "unpaid",
    paid: jobIsPaid,
    isPaid: jobIsPaid,
    ...(jobIsPaid ? { paidAt: jobData.paidAt || nowIso } : {}),
    createdAt: nowIso,
    updatedAt: nowIso,
    dueDate,
    laborAmount,
    materialsAmount,
    platformFee,
    subtotal,
    vatAmount,
    totalAmount,
    amount: totalAmount,
    isBrandedPro: isPro,
    notes: isPro
      ? (traderProfile.customInvoiceNotes || "Thank you for choosing a Verified AnyTrader Pro! Payment due within 14 days.")
      : "Automated standard invoice generated via AnyTrader Platform.",
  };

  await invoiceRef.set(invoiceRecord);
  return { id: invoiceDocId, invoice: invoiceRecord, created: true };
}
