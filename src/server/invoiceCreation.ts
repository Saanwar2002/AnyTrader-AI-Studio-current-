/**
 * Server-Authoritative Manual Invoice Creation (AT-CJ-INVOICE-06)
 * Validates trader profile & HMRC VAT registration before permitting VAT-itemized invoices.
 */
import { z } from "zod";
import { BadRequestError, ForbiddenError } from "./httpErrors.ts";
import { evaluateVatEligibility } from "../lib/vatValidation.ts";
import { CanonicalIdentity } from "./identity.ts";

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
