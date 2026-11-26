/**
 * AnyTrader Public Projections Engine
 * Transforms private operational /jobs, /properties, and /advertisements documents into sanitized
 * /public_job_cards, /public_properties, and /public_ads records for anonymous & public discovery
 * without exposing homeowner PII, exact addresses, private attachments, budgets, CPCs, or internal config.
 *
 * Remediates: AT-PROJ-01, AT-PROJ-02, AT-JOB-PUB-01, AT-JOB-PUB-02, AT-PASS-03, AT-PASS-07, AT-PROP-08, AT-ADS-13
 */

import type admin from "firebase-admin";

export const MAX_PROJECTION_BATCH_OPS = 450;

export interface PublicJobCard {
  id: string;
  jobNo?: string;
  category: string;
  subCategory?: string;
  title: string;
  description: string;
  postcodeArea?: string; // Outward code only (e.g. "EC1A", "SW1A")
  city?: string;
  area?: string;
  urgency?: string;
  status: string;
  estimateMin?: number;
  estimateMax?: number;
  postedDate?: any;
  createdAt?: any;
  updatedAt?: any;
  quoteCount?: number;
  isBoosted?: boolean;
  boostTier?: string | null;
  isInstantMatch?: boolean;
  exclusiveUntil?: any;
  photosCount?: number;
  videosCount?: number;
  documentsCount?: number;
  [key: string]: any;
}

export interface PublicPropertyPassport {
  id: string;
  name?: string;
  propertyType?: string;
  postcodeArea?: string; // Outward postcode only (e.g. "SW1A", "EC1A")
  city?: string;
  epcRating?: string | null;
  roofCondition?: string | null;
  boilerInfo?: {
    brand?: string | null;
    model?: string | null;
    age?: string | number | null;
    lastServiced?: string | null;
  } | null;
  gasSafetyExpiry?: string | null;
  eicrExpiry?: string | null;
  isPublicPassport: boolean;
  publicConsent: boolean;
  status?: string;
  createdAt?: any;
  updatedAt?: any;
  address?: {
    city?: string;
    postcode?: string; // Redacted to outward code only
    country?: string;
  };
  [key: string]: any;
}

export interface PublicAdProjection {
  id: string;
  type: string;
  title: string;
  description: string;
  tagline?: string;
  url?: string;
  bgColor?: string;
  gradient?: string;
  iconName?: string;
  imageUrl?: string;
  placement?: string;
  targetRole?: string;
  targetCategories?: string[];
  promotionRadius?: string | number;
  isTraderAd: boolean;
  isVerifiedAdvertiser: boolean;
  badgeLabel?: string;
  perkText?: string;
  voucherCode?: string;
  advertiserName?: string;
  targetProfileId?: string; // Only set for trader_promo / profile links; never exposes private advertiserUid on non-trader ads
  postcodeArea?: string;
  lat?: number;
  lng?: number;
  isActive: boolean;
  approvalStatus: "approved";
  hasAvailableBudget: boolean;
  endDate?: string | null;
  updatedAt?: any;
}

const PUBLIC_JOB_DISCOVERY_STATUSES = new Set(["posted", "quoting", "quoted", "in_bidding", "open"]);

/**
 * Extracts outward postcode safely (e.g., "SW1A 1AA" -> "SW1A", "EC1" -> "EC1").
 * Returns empty string if input does not contain a valid UK outward postcode pattern.
 */
export function extractOutwardPostcode(postcode?: string): string {
  if (!postcode || typeof postcode !== "string") return "";
  const cleaned = postcode.trim().toUpperCase();
  if (!cleaned) return "";

  const fullMatch = cleaned.match(/\b([A-Z]{1,2}[0-9][A-Z0-9]?)\s*([0-9][A-Z]{2})\b/);
  if (fullMatch && fullMatch[1]) {
    return fullMatch[1].toUpperCase();
  }

  const standaloneOutward = cleaned.match(/\b([A-Z]{1,2}[0-9][A-Z0-9]?)\b/);
  if (standaloneOutward && standaloneOutward[1]) {
    return standaloneOutward[1].toUpperCase();
  }

  return "";
}

