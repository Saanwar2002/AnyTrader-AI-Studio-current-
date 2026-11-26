import { auth, db, sendNotification } from "@/src/firebase";
import { doc, getDoc } from "firebase/firestore";
import { calculatePayoutBreakdown, normalizeTraderTier } from "./stripeIntegrationService";
import { exportInvoicesToSheets } from "./googleSheetsService";
import { evaluateVatEligibility } from "../lib/vatValidation";

export interface InvoiceData {
  id?: string;
  invoiceNumber: string;
  jobId: string;
  jobTitle: string;
  category: string;
  postcode: string;
  homeownerId: string;
  homeownerName: string;
  homeownerEmail?: string;
  homeownerAddress?: string;
  tradespersonId: string;
  tradespersonName: string;
  tradespersonBusinessName?: string;
  tradespersonVatNumber?: string;
  tradespersonLogoUrl?: string;
  tradespersonPhone?: string;
  tradespersonBankDetails?: {
    bankName?: string;
    sortCode?: string;
    accountNumber?: string;
  };
  tier: "free" | "pro";
  status: "paid" | "unpaid" | "pending";
  createdAt: any;
  dueDate: string;
  laborAmount: number;
  materialsAmount: number;
  platformFee: number;
  subtotal: number;
  vatAmount: number;
  totalAmount: number;
  isBrandedPro: boolean;
  notes?: string;
}

/**
 * Checks tradesperson profile to determine if they qualify for Pro Branded Invoicing.
 */
export function isProInvoiceUser(tradespersonProfile: any): boolean {
  if (!tradespersonProfile) return false;
  const normalized = normalizeTraderTier(tradespersonProfile.tierId || tradespersonProfile.tier);
  const terminalMembershipStatus = ["canceled", "unpaid", "incomplete_expired"].includes(
    String(tradespersonProfile.subscriptionStatus || "").toLowerCase()
  );
  // The stored tier label can outlive its Stripe subscription. For an explicitly
  // Stripe-managed membership, a terminal webhook status must override that stale label.
  const tierGrantsInvoicePro = !(tradespersonProfile.subscriptionType === "tier" && terminalMembershipStatus) &&
    (normalized === "pro" || normalized === "premium" || normalized === "platinum");
  return Boolean(
    tierGrantsInvoicePro ||
    tradespersonProfile.hasVerifiedVideoProSubscription ||
    tradespersonProfile.isProInvoiceSubscriber ||
    tradespersonProfile.isPro
  );
}

export interface InvoiceSummaryMath {
  laborAmount: number;
  materialsAmount: number;
  platformFee: number;
  netLaborLine: number;
  subtotal: number;
  vatEligible: boolean;
  vatNumber: string;
  vatAmount: number;
  totalAmount: number;
}

