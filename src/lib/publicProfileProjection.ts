/**
 * Strict non-PII public profile allowlist shared across client sync, server sync, and security rules.
 * Remediates AT-PROFILE-03, AT-PROFILE-05, AT-ACCOUNT-02, AT-ACCOUNT-03.
 */

export const PUBLIC_PROFILE_ALLOWED_KEYS = [
  "uid",
  "id",
  "name",
  "displayName",
  "businessName",
  "companyName",
  "role",
  "isBusinessProfile",
  "avatarUrl",
  "photoURL",
  "profileImage",
  "bio",
  "description",
  "extraInfo",
  "trade",
  "primaryTrade",
  "category",
  "businessCategory",
  "trades",
  "categories",
  "subcategories",
  "services",
  "productsAndServices",
  "skills",
  "tags",
  "specialisms",
  "specialistTags",
  "specializations",
  "city",
  "county",
  "postcodeArea",
  "postcode",
  "area",
  "serviceRadius",
  "coverageRadiusMiles",
  "lat",
  "lng",
  "callOutFee",
  "hourlyRate",
  "dayRate",
  "pricingNotes",
  "experienceYears",
  "yearsInBusiness",
  "qualifications",
  "certifications",
  "tradeBodyMemberships",
  "portfolio",
  "galleryImages",
  "workingHours",
  "workingDays",
  "availability",
  "acceptingNewWork",
  "isAcceptingRequests",
  "isAvailableForEmergency",
  "isAvailableForInstantMatch",
  "emergencyCallout",
  "emergencyAvailable",
  "isGasSafeRegistered",
  "isNiceicApproved",
  "insuranceVerified",
  "publicLiabilityVerified",
  "isDisabled",
  "rating",
  "trustScore",
  "totalReviews",
  "reviewsCount",
  "reviewCount",
  "totalJobsDone",
  "totalJobsCompleted",
  "completedJobsCount",
  "responseRate",
  "availabilityStatus",
  "fairnessScore",
  "verified",
  "isVerified",
  "verifiedTrader",
  "verificationStatus",
  "requiresAdminVerification",
  "videoVerified",
  "isVideoVerified",
  "videoVerificationStatus",
  "videoVerificationUrl",
  "badges",
  "tier",
  "tierId",
  "hasVerifiedVideoProSubscription",
  "recommendedCategories",
  "referralBoostUntil",
  "miniProfileSettings",
  "createdAt",
  "updatedAt",
] as const;

export const PUBLIC_PROFILE_ALLOWED_KEY_SET = new Set<string>(PUBLIC_PROFILE_ALLOWED_KEYS);

export const PUBLIC_PROFILE_FORBIDDEN_PII_KEYS = new Set<string>([
  "email",
  "phone",
  "phoneNumber",
  "mobile",
  "address",
  "homeAddress",
  "businessAddress",
  "street",
  "line1",
  "line2",
  "fullAddress",
  "stripeAccountId",
  "stripeCustomerId",
  "defaultPaymentMethodId",
  "bankDetails",
  "sortCode",
  "accountNumber",
  "iban",
  "adWalletBalance",
  "adSpendTotal",
  "balance",
  "credits",
  "fcmToken",
  "pushToken",
  "notificationToken",
  "emergencyContact",
  "emergencyContactName",
  "emergencyContactPhone",
  "insurancePolicyNumber",
  "referredBy",
  "referralCode",
  "isAdmin",
  "gothamSubscriptionId",
  "gothamSubscriptionStatus",
  "gothamDoorsCount",
  "subscriptionId",
]);

function extractOutwardOnly(rawPostcode?: unknown): string {
  if (typeof rawPostcode !== "string") return "";
  const cleaned = rawPostcode.trim().toUpperCase();
  if (!cleaned) return "";
  const fullMatch = cleaned.match(/\b([A-Z]{1,2}[0-9][A-Z0-9]?)\s*([0-9][A-Z]{2})\b/);
  if (fullMatch) return fullMatch[1];
  const parts = cleaned.split(/\s+/);
  return parts[0] || "";
}

/**
 * Strips all PII and non-allowlisted fields from a profile payload before writing to /public_profiles/{uid}.
 * Also reduces full postcodes to outward code only so street-level residential addresses are never exposed.
 */
export function sanitizePublicProfilePayload(
  source: Record<string, any>,
  options?: { allowPrivilegedServerFields?: boolean }
): Record<string, any> {
  const allowPrivileged = options?.allowPrivilegedServerFields === true;
  const serverOnlyKeys = new Set([
    "rating",
    "trustScore",
    "totalReviews",
    "reviewsCount",
    "reviewCount",
    "totalJobsDone",
    "totalJobsCompleted",
    "completedJobsCount",
    "responseRate",
    "availabilityStatus",
    "fairnessScore",
    "verified",
    "isVerified",
    "verifiedTrader",
    "verificationStatus",
    "requiresAdminVerification",
    "videoVerified",
    "isVideoVerified",
    "videoVerificationStatus",
    "badges",
    "tier",
    "tierId",
    "hasVerifiedVideoProSubscription",
    "recommendedCategories",
    "referralBoostUntil",
    "isDisabled",
  ]);

  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (value === undefined) continue;
    if (PUBLIC_PROFILE_FORBIDDEN_PII_KEYS.has(key)) continue;
    if (!PUBLIC_PROFILE_ALLOWED_KEY_SET.has(key)) continue;
    if (!allowPrivileged && serverOnlyKeys.has(key)) continue;

    if (key === "postcode" || key === "postcodeArea") {
      const outward = extractOutwardOnly(value);
      if (outward) {
        sanitized.postcodeArea = outward;
        if (key === "postcode") {
          sanitized.postcode = outward;
        }
      }
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}