const UK_STREET_SUFFIX_PATTERN =
  "Road|Rd|Street|St|Avenue|Ave|Lane|Ln|Drive|Dr|Close|Cl|Way|Gardens|Gdns|Place|Pl|Square|Sq|Terrace|Terr|Crescent|Cres|Court|Ct|Walk|Grove|Grv|Hill|Park|Pk|Mews|View|Rise|Row|Green|Parade|Estate|Bypass|Broadway|Circus|Quay|Wharf|Villas|Bungalows|Cottages";

/**
 * AT-JOB-PUB-02:
 * Redacts PII patterns (emails, UK/intl phone numbers, full UK postcodes, flat/unit/apt numbers,
 * and UK street addresses with optional house/door numbers) from public marketplace text.
 */
export function sanitizePublicDescription(rawDescription?: string): string {
  if (!rawDescription || typeof rawDescription !== "string") return "";
  let sanitized = rawDescription;

  // Redact emails
  sanitized = sanitized.replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, "[Contact Info Redacted]");

  // Redact UK / International phone numbers
  sanitized = sanitized.replace(/(?:(?:\+44\s?\(0\)\s?|\+44\s?|0)(?:\d[\s-]?){9,10}\d)/g, "[Phone Redacted]");

  // Redact Flat / Apartment / Unit / Door / House numbers (e.g. "Flat 4B", "Apt 12", "Unit 3", "No. 42", "House 14")
  sanitized = sanitized.replace(
    /\b(?:Flat|Apartment|Apt\.?|Unit|Room|Suite|Plot|Door|House|No\.?)\s*\d+[A-Za-z]?(?:\s*[-/]\s*\d+[A-Za-z]?)?\b/gi,
    "[Address Redacted]"
  );

  // Redact numbered UK street addresses (e.g. "42 Baker Street", "14A High Rd", "108 St John's Avenue")
  const numberedStreetRegex = new RegExp(
    `\\b\\d+[A-Za-z]?(?:\\s*[-/]\\s*\\d+[A-Za-z]?)?\\s+(?:[A-Za-z0-9'’.-]+\\s+){1,4}(?:${UK_STREET_SUFFIX_PATTERN})\\.?\\b`,
    "gi"
  );
  sanitized = sanitized.replace(numberedStreetRegex, "[Address Redacted]");

  // Redact unnumbered street names (e.g. "on Baker Street", "at Victoria Road")
  const namedStreetRegex = new RegExp(
    `\\b(?:[A-Z][a-z'’-]+\\s+){1,3}(?:${UK_STREET_SUFFIX_PATTERN})\\.?\\b`,
    "g"
  );
  sanitized = sanitized.replace(namedStreetRegex, "[Street Redacted]");

  // Redact full UK postcodes (e.g. SW1A 1AA, EC1V 2NX) down to outward code only
  sanitized = sanitized.replace(/\b([A-Z]{1,2}[0-9][A-Z0-9]?)\s*([0-9][A-Z]{2})\b/gi, "$1 ***");

  // Collapse repeated redaction tokens cleanly
  sanitized = sanitized.replace(/(?:\[(?:Address|Street) Redacted\]\s*,?\s*){2,}/g, "[Address Redacted] ");

  return sanitized.trim();
}

/**
 * Sanitizes a city/town label so caller-supplied street lines cannot leak via `city` or `area`.
 */