export function calculateInvoiceSummary(
  acceptedQuote: any,
  job: any,
  tradespersonProfile: any,
  pricingOverrides?: { commissionRate?: number; commissionCapGbp?: number }
): InvoiceSummaryMath {
  const rawTier = tradespersonProfile?.tierId || tradespersonProfile?.tier || "payg";
  const laborAmount = Math.round(Number(acceptedQuote?.amount || 0) * 100) / 100;
  const materialsAmount = Math.round(Number(job?.materialsCost || acceptedQuote?.materialsCost || 0) * 100) / 100;
  const explicitQuoteFee = Number(acceptedQuote?.platformFee);
  const hasAuthoritativeQuoteFee =
    acceptedQuote?.platformFee !== undefined &&
    acceptedQuote?.platformFee !== null &&
    Number.isFinite(explicitQuoteFee) &&
    explicitQuoteFee >= 0 &&
    explicitQuoteFee <= laborAmount;
  const effectiveRate =
    pricingOverrides?.commissionRate ??
    (typeof acceptedQuote?.appliedCommissionRate === "number" ? acceptedQuote.appliedCommissionRate : undefined);
  const effectiveCap =
    pricingOverrides?.commissionCapGbp ??
    (typeof acceptedQuote?.commissionCapGbp === "number" ? acceptedQuote.commissionCapGbp : undefined);
  const payoutBreakdown = calculatePayoutBreakdown(laborAmount, rawTier, effectiveRate, effectiveCap);
  const platformFee = hasAuthoritativeQuoteFee
    ? Math.round(explicitQuoteFee * 100) / 100
    : Math.round(Number(payoutBreakdown.platformCommission || 0) * 100) / 100;
  const netLaborLine =
    platformFee > 0 && laborAmount >= platformFee
      ? Math.round((laborAmount - platformFee) * 100) / 100
      : laborAmount;
  const subtotal = Math.round((laborAmount + materialsAmount) * 100) / 100;
  const vatEvaluation = evaluateVatEligibility(tradespersonProfile);
  const vatRate = vatEvaluation.eligible ? 0.20 : 0;
  const vatAmount = Math.round(subtotal * vatRate * 100) / 100;
  const totalAmount = Math.round((subtotal + vatAmount) * 100) / 100;

  return {
    laborAmount,
    materialsAmount,
    platformFee,
    netLaborLine,
    subtotal,
    vatEligible: vatEvaluation.eligible,
    vatNumber: vatEvaluation.vatNumber || "",
    vatAmount,
    totalAmount,
  };
}

/**
 * Automatically creates or retrieves an official invoice when a job is completed.
 */
