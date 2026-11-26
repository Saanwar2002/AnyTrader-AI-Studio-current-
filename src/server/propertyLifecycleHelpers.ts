/**
 * Pure server-side helpers for property tenant context sanitization and
 * tenant issue creation payload resolution (Slice 5).
 */

export interface TenantPropertyContext {
  id: string;
  name: string;
  outwardPostcode: string;
  city: string;
  propertyType: string;
}

export function extractOutwardPostcode(raw: unknown): string {
  const cleaned = String(raw || "").trim().toUpperCase();
  if (!cleaned) return "";
  if (cleaned.includes(" ")) {
    return cleaned.split(/\s+/)[0].slice(0, 8);
  }
  return cleaned.length > 4 ? cleaned.slice(0, cleaned.length - 3).slice(0, 8) : cleaned.slice(0, 8);
}

/**
 * Produces a minimal, privacy-safe property summary for the unauthenticated
 * Tenant Repair Portal (`/tenant-report?propertyId=...`).
 * Never exposes street line1, full postcode, landlord/tenant PII, or access codes.
 */
export function sanitizePropertyTenantContext(
  propertyId: string,
  propData: Record<string, any>
): TenantPropertyContext {
  const rawPostcode = propData?.address?.postcode || propData?.postcode || "";
  const rawCity = propData?.address?.city || propData?.city || "";
  return {
    id: String(propertyId || "").trim(),
    name: String(propData?.name || "Managed Property").trim().slice(0, 160),
    outwardPostcode: extractOutwardPostcode(rawPostcode),
    city: String(rawCity).trim().slice(0, 100),
    propertyType: String(propData?.propertyType || "Property").trim().slice(0, 80),
  };
}

export interface ResolvedTenantIssuePayload {
  propertyId: string;
  propertyName: string;
  address: string;
  postcode: string;
  landlordOwnerId: string | null;
  linkedToLandlord: boolean;
  tenantName: string;
  tenantPhone: string;
  tenantEmail: string;
  flatUnit: string;
  category: string;
  urgency: "emergency" | "urgent" | "routine";
  title: string;
  description: string;
}

export class TenantIssueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantIssueValidationError";
  }
}

/**
 * Validates and resolves a tenant repair report submission.
 * - Rejects client-forged `landlordOwnerId`.
 * - For linked properties, derives `landlordOwnerId`, `propertyName`, `address`,
 *   and `postcode` exclusively from the authoritative Firestore property record.
 * - For manual submissions (no `propDoc`), preserves `manualAddress` (falling back
 *   to `address` or `propertyName` if supplied by legacy clients) and optional `postcode`.
 */
export function resolveTenantIssueCreationPayload(
  body: Record<string, any>,
  propDoc: { id: string; data: Record<string, any> } | null
): ResolvedTenantIssuePayload {
  const tenantName = typeof body?.tenantName === "string" ? body.tenantName.trim().slice(0, 120) : "";
  const tenantPhone = typeof body?.tenantPhone === "string" ? body.tenantPhone.trim().slice(0, 40) : "";
  const tenantEmail = typeof body?.tenantEmail === "string" ? body.tenantEmail.trim().toLowerCase().slice(0, 160) : "";
  const flatUnit = typeof body?.flatUnit === "string" ? body.flatUnit.trim().slice(0, 60) : "";
  const category =
    typeof body?.category === "string" && body.category.trim()
      ? body.category.trim().slice(0, 80)
      : "General Maintenance";
  const rawUrgency = String(body?.urgency || "").toLowerCase();
  const urgency: "emergency" | "urgent" | "routine" =
    rawUrgency === "emergency" || rawUrgency === "urgent" || rawUrgency === "routine"
      ? rawUrgency
      : "urgent";
  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 160) : "";
  const description = typeof body?.description === "string" ? body.description.trim().slice(0, 3000) : "";

  if (!tenantName || !title || !description) {
    throw new TenantIssueValidationError("Tenant name, issue title, and description are required.");
  }

  if (body?.landlordOwnerId !== undefined && body?.landlordOwnerId !== null && body?.landlordOwnerId !== "") {
    throw new TenantIssueValidationError(
      "landlordOwnerId is derived server-side from the authoritative property record."
    );
  }

  const rawManualAddress =
    typeof body?.manualAddress === "string" && body.manualAddress.trim()
      ? body.manualAddress.trim()
      : typeof body?.address === "string" && body.address.trim()
        ? body.address.trim()
        : typeof body?.propertyName === "string" && body.propertyName.trim()
          ? body.propertyName.trim()
          : "";
  const manualAddress = rawManualAddress.slice(0, 240);
  const manualPostcode =
    typeof body?.postcode === "string" ? body.postcode.trim().toUpperCase().slice(0, 20) : "";

  if (propDoc) {
    const propData = propDoc.data || {};
    const authoritativeLandlordId =
      String(propData.ownerId || propData.userId || propData.landlordId || "").trim() || null;
    const propertyName = String(propData.name || manualAddress || "Home Property").trim().slice(0, 160);
    const address = String(propData.address?.line1 || manualAddress || "UK Address").trim().slice(0, 200);
    const postcode = String(propData.address?.postcode || propData.postcode || manualPostcode || "")
      .trim()
      .toUpperCase()
      .slice(0, 20);

    return {
      propertyId: propDoc.id,
      propertyName,
      address,
      postcode,
      landlordOwnerId: authoritativeLandlordId,
      linkedToLandlord: Boolean(authoritativeLandlordId),
      tenantName,
      tenantPhone,
      tenantEmail,
      flatUnit,
      category,
      urgency,
      title,
      description,
    };
  }

  return {
    propertyId: "manual",
    propertyName: manualAddress || "Home Property",
    address: manualAddress || "UK Address",
    postcode: manualPostcode,
    landlordOwnerId: null,
    linkedToLandlord: false,
    tenantName,
    tenantPhone,
    tenantEmail,
    flatUnit,
    category,
    urgency,
    title,
    description,
  };
}