function sanitizeCoarseCity(rawCity?: unknown): string | undefined {
  if (typeof rawCity !== "string") return undefined;
  const cleaned = sanitizePublicDescription(rawCity)
    .replace(/\[(?:Address|Street|Phone|Contact Info) Redacted\]/g, "")
    .replace(/\b[A-Z]{1,2}[0-9][A-Z0-9]?\s*\*{0,3}\b/gi, "")
    .replace(/[0-9]+/g, "")
    .replace(/[•,|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 2 || cleaned.length > 60) return undefined;
  if (/^(home|property|area hidden|area on request|uk|local area)$/i.test(cleaned)) return undefined;
  return cleaned;
}

/**
 * Checks if a job is a 1-to-1 direct / targeted quote request meant for a specific tradesperson.
 */
export function isDirectJob(jobData: Record<string, any>): boolean {
  return Boolean(
    jobData.isDirectJob === true ||
    jobData.targetTradespersonId ||
    jobData.targetTraderId ||
    jobData.directTraderId ||
    jobData.isDirectQuote ||
    jobData.isTargeted ||
    jobData.visibility === "private" ||
    jobData.visibility === "direct"
  );
}

export function isJobEligibleForPublicCard(jobData: Record<string, any>): boolean {
  if (!jobData) return false;
  if (jobData.clientDeleted === true) return false;
  if (isDirectJob(jobData)) return false;
  return PUBLIC_JOB_DISCOVERY_STATUSES.has(String(jobData.status || "").toLowerCase());
}

/**
 * AT-JOB-PUB-01 & AT-JOB-PUB-02:
 * Transforms a private /jobs document into a public-safe /public_job_cards projection.
 * Strictly derives coarse location from outward postcode + sanitized city (never raw caller-supplied street `area`).
 */
export function sanitizeJobToPublicCard(jobId: string, jobData: Record<string, any>): PublicJobCard {
  const outwardCode =
    extractOutwardPostcode(jobData.postcode) ||
    extractOutwardPostcode(jobData.address?.postcode) ||
    extractOutwardPostcode(jobData.postcodeArea) ||
    extractOutwardPostcode(jobData.area);

  const coarseCity = sanitizeCoarseCity(jobData.city || jobData.address?.city || jobData.address?.town);
  const coarseArea = outwardCode
    ? (coarseCity ? `${outwardCode} • ${coarseCity}` : outwardCode)
    : (coarseCity || "Local Area");

  const sanitizedTitle = sanitizePublicDescription(jobData.title) || "Trade Job";
  const sanitizedDescription = sanitizePublicDescription(jobData.description);

  const resolvedSubCategory =
    typeof jobData.subCategory === "string" && jobData.subCategory.trim()
      ? jobData.subCategory.trim()
      : typeof jobData.subcategory === "string" && jobData.subcategory.trim()
      ? jobData.subcategory.trim()
      : Array.isArray(jobData.subcategories) && typeof jobData.subcategories[0] === "string" && jobData.subcategories[0].trim()
      ? jobData.subcategories[0].trim()
      : undefined;

  const safeRequiredCertifications = Array.isArray(jobData.requiredCertifications)
    ? jobData.requiredCertifications
        .filter((c: unknown): c is string => typeof c === "string" && c.trim().length > 0)
        .map((c: string) => c.trim().slice(0, 80))
        .slice(0, 10)
    : undefined;

  return {
    id: jobId,
    jobNo: jobData.jobNo || undefined,
    category: jobData.category || "General",
    subCategory: resolvedSubCategory,
    title: sanitizedTitle,
    description: sanitizedDescription,
    postcodeArea: outwardCode || coarseCity || "Local Area",
    city: coarseCity,
    area: coarseArea,
    urgency: jobData.urgency || "standard",
    urgencyLabel: jobData.urgencyLabel || jobData.urgency || "standard",
    preferredDate: jobData.preferredDate || jobData.jobDate || undefined,
    quoteScope: jobData.quoteScope || undefined,
    paymentPreference: jobData.paymentPreference || undefined,
    estimatedCompletionTime: jobData.estimatedCompletionTime || undefined,
    estimatedCompletionTimeUnit: jobData.estimatedCompletionTimeUnit || undefined,
    status: jobData.status || "open",
    estimateMin: typeof jobData.estimateMin === "number" ? jobData.estimateMin : undefined,
    estimateMax: typeof jobData.estimateMax === "number" ? jobData.estimateMax : undefined,
    postedDate: jobData.postedDate || jobData.createdAt || undefined,
    createdAt: jobData.createdAt || undefined,
    updatedAt: jobData.updatedAt || undefined,
    quoteCount: typeof jobData.quoteCount === "number" ? jobData.quoteCount : 0,
    isBoosted: Boolean(jobData.isBoosted),
    boostTier: jobData.boostTier || null,
    isInstantMatch: Boolean(jobData.isInstantMatch),
    exclusiveUntil: jobData.exclusiveUntil || null,
    ...(safeRequiredCertifications && safeRequiredCertifications.length > 0
      ? { requiredCertifications: safeRequiredCertifications }
      : {}),
    photosCount: Array.isArray(jobData.photos) ? jobData.photos.length : (jobData.photosCount || 0),
    videosCount: Array.isArray(jobData.videos) ? jobData.videos.length : (jobData.videosCount || 0),
    documentsCount: Array.isArray(jobData.documents) ? jobData.documents.length : (jobData.documentsCount || 0),
  };
}

/**
 * AT-PROJ-02:
 * Helper that commits Firestore write operations in safe chunks (`<= MAX_PROJECTION_BATCH_OPS`),
 * instantiating a fresh WriteBatch for every chunk so committed batches are never reused.
 */
async function commitOperationsInChunks(
  firestoreDb: admin.firestore.Firestore,
  operations: Array<{ type: "set" | "delete"; ref: any; data?: Record<string, any> }>,
  chunkSize: number = MAX_PROJECTION_BATCH_OPS
): Promise<number> {
  if (operations.length === 0) return 0;
  const safeLimit = Math.max(1, Math.min(450, chunkSize));
  let batchesCommitted = 0;

  for (let i = 0; i < operations.length; i += safeLimit) {
    const slice = operations.slice(i, i + safeLimit);
    const batch = firestoreDb.batch();
    for (const op of slice) {
      if (op.type === "set") {
        batch.set(op.ref, op.data || {}, { merge: true });
      } else {
        batch.delete(op.ref);
      }
    }
    await batch.commit();
    batchesCommitted++;
  }

  return batchesCommitted;
}

/**
 * Real-time background sync listener that mirrors /jobs state to /public_job_cards.
 * Instantiates a fresh Firestore WriteBatch for each chunk (AT-PROJ-02).
 */
export function startPublicJobCardsSync(firestoreDb: admin.firestore.Firestore): () => void {
  try {
    let unsubscribe: (() => void) | null = null;
    unsubscribe = firestoreDb.collection("jobs").onSnapshot(
      async (snapshot) => {
        const ops: Array<{ type: "set" | "delete"; ref: any; data?: Record<string, any> }> = [];

        for (const change of snapshot.docChanges()) {
          const docId = change.doc.id;
          const data = change.doc.data();
          const publicRef = firestoreDb.collection("public_job_cards").doc(docId);

          if (change.type === "removed" || !isJobEligibleForPublicCard(data)) {
            ops.push({ type: "delete", ref: publicRef });
          } else {
            ops.push({
              type: "set",
              ref: publicRef,
              data: sanitizeJobToPublicCard(docId, data),
            });
          }
        }

        await commitOperationsInChunks(firestoreDb, ops, MAX_PROJECTION_BATCH_OPS);
      },
      (error: any) => {
        const msg = error?.message || String(error);
        if (
          error?.code === 7 ||
          msg.includes("7") ||
          msg.includes("PERMISSION_DENIED") ||
          msg.includes("Missing or insufficient permissions") ||
          msg.includes("UNAUTHENTICATED") ||
          msg.includes("Could not load the default credentials")
        ) {
          if (unsubscribe) {
            try { unsubscribe(); } catch {}
          }
          return;
        }
        console.warn("[PublicJobCardsSync] Firestore listener notice:", msg);
      }
    );

    return unsubscribe || (() => {});
  } catch {
    return () => {};
  }
}

/**
 * AT-PROJ-01 & AT-PROJ-02:
 * Manual backfill migration helper to sync all active public marketplace jobs to /public_job_cards
 * AND actively retract stale/direct/completed/deleted cards already in /public_job_cards,
 * chunked with fresh batches <= 450 ops.
 */
export async function backfillPublicJobCards(
  firestoreDb: admin.firestore.Firestore,
  chunkSize: number = MAX_PROJECTION_BATCH_OPS
): Promise<{ total: number; synced: number; retracted: number; batchesCommitted: number }> {
  const [jobsSnap, existingPublicSnap] = await Promise.all([
    firestoreDb.collection("jobs").get(),
    firestoreDb.collection("public_job_cards").get(),
  ]);

  const ops: Array<{ type: "set" | "delete"; ref: any; data?: Record<string, any> }> = [];
  const eligibleIds = new Set<string>();
  let synced = 0;

  for (const doc of jobsSnap.docs) {
    const data = doc.data();
    if (isJobEligibleForPublicCard(data)) {
      eligibleIds.add(doc.id);
      ops.push({
        type: "set",
        ref: firestoreDb.collection("public_job_cards").doc(doc.id),
        data: sanitizeJobToPublicCard(doc.id, data),
      });
      synced++;
    }
  }

  let retracted = 0;
  for (const pubDoc of existingPublicSnap.docs || []) {
    if (!eligibleIds.has(pubDoc.id)) {
      ops.push({
        type: "delete",
        ref: firestoreDb.collection("public_job_cards").doc(pubDoc.id),
      });
      retracted++;
    }
  }

  const batchesCommitted = await commitOperationsInChunks(firestoreDb, ops, chunkSize);

  return { total: jobsSnap.size, synced, retracted, batchesCommitted };
}

/**
 * AT-PASS-07 & AT-PROP-08:
 * Requires explicit affirmative public sharing consent AND active status before publishing.
 */
export function isPropertyEligibleForPublicPassport(propertyData: Record<string, any>): boolean {
  if (!propertyData) return false;
  return (
    propertyData.isPublicPassport === true &&
    propertyData.publicConsent === true &&
    propertyData.status !== "archived" &&
    propertyData.status !== "deleted"
  );
}

/**
 * Transforms a private /properties document into a public-safe /public_properties projection.
 * Strictly excludes PII/private fields and NEVER fabricates synthetic defaults ("C"/"Good"/"Standard")
 * when attributes are missing.
 */
export function sanitizePropertyToPublicPassport(
  propertyId: string,
  propertyData: Record<string, any>
): PublicPropertyPassport {
  const rawPostcode = propertyData.address?.postcode || propertyData.postcode || "";
  const outwardCode = extractOutwardPostcode(rawPostcode);
  const city = sanitizeCoarseCity(propertyData.address?.city || propertyData.city);

  const hasBoilerDetails =
    propertyData.boilerInfo &&
    typeof propertyData.boilerInfo === "object" &&
    (propertyData.boilerInfo.brand || propertyData.boilerInfo.model || propertyData.boilerInfo.age || propertyData.boilerInfo.lastServiced);

  return {
    id: propertyId,
    name: sanitizePublicDescription(propertyData.name) || "Verified Property",
    propertyType: propertyData.propertyType || "residential",
    postcodeArea: outwardCode || "UK Area",
    city: city || undefined,
    epcRating: propertyData.epcRating || null,
    roofCondition: propertyData.roofCondition || null,
    boilerInfo: hasBoilerDetails
      ? {
          brand: propertyData.boilerInfo.brand || null,
          model: propertyData.boilerInfo.model || null,
          age: propertyData.boilerInfo.age ?? null,
          lastServiced: propertyData.boilerInfo.lastServiced || null,
        }
      : null,
    gasSafetyExpiry: propertyData.gasSafetyExpiry || null,
    eicrExpiry: propertyData.eicrExpiry || null,
    isPublicPassport: propertyData.isPublicPassport === true,
    publicConsent: propertyData.publicConsent === true,
    status: propertyData.status || "active",
    createdAt: propertyData.createdAt || undefined,
    updatedAt: propertyData.updatedAt || undefined,
    address: {
      city: city || undefined,
      postcode: outwardCode ? `${outwardCode} ***` : undefined,
      country: propertyData.address?.country || "UK",
    },
  };
}

/**
 * Real-time background sync listener that mirrors /properties state to /public_properties.
 * Requires explicit publicConsent === true and chunks batches safely.
 */
export function startPublicPropertiesSync(firestoreDb: admin.firestore.Firestore): () => void {
  try {
    let unsubscribe: (() => void) | null = null;
    unsubscribe = firestoreDb.collection("properties").onSnapshot(
      async (snapshot) => {
        const ops: Array<{ type: "set" | "delete"; ref: any; data?: Record<string, any> }> = [];

        for (const change of snapshot.docChanges()) {
          const docId = change.doc.id;
          const data = change.doc.data();
          const publicRef = firestoreDb.collection("public_properties").doc(docId);

          if (change.type === "removed" || !isPropertyEligibleForPublicPassport(data)) {
            ops.push({ type: "delete", ref: publicRef });
          } else {
            ops.push({
              type: "set",
              ref: publicRef,
              data: sanitizePropertyToPublicPassport(docId, data),
            });
          }
        }

        await commitOperationsInChunks(firestoreDb, ops, MAX_PROJECTION_BATCH_OPS);
      },
      (error: any) => {
        const msg = error?.message || String(error);
        if (
          error?.code === 7 ||
          msg.includes("7") ||
          msg.includes("PERMISSION_DENIED") ||
          msg.includes("Missing or insufficient permissions") ||
          msg.includes("UNAUTHENTICATED") ||
          msg.includes("Could not load the default credentials")
        ) {
          if (unsubscribe) {
            try { unsubscribe(); } catch {}
          }
          return;
        }
        console.warn("[PublicPropertiesSync] Firestore listener notice:", msg);
      }
    );

    return unsubscribe || (() => {});
  } catch {
    return () => {};
  }
}

/**
 * AT-PASS-03, AT-PASS-07, AT-PROJ-02:
 * Manual backfill migration helper to sync eligible consented properties to /public_properties
 * AND retract stale / revoked / archived public property projections in fresh chunks <= 450 ops.
 */
export async function backfillPublicProperties(
  firestoreDb: admin.firestore.Firestore,
  chunkSize: number = MAX_PROJECTION_BATCH_OPS
): Promise<{ total: number; synced: number; retracted: number; batchesCommitted: number }> {
  const [propSnap, existingPublicSnap] = await Promise.all([
    firestoreDb.collection("properties").get(),
    firestoreDb.collection("public_properties").get(),
  ]);

  const ops: Array<{ type: "set" | "delete"; ref: any; data?: Record<string, any> }> = [];
  const eligibleIds = new Set<string>();
  let synced = 0;

  for (const doc of propSnap.docs) {
    const data = doc.data();
    if (isPropertyEligibleForPublicPassport(data)) {
      eligibleIds.add(doc.id);
      ops.push({
        type: "set",
        ref: firestoreDb.collection("public_properties").doc(doc.id),
        data: sanitizePropertyToPublicPassport(doc.id, data),
      });
      synced++;
    }
  }

  let retracted = 0;
  for (const pubDoc of existingPublicSnap.docs || []) {
    if (!eligibleIds.has(pubDoc.id)) {
      ops.push({
        type: "delete",
        ref: firestoreDb.collection("public_properties").doc(pubDoc.id),
      });
      retracted++;
    }
  }

  const batchesCommitted = await commitOperationsInChunks(firestoreDb, ops, chunkSize);

  return { total: propSnap.size, synced, retracted, batchesCommitted };
}

/**
 * AT-ADS-13:
 * Evaluates whether an /advertisements document is eligible for public projection into /public_ads.
 */
export function isAdEligibleForPublicProjection(adData: Record<string, any>, nowMs: number = Date.now()): boolean {
  if (!adData) return false;
  if (adData.approvalStatus !== "approved") return false;
  if (adData.isActive !== true) return false;
  if (adData.status === "paused" || adData.status === "paused_by_freeze" || adData.status === "rejected" || adData.status === "expired") {
    return false;
  }
  if (adData.endDate) {
    const endMs =
      typeof adData.endDate?.toMillis === "function"
        ? adData.endDate.toMillis()
        : typeof adData.endDate?.seconds === "number"
        ? adData.endDate.seconds * 1000
        : Date.parse(String(adData.endDate));
    if (Number.isFinite(endMs) && endMs <= nowMs) {
      return false;
    }
  }
  if (adData.billingCycle === "prepaid" && Number(adData.prepaidBalance || 0) <= 0) {
    return false;
  }
  return true;
}

function extractSafeTargetProfileId(adData: Record<string, any>): string | undefined {
  const isTraderPromo = Boolean(adData.isTraderAd || adData.type === "trader_promo" || adData.placement === "search_feed" || adData.placement === "both");
  if (!isTraderPromo) return undefined;
  const rawUrl = String(adData.url || "");
  const match = rawUrl.match(/\/profile\/([A-Za-z0-9_-]{3,128})/);
  if (match && match[1]) return match[1];
  if (typeof adData.targetProfileId === "string" && adData.targetProfileId.trim()) {
    return adData.targetProfileId.trim();
  }
  return undefined;
}

/**
 * AT-ADS-13:
 * Projects an approved, active advertisement into /public_ads without exposing owner UIDs
 * (advertiserUid/advertiserId), budgets, CPC rates, prepaid balances, auto-top-up settings,
 * moderation audit trails, or internal configuration fields.
 */
export function sanitizeAdToPublicAd(adId: string, adData: Record<string, any>): PublicAdProjection {
  const isTraderAd = Boolean(adData.isTraderAd || adData.type === "trader_promo");
  const targetProfileId = extractSafeTargetProfileId(adData);
  const rawEndDate = adData.endDate
    ? typeof adData.endDate?.toDate === "function"
      ? adData.endDate.toDate().toISOString()
      : String(adData.endDate)
    : null;

  const outwardPostcode = extractOutwardPostcode(adData.postcode || adData.postcodeArea);
  const projection: PublicAdProjection = {
    id: adId,
    type: String(adData.type || (isTraderAd ? "trader_promo" : "partner_banner")),
    title: String(adData.title || adData.advertiserName || "Featured Partner").slice(0, 140),
    description: String(adData.description || adData.tagline || "").slice(0, 300),
    tagline: typeof adData.tagline === "string" ? adData.tagline.slice(0, 200) : undefined,
    url: typeof adData.url === "string" ? adData.url.slice(0, 500) : undefined,
    bgColor: typeof adData.bgColor === "string" ? adData.bgColor : undefined,
    gradient: typeof adData.gradient === "string" ? adData.gradient : undefined,
    iconName: typeof adData.iconName === "string" ? adData.iconName : undefined,
    imageUrl: typeof adData.imageUrl === "string" ? adData.imageUrl : undefined,
    placement: typeof adData.placement === "string" ? adData.placement : "banner_ad",
    targetRole: typeof adData.targetRole === "string" ? adData.targetRole : "all",
    targetCategories: Array.isArray(adData.targetCategories)
      ? adData.targetCategories.filter((c): c is string => typeof c === "string").slice(0, 15)
      : ["all"],
    promotionRadius: adData.promotionRadius ?? "nationwide",
    isTraderAd,
    isVerifiedAdvertiser: Boolean(adData.isVerifiedAdvertiser),
    badgeLabel: typeof adData.badgeLabel === "string" ? adData.badgeLabel : (adData.isVerifiedAdvertiser ? "FEATURED PRO" : "SPONSORED"),
    perkText: typeof adData.perkText === "string" ? adData.perkText : undefined,
    voucherCode: typeof adData.voucherCode === "string" ? adData.voucherCode : undefined,
    advertiserName: typeof adData.advertiserName === "string" ? adData.advertiserName : undefined,
    targetProfileId,
    postcodeArea: outwardPostcode || undefined,
    lat: typeof adData.lat === "number" && Number.isFinite(adData.lat) ? adData.lat : undefined,
    lng: typeof adData.lng === "number" && Number.isFinite(adData.lng) ? adData.lng : undefined,
    isActive: true,
    approvalStatus: "approved",
    hasAvailableBudget: adData.billingCycle === "prepaid" ? Number(adData.prepaidBalance || 0) > 0 : true,
    endDate: rawEndDate,
    updatedAt: adData.updatedAt || new Date().toISOString(),
  };

  // Strip undefined properties so Firestore writes stay clean
  for (const key of Object.keys(projection) as Array<keyof PublicAdProjection>) {
    if (projection[key] === undefined) {
      delete projection[key];
    }
  }
  return projection;
}

/**
 * Real-time background sync listener that mirrors eligible /advertisements to /public_ads.
 */
export function startPublicAdsSync(firestoreDb: admin.firestore.Firestore): () => void {
  try {
    let unsubscribe: (() => void) | null = null;
    unsubscribe = firestoreDb.collection("advertisements").onSnapshot(
      async (snapshot) => {
        const ops: Array<{ type: "set" | "delete"; ref: any; data?: Record<string, any> }> = [];

        for (const change of snapshot.docChanges()) {
          const docId = change.doc.id;
          const data = change.doc.data();
          const publicRef = firestoreDb.collection("public_ads").doc(docId);

          if (change.type === "removed" || !isAdEligibleForPublicProjection(data)) {
            ops.push({ type: "delete", ref: publicRef });
          } else {
            ops.push({
              type: "set",
              ref: publicRef,
              data: sanitizeAdToPublicAd(docId, data),
            });
          }
        }

        await commitOperationsInChunks(firestoreDb, ops, MAX_PROJECTION_BATCH_OPS);
      },
      (error: any) => {
        const msg = error?.message || String(error);
        if (
          error?.code === 7 ||
          msg.includes("7") ||
          msg.includes("PERMISSION_DENIED") ||
          msg.includes("Missing or insufficient permissions") ||
          msg.includes("UNAUTHENTICATED") ||
          msg.includes("Could not load the default credentials")
        ) {
          if (unsubscribe) {
            try { unsubscribe(); } catch {}
          }
          return;
        }
        console.warn("[PublicAdsSync] Firestore listener notice:", msg);
      }
    );

    return unsubscribe || (() => {});
  } catch {
    return () => {};
  }
}

/**
 * Manual backfill migration helper to sync active approved ads to /public_ads and retract stale/paused ones.
 */
export async function backfillPublicAds(
  firestoreDb: admin.firestore.Firestore,
  chunkSize: number = MAX_PROJECTION_BATCH_OPS
): Promise<{ total: number; synced: number; retracted: number; batchesCommitted: number }> {
  const [adsSnap, existingPublicSnap] = await Promise.all([
    firestoreDb.collection("advertisements").get(),
    firestoreDb.collection("public_ads").get(),
  ]);

  const ops: Array<{ type: "set" | "delete"; ref: any; data?: Record<string, any> }> = [];
  const eligibleIds = new Set<string>();
  let synced = 0;

  for (const doc of adsSnap.docs) {
    const data = doc.data();
    if (isAdEligibleForPublicProjection(data)) {
      eligibleIds.add(doc.id);
      ops.push({
        type: "set",
        ref: firestoreDb.collection("public_ads").doc(doc.id),
        data: sanitizeAdToPublicAd(doc.id, data),
      });
      synced++;
    }
  }

  let retracted = 0;
  for (const pubDoc of existingPublicSnap.docs || []) {
    if (!eligibleIds.has(pubDoc.id)) {
      ops.push({
        type: "delete",
        ref: firestoreDb.collection("public_ads").doc(pubDoc.id),
      });
      retracted++;
    }
  }

  const batchesCommitted = await commitOperationsInChunks(firestoreDb, ops, chunkSize);
  return { total: adsSnap.size, synced, retracted, batchesCommitted };
}