export async function createOrGetJobInvoice(
  job: any,
  acceptedQuote: any,
  tradespersonProfile: any,
  homeownerProfile: any
): Promise<InvoiceData> {
  const jobId = job.id || job.jobId;
  const invoiceDocId = `INV_${jobId}`;

  // Primary path: server-authoritative invoice creation / retrieval & paid-status sync
  try {
    const token = await auth.currentUser?.getIdToken();
    if (token && jobId) {
      const response = await fetch(`/api/invoices/job/${encodeURIComponent(String(jobId))}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        if (data?.invoice) {
          const authoritativeInvoice: InvoiceData = {
            id: data.id || invoiceDocId,
            ...data.invoice,
          };

          if (data.created) {
            try {
              const isPro = Boolean(authoritativeInvoice.isBrandedPro);
              if (job.homeownerId) {
                await sendNotification(
                  job.homeownerId,
                  `🧾 Invoice Ready: ${authoritativeInvoice.invoiceNumber}`,
                  `Your invoice for "${job.title}" (£${Number(authoritativeInvoice.totalAmount || 0).toFixed(2)}) is now available to download.`,
                  "system",
                  `/job/${jobId}`
                );
              }
              if (acceptedQuote?.tradespersonId) {
                await sendNotification(
                  acceptedQuote.tradespersonId,
                  `🧾 Invoice Generated: ${authoritativeInvoice.invoiceNumber}`,
                  `An official ${isPro ? "Pro Branded" : "Free Standard"} invoice for "${job.title}" (£${Number(authoritativeInvoice.totalAmount || 0).toFixed(2)}) was generated.`,
                  "system",
                  `/job/${jobId}`
                );
              }

              if (isPro && tradespersonProfile?.autoSyncGoogleSheets) {
                await exportInvoicesToSheets([{
                  dateCreated: new Date().toLocaleDateString("en-GB"),
                  ref: authoritativeInvoice.invoiceNumber,
                  clientName: authoritativeInvoice.homeownerName,
                  serviceDescription: authoritativeInvoice.jobTitle,
                  subtotal: authoritativeInvoice.subtotal,
                  vat: authoritativeInvoice.vatAmount,
                  total: authoritativeInvoice.totalAmount,
                  status: authoritativeInvoice.status
                }]);
              }
            } catch (notifErr) {
              console.warn("Invoice notification failed non-blockingly:", notifErr);
            }
          }

          return authoritativeInvoice;
        }
      }
    }
  } catch (apiErr) {
    console.warn("Authoritative invoice API unavailable, falling back to read-only local invoice view:", apiErr);
  }

  // Fallback 1: Read existing invoice directly if permitted
  const invoiceRef = doc(db, "invoices", invoiceDocId);
  try {
    const existingSnap = await getDoc(invoiceRef);
    if (existingSnap.exists()) {
      return { id: existingSnap.id, ...existingSnap.data() } as InvoiceData;
    }
  } catch (err) {
    console.warn("Error reading existing invoice, generating read-only local preview:", err);
  }

  // Fallback 2: Compute read-only local invoice object without attempting restricted client writes
  // or fabricating placeholder bank details.
  const isPro = isProInvoiceUser(tradespersonProfile);
  const summary = calculateInvoiceSummary(acceptedQuote, job, tradespersonProfile);
  const { laborAmount, materialsAmount, platformFee, subtotal, vatAmount, totalAmount } = summary;
  const vatEvaluation = { eligible: summary.vatEligible, vatNumber: summary.vatNumber };

  const invoiceNumber = `INV-${new Date().getFullYear()}-${String(jobId || "").slice(-6).toUpperCase()}`;
  const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const bankName = typeof tradespersonProfile?.bankName === "string" ? tradespersonProfile.bankName.trim() : "";
  const sortCode = typeof tradespersonProfile?.sortCode === "string" ? tradespersonProfile.sortCode.trim() : "";
  const accountNumber = typeof tradespersonProfile?.accountNumber === "string" ? tradespersonProfile.accountNumber.trim() : "";
  const verifiedBankDetails =
    isPro && bankName && sortCode && accountNumber
      ? { bankName, sortCode, accountNumber }
      : undefined;

  const invoiceData: InvoiceData = {
    invoiceNumber,
    jobId,
    jobTitle: job.title || "Trade Service",
    category: job.category || "General Trade",
    postcode: job.postcode || "UK",
    homeownerId: job.homeownerId,
    homeownerName: homeownerProfile?.name || job.homeownerName || "Homeowner",
    homeownerEmail: homeownerProfile?.email || job.homeownerEmail || "",
    homeownerAddress: job.address || job.postcode || "",
    tradespersonId: acceptedQuote?.tradespersonId,
    tradespersonName: tradespersonProfile?.name || tradespersonProfile?.businessName || "Tradesperson",
    tradespersonBusinessName: tradespersonProfile?.businessName || tradespersonProfile?.companyName || tradespersonProfile?.name || "Independent Tradesperson",
    tradespersonVatNumber: vatEvaluation.eligible ? vatEvaluation.vatNumber : "",
    tradespersonLogoUrl: tradespersonProfile?.photoURL || tradespersonProfile?.logoUrl || "",
    tradespersonPhone: tradespersonProfile?.phone || tradespersonProfile?.phoneNumber || "",
    ...(verifiedBankDetails ? { tradespersonBankDetails: verifiedBankDetails } : {}),
    tier: isPro ? "pro" : "free",
    status: job.isPaid || job.paymentStatus === "paid" || job.paymentStatus === "handshake_complete" ? "paid" : "unpaid",
    createdAt: new Date().toISOString(),
    dueDate,
    laborAmount,
    materialsAmount,
    platformFee,
    subtotal,
    vatAmount,
    totalAmount,
    isBrandedPro: isPro,
    notes: isPro
      ? (tradespersonProfile?.customInvoiceNotes || "Thank you for choosing a Verified AnyTrader Pro! Payment due within 14 days.")
      : "Automated standard invoice generated via AnyTrader Platform."
  };

  return { id: invoiceDocId, ...invoiceData };
}

/**
 * Downloads a high-quality PDF invoice using jsPDF.
 */
export async function downloadInvoicePDF(invoice: InvoiceData): Promise<void> {
  const { default: jsPDF } = await import("jspdf");
  const doc = new jsPDF();
  const isPro = invoice.isBrandedPro;

  // Header Background
  if (isPro) {
    // Elegant Dark Slate Header for Pro
    doc.setFillColor(15, 23, 42); // slate-900
    doc.rect(0, 0, 210, 45, "F");

    // Gold Accent Stripe
    doc.setFillColor(251, 191, 36); // amber-400
    doc.rect(0, 43, 210, 2, "F");

    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text((invoice.tradespersonBusinessName || invoice.tradespersonName || "INDEPENDENT TRADER").toUpperCase(), 15, 20);

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(226, 232, 240);
    doc.text(`⚡ Verified Trader • Powered by AnyTrader`, 15, 28);
    if (invoice.tradespersonVatNumber) {
      doc.text(`VAT Reg No: ${invoice.tradespersonVatNumber}`, 15, 34);
    } else if (invoice.tradespersonPhone) {
      doc.text(`Contact: ${invoice.tradespersonPhone}`, 15, 34);
    }

    // Right Align Invoice Number
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(251, 191, 36);
    doc.text(invoice.invoiceNumber, 195, 20, { align: "right" });
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(226, 232, 240);
    doc.text(`Date: ${new Date().toLocaleDateString("en-GB")}`, 195, 28, { align: "right" });
    doc.text(`Status: ${invoice.status.toUpperCase()}`, 195, 34, { align: "right" });
  } else {
    // Clean Standard Header for Free
    doc.setFillColor(241, 245, 249); // slate-100
    doc.rect(0, 0, 210, 42, "F");

    doc.setTextColor(15, 23, 42);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text((invoice.tradespersonBusinessName || invoice.tradespersonName || "INDEPENDENT TRADER").toUpperCase(), 15, 20);

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(71, 85, 105);
    doc.text("Official Trade Invoice • Powered by AnyTrader", 15, 28);
    if (invoice.tradespersonPhone) {
      doc.text(`Contact: ${invoice.tradespersonPhone}`, 15, 34);
    }

    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(15, 23, 42);
    doc.text(invoice.invoiceNumber, 195, 20, { align: "right" });
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(`Date: ${new Date().toLocaleDateString("en-GB")}`, 195, 28, { align: "right" });
    doc.text(`Status: ${invoice.status.toUpperCase()}`, 195, 34, { align: "right" });
  }

  let y = 58;

  // Billed To & Trader Info
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(15, 23, 42);
  doc.text("BILLED TO:", 15, y);
  doc.text("TRADESPERSON / SERVICE PROVIDER:", 110, y);

  y += 6;
  doc.setFont("helvetica", "normal");
  doc.setTextColor(51, 65, 85);
  doc.text(invoice.homeownerName, 15, y);
  doc.text(invoice.tradespersonName, 110, y);

  y += 5;
  if (invoice.homeownerAddress) doc.text(invoice.homeownerAddress, 15, y);
  doc.text(invoice.tradespersonBusinessName || "Independent Trader", 110, y);

  y += 5;
  if (invoice.homeownerEmail) doc.text(invoice.homeownerEmail, 15, y);
  if (invoice.tradespersonPhone) doc.text(`Phone: ${invoice.tradespersonPhone}`, 110, y);

  y += 15;

  // Job Reference Box
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(15, y, 180, 16, 2, 2, "FD");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text(`Job Description: ${invoice.jobTitle}`, 20, y + 7);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(`Category: ${invoice.category} • Location: ${invoice.postcode}`, 20, y + 12);

  y += 26;

  // Table Header
  doc.setFillColor(15, 23, 42);
  doc.rect(15, y, 180, 8, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("ITEM DESCRIPTION", 20, y + 5.5);
  doc.text("AMOUNT (£)", 185, y + 5.5, { align: "right" });

  y += 8;

  // Table Items
  doc.setFont("helvetica", "normal");
  doc.setTextColor(30, 41, 59);

  // Recompute display figures consistently so printed lines + summary always sum identically
  const materialsAmount = Math.round(Number(invoice.materialsAmount || 0) * 100) / 100;
  const rawLaborAmount = Math.round(Number(invoice.laborAmount || 0) * 100) / 100;
  const platformFee = Math.round(Number(invoice.platformFee || 0) * 100) / 100;
  const expectedSubtotal = Math.round((rawLaborAmount + materialsAmount) * 100) / 100;
  const subtotal = Math.round(Number(invoice.subtotal ?? expectedSubtotal) * 100) / 100;
  const vatAmount = Math.round(Number(invoice.vatAmount || 0) * 100) / 100;
  const totalAmount = Math.round((subtotal + vatAmount) * 100) / 100;
  const showSplitCommission = platformFee > 0 && rawLaborAmount >= platformFee;
  const netLaborLine = showSplitCommission
    ? Math.round((rawLaborAmount - platformFee) * 100) / 100
    : rawLaborAmount;

  // Line 1: Labor (Net of Platform Allocation if itemized below)
  doc.text(
    showSplitCommission ? "Trade Labour & Professional Works (Net of Platform Fee)" : "Trade Labour & Professional Works",
    20,
    y + 6
  );
  doc.text(`£${netLaborLine.toFixed(2)}`, 185, y + 6, { align: "right" });
  doc.line(15, y + 9, 195, y + 9);
  y += 9;

  // Line 2: Materials (if any)
  if (materialsAmount > 0) {
    doc.text("Materials & Parts Procurement", 20, y + 6);
    doc.text(`£${materialsAmount.toFixed(2)}`, 185, y + 6, { align: "right" });
    doc.line(15, y + 9, 195, y + 9);
    y += 9;
  }

  // Line 3: AnyTrader Service Fee (strictly additive so netLaborLine + materialsAmount + platformFee === subtotal)
  if (platformFee > 0) {
    doc.text("AnyTrader Platform Processing & Guarantee Service Fee", 20, y + 6);
    doc.text(`£${platformFee.toFixed(2)}`, 185, y + 6, { align: "right" });
    doc.line(15, y + 9, 195, y + 9);
    y += 9;
  }
  y += 3;

  // Totals Section (Right Aligned)
  const totalX = 130;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text("Subtotal:", totalX, y);
  doc.text(`£${subtotal.toFixed(2)}`, 185, y, { align: "right" });

  if (vatAmount > 0) {
    y += 5;
    doc.text("VAT (20%):", totalX, y);
    doc.text(`£${vatAmount.toFixed(2)}`, 185, y, { align: "right" });
  }

  y += 7;
  doc.setFillColor(15, 23, 42);
  doc.rect(totalX - 5, y - 4, 70, 10, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(255, 255, 255);
  doc.text(invoice.status === "paid" ? "TOTAL PAID:" : "TOTAL DUE:", totalX, y + 3);
  doc.text(`£${totalAmount.toFixed(2)}`, 185, y + 3, { align: "right" });

  y += 20;

  // Pro Bank Details (only render when trader has saved genuine bank details)
  const bankName = invoice.tradespersonBankDetails?.bankName?.trim();
  const sortCode = invoice.tradespersonBankDetails?.sortCode?.trim();
  const accountNumber = invoice.tradespersonBankDetails?.accountNumber?.trim();
  if (isPro && bankName && sortCode && accountNumber) {
    doc.setFillColor(241, 245, 249);
    doc.roundedRect(15, y, 180, 22, 2, 2, "F");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text("DIRECT BANK TRANSFER PAYMENT DETAILS (PRO BRANDED):", 20, y + 6);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(51, 65, 85);
    doc.text(`Bank: ${bankName}`, 20, y + 12);
    doc.text(`Sort Code: ${sortCode}`, 80, y + 12);
    doc.text(`Account No: ${accountNumber}`, 140, y + 12);
    doc.text(`Reference: ${invoice.invoiceNumber}`, 20, y + 17);

    y += 28;
  }

  // Footer Notes
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(invoice.notes || "Thank you for using AnyTrader.", 15, y);

  y += 12;
  doc.setFont("helvetica", "bold");
  doc.setTextColor(148, 163, 184);
  doc.text(`Powered by AnyTrader • Issued on behalf of ${invoice.tradespersonBusinessName || invoice.tradespersonName}`, 105, 285, { align: "center" });

  // Save PDF file
  doc.save(`${invoice.invoiceNumber}.pdf`);
}
