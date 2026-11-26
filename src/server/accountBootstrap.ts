import { z } from "zod";
import admin from "firebase-admin";
import { BadRequestError, ConflictError, ForbiddenError } from "./httpErrors.ts";
import {
  DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS,
  DEFAULT_PROVISIONAL_MAX_QUOTES,
  TRADER_COMPLIANCE_DECLARATION_SUMMARY,
  getRequiredCertificationsForTrades,
} from "../lib/traderCompliance.ts";
import { CURRENT_TERMS_VERSION } from "../constants/termsAndPrivacy.ts";
import { computePhoneFingerprintHash } from "./accountUpgrade.ts";

function extractOutwardPostcode(rawPostcode?: string | null): string {
  const cleaned = String(rawPostcode || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!cleaned) return "";
  if (cleaned.length > 4) {
    return cleaned.slice(0, cleaned.length - 3);
  }
  return cleaned;
}

export const SELF_SERVICE_ROLES = [
  "homeowner",
  "tradesperson",
  "business",
  "fleet_driver",
] as const;

export type SelfServiceRole = typeof SELF_SERVICE_ROLES[number];

const verificationDocInputSchema = z.object({
  type: z.string().trim().min(1).max(120),
  fileUrl: z.string().trim().url().max(2048).refine((url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && (
        parsed.hostname === "firebasestorage.googleapis.com" ||
        parsed.hostname.endsWith(".firebasestorage.app") ||
        parsed.hostname === "storage.googleapis.com"
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

export const bootstrapProfileSchema = z.object({
  role: z.enum(SELF_SERVICE_ROLES),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(32).optional(),
  postcode: z.string().trim().max(10).optional(),
  city: z.string().trim().max(80).optional(),
  county: z.string().trim().max(80).optional(),
  trades: z.array(z.string().max(80)).max(20).default([]),
  subcategories: z.array(z.string().max(80)).max(50).default([]),
  businessLayer: z.enum(["trades", "field_services", "properties", "consultancy"]).nullish(),
  businessCategory: z.string().max(80).nullish(),
  vehicleCategories: z.array(z.string().max(40)).max(10).nullish(),
  isPetFriendly: z.boolean().optional(),
  referrerUid: z.string().max(128).nullish(),
  referralCode: z.string().trim().max(64).nullish(),
  affiliateCode: z.string().max(64).nullish(),
  memberId: z.string().trim().regex(/^[A-Z0-9-]{3,32}$/).optional(),
  memberSequence: z.number().int().min(0).max(100_000_000).optional(),
  deviceId: z.string().trim().max(256).optional(),
  verificationDocs: z.array(verificationDocInputSchema).max(20).optional(),
  acceptedComplianceDeclaration: z.boolean().optional(),
  termsVersion: z.string().trim().max(40).optional(),
}).strict();

export function capabilitiesFor(
  role: SelfServiceRole,
  businessLayer?: "trades" | "field_services" | "properties" | "consultancy" | null
): string[] {
  switch (role) {
    case "business":
      if (businessLayer === "trades" || businessLayer === "field_services") {
        return ["contractor", "tradesperson", "homeowner"];
      }
      if (businessLayer === "properties") {
        return ["homeowner", "landlord", "property_manager", "estate_agent"];
      }
      if (businessLayer === "consultancy") {
        return ["homeowner", "consultant"];
      }
      return ["homeowner"];
    case "fleet_driver":
      return ["fleet_driver", "homeowner"];
    case "tradesperson":
      return ["tradesperson", "homeowner"];
    case "homeowner":
    default:
      return ["homeowner"];
  }
}

export function accountTypeFor(role: SelfServiceRole): string {
  switch (role) {
    case "business":
      return "business";
    case "fleet_driver":
      return "driver";
    case "tradesperson":
      return "service_provider";
    case "homeowner":
    default:
      return "consumer";
  }
}

export async function executeBootstrapProfileCommand(
  firestoreDb: any,
  caller: { uid: string; email?: string | null; firebase?: any },
  rawInput: unknown,
  clientIp?: string
): Promise<{ success: boolean; uid: string }> {
  if (!firestoreDb) {
    throw new BadRequestError("Database not initialized on server");
  }

  const parseResult = bootstrapProfileSchema.safeParse(rawInput);
  if (!parseResult.success) {
    throw new BadRequestError(`Invalid profile payload: ${parseResult.error.message}`);
  }

  const input = parseResult.data;
  const userRef = firestoreDb.collection("users").doc(caller.uid);
  const publicProfileRef = firestoreDb.collection("public_profiles").doc(caller.uid);

  const isDriver = input.role === "fleet_driver";
  const isHomeowner = input.role === "homeowner";
  const isPropertyOnlyBusiness = input.role === "business" && input.businessLayer === "properties";
  const canonicalAccountType = accountTypeFor(input.role);
  const canonicalCapabilities = capabilitiesFor(input.role, input.businessLayer);
  const cleanPostcode = (input.postcode ?? "").toUpperCase().replace(/\s/g, "");
  const effectiveTrades = isPropertyOnlyBusiness ? [] : input.trades;
  const effectiveSubcategories = isPropertyOnlyBusiness ? [] : input.subcategories;

  const defaultTier =
    input.role === "homeowner"
      ? "Standard Homeowner"
      : input.role === "tradesperson"
      ? "Free Explorer"
      : input.role === "business"
      ? "Business Professional"
      : "Standard Driver";

  // Server-authoritative subscriptionType derived strictly from role (never client-supplied)
  const subscriptionType = input.role === "business" ? "business" : null;
  const resolvedMemberId = input.memberId || `AT-${caller.uid.slice(0, 8).toUpperCase()}`;
  const resolvedMemberSequence = typeof input.memberSequence === "number" ? input.memberSequence : null;

  // AT-REF-02: Server-authoritative referral & affiliate attribution lookup.
  // Never trust arbitrary client-supplied referrerUid; resolve and verify against active DB records.
  let verifiedReferredBy: string | null = null;
  let verifiedAffiliateId: string | null = null;
  const rawAttributionCode = (input.referralCode || input.affiliateCode || "").trim();

  if (rawAttributionCode.length >= 3) {
    try {
      const affSnap = await firestoreDb
        .collection("affiliates")
        .where("code", "==", rawAttributionCode.toLowerCase())
        .limit(1)
        .get();
      if (affSnap && !affSnap.empty) {
        const affDoc = affSnap.docs[0];
        const affData = typeof affDoc.data === "function" ? affDoc.data() : affDoc.data;
        if (!affData?.status || affData.status === "active") {
          verifiedAffiliateId = affDoc.id;
        }
      }

      if (!verifiedAffiliateId) {
        const refSnap = await firestoreDb
          .collection("users")
          .where("referralCode", "==", rawAttributionCode.toUpperCase())
          .limit(1)
          .get();
        if (refSnap && !refSnap.empty) {
          const refDoc = refSnap.docs[0];
          const refData = typeof refDoc.data === "function" ? refDoc.data() : refDoc.data;
          const isSelfReferral = refDoc.id === caller.uid;
          const isInactiveReferrer =
            refData?.isSuspended === true ||
            refData?.isFrozen === true ||
            refData?.banned === true ||
            refData?.isDisabled === true;
          if (!isSelfReferral && !isInactiveReferrer) {
            verifiedReferredBy = refDoc.id;
          }
        }
      }
    } catch (refErr: any) {
      console.warn("[executeBootstrapProfileCommand] Referral attribution verification skipped:", refErr?.message);
    }
  } else if (input.referrerUid && input.referrerUid !== caller.uid) {
    // Legacy client compatibility: only accept if the referenced user exists, is active, and is not self
    try {
      const refDoc = await firestoreDb.collection("users").doc(input.referrerUid).get();
      if (refDoc && refDoc.exists) {
        const refData = typeof refDoc.data === "function" ? refDoc.data() : refDoc.data;
        const isInactiveReferrer =
          refData?.isSuspended === true ||
          refData?.isFrozen === true ||
          refData?.banned === true ||
          refData?.isDisabled === true;
        if (!isInactiveReferrer) {
          verifiedReferredBy = refDoc.id;
        }
      }
    } catch {
      // Fail closed to null attribution if lookup cannot be verified
    }
  }

  const nowIso = new Date().toISOString();
  const dedupedDocsMap = new Map<string, Record<string, any>>();
  for (const docItem of input.verificationDocs || []) {
    if (
      docItem.storagePath &&
      !docItem.storagePath.startsWith(`verifications/${caller.uid}/`) &&
      !docItem.storagePath.startsWith(`users/${caller.uid}/private/`)
    ) {
      throw new ForbiddenError("Verification document storage path must belong to the authenticated user.");
    }
    dedupedDocsMap.set(docItem.type, {
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
  const sanitizedVerificationDocs = Array.from(dedupedDocsMap.values());
  const isTradeProviderBootstrap = canonicalCapabilities.includes("tradesperson");
  const hasComplianceDeclaration = input.acceptedComplianceDeclaration === true;
  const certInfo = isTradeProviderBootstrap
    ? getRequiredCertificationsForTrades(effectiveTrades, effectiveSubcategories)
    : { hasRegulatedCategory: false, regulatedCategories: [] as string[], requiredCertifications: [] as string[] };
  const normalizedPhoneDigits = String(input.phone || "").replace(/\D/g, "");
  const phoneFingerprintHash =
    isTradeProviderBootstrap && hasComplianceDeclaration && normalizedPhoneDigits.length >= 7
      ? computePhoneFingerprintHash(input.phone || "")
      : null;

  const outwardPostcode = extractOutwardPostcode(cleanPostcode);

  const resolvedCategory = isPropertyOnlyBusiness
    ? (input.businessCategory || "Property & Asset Management")
    : (input.businessCategory || effectiveTrades[0] || (isHomeowner ? "" : "General Trades"));

  const resolvedPrimaryTrade = isPropertyOnlyBusiness
    ? ""
    : (effectiveTrades[0] || input.businessCategory || (isHomeowner ? "" : "General Trades"));

  const baseVerificationStatus = sanitizedVerificationDocs.length > 0 ? "pending" : "unverified";

  const userProfileData: Record<string, any> = {
    uid: caller.uid,
    id: caller.uid,
    email: caller.email ?? null,
    isAnonymous: caller.firebase?.sign_in_provider === "anonymous",
    name: input.name,
    displayName: input.name,
    phone: input.phone ?? "",
    postcode: cleanPostcode,
    postcodeArea: outwardPostcode,
    city: input.city ?? "",
    county: input.county ?? "",
    role: input.role,
    accountType: canonicalAccountType,
    capabilities: canonicalCapabilities,
    subscriptionType,
    memberId: resolvedMemberId,
    memberSequence: resolvedMemberSequence,
    deviceId: input.deviceId || null,
    activeContext: {
      portal: isDriver ? "anyroller" : "anytrader",
      role: input.role,
    },
    trades: effectiveTrades,
    subcategories: effectiveSubcategories,
    businessLayer: input.role === "business" ? (input.businessLayer ?? null) : null,
    businessCategory: input.role === "business" ? (input.businessCategory ?? null) : null,
    category: resolvedCategory,
    primaryTrade: resolvedPrimaryTrade,
    tierId: defaultTier,
    verificationStatus: baseVerificationStatus,
    verificationDocs: sanitizedVerificationDocs,
    driverApproved: isDriver ? false : null,
    fairnessScore: 100,
    joinedDuringBeta: true,
    phantomFeesSaved: 0,
    referralCode: caller.uid.slice(0, 8).toUpperCase(),
    referredBy: verifiedReferredBy,
    affiliateId: verifiedAffiliateId,
    vehicleCategories: isDriver ? (input.vehicleCategories ?? null) : null,
    isPetFriendly: isDriver ? (input.isPetFriendly ?? false) : false,
    ...(isTradeProviderBootstrap
      ? {
          serviceRadius: 20,
          acceptingNewWork: true,
          isAcceptingRequests: true,
          isAvailableForEmergency: false,
          isAvailableForInstantMatch: false,
        }
      : {}),
    ipAddress: clientIp || "unknown",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  try {
    await firestoreDb.runTransaction(async (transaction: any) => {
      const existingSnap = await transaction.get(userRef);
      if (existingSnap && existingSnap.exists) {
        throw new ConflictError("Profile already exists.");
      }

      let finalVerificationStatus: "provisional" | "pending" | "unverified" = baseVerificationStatus;
      let requiresAdminVerification = certInfo.hasRegulatedCategory;
      let duplicatePhoneFingerprintDetected = false;
      let gracePeriodDays = DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS;
      let provisionalMaxQuotes = DEFAULT_PROVISIONAL_MAX_QUOTES;
      let graceDeadlineIso: string | null = null;
      let existingFingerprint: Record<string, any> | null = null;
      let seenUids: string[] = [];

      if (isTradeProviderBootstrap && hasComplianceDeclaration) {
        const globalConfigRef = firestoreDb.collection("platform_config").doc("global");
        const configSnap = await transaction.get(globalConfigRef);
        const globalCfg =
          (typeof configSnap?.exists === "function" ? configSnap.exists() : Boolean(configSnap?.exists))
            ? (typeof configSnap.data === "function" ? configSnap.data() : configSnap.data) || {}
            : {};

        const rawGraceDays = Number(globalCfg.documentGracePeriodDays);
        gracePeriodDays =
          Number.isFinite(rawGraceDays) && rawGraceDays >= 0
            ? Math.floor(rawGraceDays)
            : DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS;
        const rawProvisionalMaxQuotes = Number(globalCfg.provisionalMaxQuotes);
        provisionalMaxQuotes =
          Number.isFinite(rawProvisionalMaxQuotes) && rawProvisionalMaxQuotes >= 0
            ? Math.floor(rawProvisionalMaxQuotes)
            : DEFAULT_PROVISIONAL_MAX_QUOTES;

        if (phoneFingerprintHash) {
          const phoneFingerprintRef = firestoreDb.collection("trader_phone_fingerprints").doc(phoneFingerprintHash);
          const fingerprintSnap = await transaction.get(phoneFingerprintRef);
          const fingerprintExists =
            typeof fingerprintSnap?.exists === "function"
              ? fingerprintSnap.exists()
              : Boolean(fingerprintSnap?.exists);
          existingFingerprint = fingerprintExists
            ? (typeof fingerprintSnap.data === "function" ? fingerprintSnap.data() : fingerprintSnap.data) || {}
            : null;
          seenUids = Array.isArray(existingFingerprint?.seenUids)
            ? existingFingerprint.seenUids.map((u: unknown) => String(u))
            : existingFingerprint?.firstUid
              ? [String(existingFingerprint.firstUid)]
              : [];
          duplicatePhoneFingerprintDetected = Boolean(
            existingFingerprint && seenUids.some((priorUid) => priorUid && priorUid !== caller.uid)
          );
        }

        requiresAdminVerification = certInfo.hasRegulatedCategory || duplicatePhoneFingerprintDetected;
        finalVerificationStatus = requiresAdminVerification
          ? sanitizedVerificationDocs.length > 0
            ? "pending"
            : "unverified"
          : sanitizedVerificationDocs.length > 0
            ? "pending"
            : "provisional";

        graceDeadlineIso =
          !requiresAdminVerification && gracePeriodDays > 0
            ? new Date(Date.now() + gracePeriodDays * 24 * 60 * 60 * 1000).toISOString()
            : null;

        Object.assign(userProfileData, {
          verificationStatus: finalVerificationStatus,
          requiresAdminVerification,
          duplicatePhoneFingerprintDetected,
          regulatedCategories: certInfo.regulatedCategories,
          requiredCertifications: certInfo.requiredCertifications,
          traderActivatedAt: nowIso,
          documentGracePeriodDays: gracePeriodDays,
          provisionalMaxQuotes,
          provisionalQuotesUsed: 0,
          documentGraceDeadlineAt: graceDeadlineIso,
          traderComplianceDeclaration: {
            accepted: true,
            version: input.termsVersion || CURRENT_TERMS_VERSION,
            acceptedAt: nowIso,
            summary: TRADER_COMPLIANCE_DECLARATION_SUMMARY,
            confirmsInsuranceAndHealthSafety: true,
          },
          termsAccepted: true,
          termsAcceptedVersion: input.termsVersion || CURRENT_TERMS_VERSION,
          termsAcceptedAt: nowIso,
        });

        if (phoneFingerprintHash) {
          const phoneFingerprintRef = firestoreDb.collection("trader_phone_fingerprints").doc(phoneFingerprintHash);
          transaction.set(
            phoneFingerprintRef,
            {
              firstUid: existingFingerprint?.firstUid || caller.uid,
              lastUid: caller.uid,
              seenUids: Array.from(new Set([...seenUids, caller.uid])),
              activationCount: Number(existingFingerprint?.activationCount || 0) + 1,
              firstActivatedAt: existingFingerprint?.firstActivatedAt || nowIso,
              lastActivatedAt: nowIso,
              flaggedDuplicateAttempt:
                duplicatePhoneFingerprintDetected || Boolean(existingFingerprint?.flaggedDuplicateAttempt),
            },
            { merge: true }
          );

          if (duplicatePhoneFingerprintDetected) {
            const auditAlertRef = firestoreDb
              .collection("admin_audit_logs")
              .doc(`dup_phone_bootstrap_${caller.uid}_${Date.now()}`);
            transaction.set(auditAlertRef, {
              action: "duplicate_phone_trader_bootstrap_flagged",
              targetId: caller.uid,
              targetType: "user",
              severity: "high",
              phoneFingerprintPrefix: phoneFingerprintHash.slice(0, 12),
              priorAccountCount: seenUids.filter((u) => u !== caller.uid).length,
              details:
                "Direct tradesperson signup used a phone number already linked to another trader profile. Second provisional grace window denied; Admin verification required before quoting.",
              timestamp: nowIso,
            });
          }
        }
      }

      transaction.set(userRef, userProfileData);

      // Slice 1 P0 #6: Server-authoritative affiliate referral attribution increment
      if (verifiedAffiliateId) {
        const affiliateRef = firestoreDb.collection("affiliates").doc(verifiedAffiliateId);
        transaction.set(
          affiliateRef,
          {
            uses:
              typeof admin?.firestore?.FieldValue?.increment === "function"
                ? admin.firestore.FieldValue.increment(1)
                : 1,
            lastUsedAt: nowIso,
          },
          { merge: true }
        );
      }

      // Sync sanitized non-PII public profile projection only for verified-eligible trade execution roles
      if (isTradeProviderBootstrap) {
        transaction.set(
          publicProfileRef,
          {
            uid: caller.uid,
            id: caller.uid,
            name: input.name,
            displayName: input.name,
            role: input.role,
            primaryTrade: resolvedPrimaryTrade,
            trades: effectiveTrades,
            categories: effectiveTrades,
            subcategories: effectiveSubcategories,
            city: input.city ?? "",
            county: input.county ?? "",
            ...(outwardPostcode ? { postcodeArea: outwardPostcode, postcode: outwardPostcode } : {}),
            serviceRadius: 20,
            acceptingNewWork: true,
            isAcceptingRequests: true,
            isAvailableForEmergency: false,
            isAvailableForInstantMatch: false,
            category: resolvedCategory,
            rating: 0,
            trustScore: 0,
            totalReviews: 0,
            verifiedTrader: false,
            isVerified: false,
            videoVerified: false,
            verificationStatus: finalVerificationStatus,
            requiresAdminVerification,
            tierId: defaultTier,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    });

    return { success: true, uid: caller.uid };
  } catch (err: any) {
    if (err instanceof ConflictError || err instanceof BadRequestError) {
      throw err;
    }
    const isPermissionOrAuthError =
      err?.code === 7 ||
      err?.code === "permission-denied" ||
      err?.message?.includes("PERMISSION_DENIED") ||
      err?.message?.includes("Missing or insufficient permissions") ||
      err?.message?.includes("not been used in project") ||
      err?.message?.includes("The caller does not have permission");

    if (isPermissionOrAuthError) {
      console.warn(
        `[executeBootstrapProfileCommand] Server lacks direct Firestore admin credentials. Authorizing client SDK fallback for uid: ${caller.uid}`,
        err?.message
      );
      return {
        success: true,
        uid: caller.uid,
        fallbackToClient: true,
        profileData: userProfileData,
      } as any;
    }

    throw err;
  }
}
