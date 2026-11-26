import crypto from "crypto";
import { z } from "zod";
import admin from "firebase-admin";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "./httpErrors.ts";
import {
  DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS,
  DEFAULT_PROVISIONAL_MAX_QUOTES,
  TRADER_COMPLIANCE_DECLARATION_SUMMARY,
  getRequiredCertificationsForTrades,
} from "../lib/traderCompliance.ts";
import { CURRENT_TERMS_VERSION } from "../constants/termsAndPrivacy.ts";

/**
 * Normalizes UK & international phone strings to digits-only canonical form
 * (converting +44 / 0044 prefixes to leading 0) before one-way hashing.
 */
export function normalizeUkPhoneForFingerprint(rawPhone: string): string {
  let digits = String(rawPhone || "").replace(/[^0-9+]/g, "");
  if (digits.startsWith("+44")) {
    digits = "0" + digits.slice(3);
  } else if (digits.startsWith("0044")) {
    digits = "0" + digits.slice(4);
  } else if (digits.startsWith("44") && digits.length >= 11) {
    digits = "0" + digits.slice(2);
  }
  digits = digits.replace(/\D/g, "");
  // Handle "+44 07..." accidental double-zero after country code
  if (digits.startsWith("00") && digits.length >= 12) {
    digits = digits.slice(1);
  }
  return digits;
}

/**
 * Computes a GDPR-safe one-way HMAC-SHA256 fingerprint of a phone number so
 * duplicate / re-registered profiles can be detected without retaining plaintext PII.
 */
export function computePhoneFingerprintHash(rawPhone: string, explicitPepper?: string): string {
  const normalized = normalizeUkPhoneForFingerprint(rawPhone);
  const pepper =
    explicitPepper ||
    process.env.PHONE_FINGERPRINT_PEPPER ||
    process.env.SESSION_SECRET ||
    "anytrader-gdpr-phone-fingerprint-v1";
  return crypto.createHmac("sha256", pepper).update(normalized).digest("hex");
}

const verificationDocInputSchema = z.object({
  type: z.string().trim().min(1).max(120),
  fileUrl: z.string().trim().url().max(2048).refine((url) => {
    try {
      const parsed = new URL(url);
      return (
        parsed.protocol === "https:" &&
        (parsed.hostname === "firebasestorage.googleapis.com" ||
          parsed.hostname.endsWith(".firebasestorage.app") ||
          parsed.hostname === "storage.googleapis.com")
      );
    } catch {
      return false;
    }
  }, "Verification documents must be uploaded to Firebase Storage."),
  storagePath: z.string().trim().min(1).max(512).optional(),
  fileName: z.string().trim().min(1).max(200).optional(),
  contentType: z.string().trim().max(100).optional(),
  uploadedAt: z.string().trim().max(64).optional(),
}).strict();

export const upgradeToTraderSchema = z.object({
  displayName: z.string().trim().min(2, "Please enter your name or trading name.").max(120),
  phone: z.string().trim().min(7, "Please enter a valid phone number.").max(32),
  postcode: z.string().trim().min(3, "Please enter your UK postcode.").max(10),
  city: z.string().trim().max(80).optional().default(""),
  county: z.string().trim().max(80).optional().default(""),
  bio: z.string().trim().min(15, "Please write a short description of your services (at least 15 characters).").max(1500),
  trades: z.array(z.string().trim().min(1).max(80)).min(1, "Select at least one trade category.").max(20),
  subcategories: z.array(z.string().trim().min(1).max(80)).max(50).optional().default([]),
  acceptedComplianceDeclaration: z
    .boolean()
    .refine(
      (val) => val === true,
      "You must accept the Terms & Conditions and confirm your business paperwork & insurance are in order."
    ),
  termsVersion: z.string().trim().max(40).optional(),
  verificationDocs: z.array(verificationDocInputSchema).max(20).optional().default([]),
}).strict();

export interface UpgradeToTraderResult {
  success: boolean;
  uid: string;
  role: "tradesperson";
  verificationStatus: "provisional" | "pending" | "unverified";
  requiresAdminVerification: boolean;
  duplicatePhoneFingerprintDetected: boolean;
  regulatedCategories: string[];
  requiredCertifications: string[];
  documentGracePeriodDays: number;
  provisionalMaxQuotes: number;
  documentGraceDeadlineAt: string | null;
  uploadedDocsCount: number;
}

/**
 * Authoritative server command that upgrades an existing Homeowner/Customer account
 * into a dual-role Homeowner + Tradesperson account while preserving all existing
 * homeowner jobs, saved cards, Landlord Pro subscriptions, and AnyRoller access.
 *
 * Explicitly keeps Property-only Businesses (`businessLayer === "properties"`),
 * Drivers, Admins, and existing Tradespeople out of scope to prevent unintended
 * role collisions.
 */
export async function executeUpgradeHomeownerToTraderCommand(
  firestoreDb: any,
  caller: { uid: string; email?: string | null },
  rawInput: unknown
): Promise<UpgradeToTraderResult> {
  if (!firestoreDb) {
    throw new BadRequestError("Database service unavailable");
  }

  const parseResult = upgradeToTraderSchema.safeParse(rawInput);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues?.[0]?.message || parseResult.error.message;
    throw new BadRequestError(firstIssue);
  }

  const input = parseResult.data;
  const cleanPostcode = input.postcode.toUpperCase().replace(/\s+/g, " ").trim();
  const dedupedTrades = Array.from(new Set(input.trades.map((t) => t.trim()).filter(Boolean)));
  const dedupedSubcategories = Array.from(new Set((input.subcategories || []).map((s) => s.trim()).filter(Boolean)));

  const now = new Date();
  const nowIso = now.toISOString();

  // Validate and sanitize uploaded documents (caller-owned Firebase Storage paths only)
  const incomingDocsMap = new Map<string, Record<string, any>>();
  for (const docItem of input.verificationDocs || []) {
    if (
      docItem.storagePath &&
      !docItem.storagePath.startsWith(`verifications/${caller.uid}/`) &&
      !docItem.storagePath.startsWith(`users/${caller.uid}/private/`)
    ) {
      throw new ForbiddenError("Verification document storage path must belong to the authenticated user.");
    }
    incomingDocsMap.set(docItem.type, {
      type: docItem.type,
      fileUrl: docItem.fileUrl,
      ...(docItem.storagePath ? { storagePath: docItem.storagePath } : {}),
      ...(docItem.fileName ? { fileName: docItem.fileName } : {}),
      ...(docItem.contentType ? { contentType: docItem.contentType } : {}),
      status: "pending",
      uploadedAt: docItem.uploadedAt || nowIso,
      createdAt: nowIso,
    });
  }

  // Server-authoritative certification requirement evaluation
  const certInfo = getRequiredCertificationsForTrades(dedupedTrades, dedupedSubcategories);
  const phoneFingerprintHash = computePhoneFingerprintHash(input.phone);

  const userRef = firestoreDb.collection("users").doc(caller.uid);
  const publicProfileRef = firestoreDb.collection("public_profiles").doc(caller.uid);
  const globalConfigRef = firestoreDb.collection("platform_config").doc("global");
  const phoneFingerprintRef = firestoreDb.collection("trader_phone_fingerprints").doc(phoneFingerprintHash);

  let result: UpgradeToTraderResult | null = null;

  await firestoreDb.runTransaction(async (tx: any) => {
    const [userSnap, publicSnap, configSnap, fingerprintSnap] = await Promise.all([
      tx.get(userRef),
      tx.get(publicProfileRef),
      tx.get(globalConfigRef),
      tx.get(phoneFingerprintRef),
    ]);

    const userExists = typeof userSnap?.exists === "function" ? userSnap.exists() : Boolean(userSnap?.exists);
    if (!userExists) {
      throw new NotFoundError("User profile not found. Complete initial signup first.");
    }

    const existingUser = (typeof userSnap.data === "function" ? userSnap.data() : userSnap.data) || {};
    const existingRole = String(existingUser.role || "").trim().toLowerCase();

    if (
      existingUser.isSuspended === true ||
      existingUser.isFrozen === true ||
      existingUser.isDisabled === true ||
      existingUser.banned === true
    ) {
      throw new ForbiddenError("Suspended or disabled accounts cannot upgrade to tradesperson.");
    }

    if (existingRole === "tradesperson" || existingRole === "contractor") {
      throw new ConflictError("Your account already has an active Tradesperson profile.");
    }

    if (existingRole !== "homeowner" && existingRole !== "customer") {
      throw new ForbiddenError(
        "Self-service Tradesperson activation is currently available for Homeowner accounts only."
      );
    }

    const globalCfg =
      (typeof configSnap?.exists === "function" ? configSnap.exists() : Boolean(configSnap?.exists))
        ? (typeof configSnap.data === "function" ? configSnap.data() : configSnap.data) || {}
        : {};

    const rawGraceDays = Number(globalCfg.documentGracePeriodDays);
    const gracePeriodDays =
      Number.isFinite(rawGraceDays) && rawGraceDays >= 0
        ? Math.floor(rawGraceDays)
        : DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS;
    const rawProvisionalMaxQuotes = Number(globalCfg.provisionalMaxQuotes);
    const provisionalMaxQuotes =
      Number.isFinite(rawProvisionalMaxQuotes) && rawProvisionalMaxQuotes >= 0
        ? Math.floor(rawProvisionalMaxQuotes)
        : DEFAULT_PROVISIONAL_MAX_QUOTES;
    const graceDeadlineIso =
      gracePeriodDays > 0
        ? new Date(now.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

    // GDPR-safe duplicate/re-registered phone check (prevents delete -> recreate provisional cycling)
    const fingerprintExists =
      typeof fingerprintSnap?.exists === "function" ? fingerprintSnap.exists() : Boolean(fingerprintSnap?.exists);
    const existingFingerprint = fingerprintExists
      ? (typeof fingerprintSnap.data === "function" ? fingerprintSnap.data() : fingerprintSnap.data) || {}
      : null;
    const seenUids: string[] = Array.isArray(existingFingerprint?.seenUids)
      ? existingFingerprint.seenUids.map((u: unknown) => String(u))
      : existingFingerprint?.firstUid
        ? [String(existingFingerprint.firstUid)]
        : [];
    const duplicatePhoneFingerprintDetected = Boolean(
      existingFingerprint && seenUids.some((priorUid) => priorUid && priorUid !== caller.uid)
    );

    // Merge with any existing docs without overwriting approved docs
    const existingDocs: any[] = Array.isArray(existingUser.verificationDocs) ? existingUser.verificationDocs : [];
    const mergedDocsMap = new Map<string, any>();
    for (const d of existingDocs) {
      if (d?.type) mergedDocsMap.set(d.type, d);
    }
    for (const [docType, newDoc] of incomingDocsMap.entries()) {
      const prev = mergedDocsMap.get(docType);
      if (prev && prev.status === "approved") continue;
      mergedDocsMap.set(docType, newDoc);
    }
    const finalDocs = Array.from(mergedDocsMap.values());
    const uploadedDocsCount = incomingDocsMap.size;

    const requiresAdminVerification = certInfo.hasRegulatedCategory || duplicatePhoneFingerprintDetected;
    const finalVerificationStatus: "provisional" | "pending" | "unverified" = requiresAdminVerification
      ? finalDocs.length > 0
        ? "pending"
        : "unverified"
      : finalDocs.length > 0
        ? "pending"
        : "provisional";

    const existingCapabilities: string[] = Array.isArray(existingUser.capabilities)
      ? existingUser.capabilities.map((c: unknown) => String(c).trim().toLowerCase()).filter(Boolean)
      : [];
    const nextCapabilities = Array.from(new Set([...existingCapabilities, "homeowner", "tradesperson"]));

    const existingPublic =
      (typeof publicSnap?.exists === "function" ? publicSnap.exists() : Boolean(publicSnap?.exists))
        ? (typeof publicSnap.data === "function" ? publicSnap.data() : publicSnap.data) || {}
        : {};

    const complianceDeclaration = {
      accepted: true,
      version: input.termsVersion || CURRENT_TERMS_VERSION,
      acceptedAt: nowIso,
      summary: TRADER_COMPLIANCE_DECLARATION_SUMMARY,
      confirmsInsuranceAndHealthSafety: true,
    };

    const userUpdate: Record<string, any> = {
      role: "tradesperson",
      accountType: "service_provider",
      isTradesperson: true,
      capabilities: nextCapabilities,
      name: input.displayName,
      displayName: input.displayName,
      phone: input.phone,
      postcode: cleanPostcode,
      city: input.city || existingUser.city || "",
      county: input.county || existingUser.county || "",
      bio: input.bio,
      trades: dedupedTrades,
      subcategories: dedupedSubcategories,
      primaryTrade: dedupedTrades[0],
      category: dedupedTrades[0],
      // Set Trader tier cleanly without touching homeownerTierId / isLandlord / landlordSubscriptionId
      tier: existingUser.tier && existingUser.tier !== "landlord" ? existingUser.tier : "payg",
      tierId:
        existingUser.tierId && existingUser.tierId !== "Standard Homeowner" && existingUser.tierId !== "Premium Landlord"
          ? existingUser.tierId
          : "Free Explorer",
      isVerified: false,
      verifiedTrader: false,
      verificationStatus: finalVerificationStatus,
      verificationDocs: finalDocs,
      requiresAdminVerification,
      duplicatePhoneFingerprintDetected,
      regulatedCategories: certInfo.regulatedCategories,
      requiredCertifications: certInfo.requiredCertifications,
      upgradedFromHomeowner: true,
      upgradedToTraderAt: nowIso,
      traderActivatedAt: nowIso,
      documentGracePeriodDays: gracePeriodDays,
      provisionalMaxQuotes,
      provisionalQuotesUsed: Math.max(0, Math.floor(Number(existingUser.provisionalQuotesUsed || 0))),
      documentGraceDeadlineAt: requiresAdminVerification ? null : graceDeadlineIso,
      traderComplianceDeclaration: complianceDeclaration,
      termsAccepted: true,
      termsAcceptedVersion: input.termsVersion || CURRENT_TERMS_VERSION,
      termsAcceptedAt: nowIso,
      activeContext: {
        portal: "anytrader",
        role: "tradesperson",
      },
      fairnessScore: typeof existingUser.fairnessScore === "number" ? existingUser.fairnessScore : 100,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    tx.update(userRef, userUpdate);

    const compactPostcode = cleanPostcode.replace(/\s+/g, "");
    const outwardPostcode = compactPostcode.length > 4 ? compactPostcode.slice(0, compactPostcode.length - 3) : compactPostcode;

    const publicProfilePayload: Record<string, any> = {
      ...existingPublic,
      uid: caller.uid,
      id: caller.uid,
      name: input.displayName,
      displayName: input.displayName,
      bio: input.bio,
      postcode: outwardPostcode,
      postcodeArea: outwardPostcode,
      city: input.city || existingUser.city || "",
      county: input.county || existingUser.county || "",
      serviceRadius: typeof existingPublic.serviceRadius === "number" ? existingPublic.serviceRadius : 20,
      acceptingNewWork: existingPublic.acceptingNewWork !== false,
      isAcceptingRequests: existingPublic.isAcceptingRequests !== false,
      role: "tradesperson",
      trades: dedupedTrades,
      categories: dedupedTrades,
      subcategories: dedupedSubcategories,
      primaryTrade: dedupedTrades[0],
      category: dedupedTrades[0],
      tier: userUpdate.tier,
      tierId: userUpdate.tierId,
      isVerified: false,
      verifiedTrader: false,
      verificationStatus: finalVerificationStatus,
      requiresAdminVerification,
      rating: typeof existingPublic.rating === "number" ? existingPublic.rating : Number(existingUser.rating || 0),
      reviewCount: typeof existingPublic.reviewCount === "number" ? existingPublic.reviewCount : Number(existingUser.reviewCount || 0),
      completedJobsCount:
        typeof existingPublic.completedJobsCount === "number"
          ? existingPublic.completedJobsCount
          : Number(existingUser.completedJobsCount || 0),
      availabilityStatus: existingPublic.availabilityStatus || "available",
      fairnessScore: userUpdate.fairnessScore,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(existingPublic.createdAt ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
    };

    tx.set(publicProfileRef, publicProfilePayload, { merge: true });

    // Record GDPR-safe one-way hashed phone fingerprint (no plaintext phone number stored)
    const nextSeenUids = Array.from(new Set([...seenUids, caller.uid]));
    tx.set(
      phoneFingerprintRef,
      {
        firstUid: existingFingerprint?.firstUid || caller.uid,
        lastUid: caller.uid,
        seenUids: nextSeenUids,
        activationCount: Number(existingFingerprint?.activationCount || 0) + 1,
        firstActivatedAt: existingFingerprint?.firstActivatedAt || nowIso,
        lastActivatedAt: nowIso,
        flaggedDuplicateAttempt: duplicatePhoneFingerprintDetected || Boolean(existingFingerprint?.flaggedDuplicateAttempt),
      },
      { merge: true }
    );

    if (duplicatePhoneFingerprintDetected) {
      const auditAlertRef = firestoreDb
        .collection("admin_audit_logs")
        .doc(`dup_phone_upgrade_${caller.uid}_${Date.now()}`);
      tx.set(auditAlertRef, {
        action: "duplicate_phone_trader_upgrade_flagged",
        targetId: caller.uid,
        targetType: "user",
        severity: "high",
        phoneFingerprintPrefix: phoneFingerprintHash.slice(0, 12),
        priorAccountCount: seenUids.filter((u) => u !== caller.uid).length,
        details:
          "Homeowner-to-Tradesperson upgrade used a phone number already linked to another trader profile. Second provisional grace window denied; Admin verification required before quoting.",
        timestamp: nowIso,
      });
    }

    result = {
      success: true,
      uid: caller.uid,
      role: "tradesperson",
      verificationStatus: finalVerificationStatus,
      requiresAdminVerification,
      duplicatePhoneFingerprintDetected,
      regulatedCategories: certInfo.regulatedCategories,
      requiredCertifications: certInfo.requiredCertifications,
      documentGracePeriodDays: gracePeriodDays,
      provisionalMaxQuotes,
      documentGraceDeadlineAt: requiresAdminVerification ? null : graceDeadlineIso,
      uploadedDocsCount,
    };
  });

  if (!result) {
    throw new BadRequestError("Upgrade transaction did not produce a result.");
  }

  return result;
}
