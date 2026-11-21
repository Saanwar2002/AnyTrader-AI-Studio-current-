// AT-MOBILE-03: Parameterized Mobile Deep Links (/.well-known/assetlinks.json & apple-app-site-association)
// Strictly validates production signing identities and fails closed (503) if unconfigured or placeholder values are present.

const PLACEHOLDER_SUBSTRINGS = [
  "placeholder",
  "replace_with",
  "your_",
  "teamid",
  "changeme",
  "example",
  "todo",
  "dummy",
  "fake",
];

const DEFAULT_UNIVERSAL_LINK_PATHS = [
  "/job/*",
  "/chat/*",
  "/profile/*",
  "/my-jobs",
  "/messages",
  "/quotes",
];

export function isPlaceholderSigningValue(value: string): boolean {
  const clean = String(value || "").trim();
  if (!clean) return true;
  const lower = clean.toLowerCase();
  return PLACEHOLDER_SUBSTRINGS.some((needle) => lower.includes(needle));
}

/**
 * Validates a real colon-separated 32-byte uppercase SHA-256 Android APK signing certificate fingerprint.
 * Rejects synthetic placeholder sequences (such as all-zeros or `10:00:00:...`).
 */
export function isValidAndroidSha256Fingerprint(fingerprint: string): boolean {
  const normalized = String(fingerprint || "").trim().toUpperCase();
  if (isPlaceholderSigningValue(normalized)) return false;

  const sha256Pattern = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
  if (!sha256Pattern.test(normalized)) return false;

  const bytes = normalized.split(":");
  const zeroBytes = bytes.filter((b) => b === "00").length;
  // Real SHA-256 hashes have high entropy; reject synthetic mostly-zero placeholders
  if (zeroBytes >= 16) return false;

  const uniqueBytes = new Set(bytes).size;
  if (uniqueBytes < 8) return false;

  return true;
}

/**
 * Validates a real 10-character alphanumeric Apple Developer Team ID.
 * Rejects placeholder Team IDs like TEAMID1234, XXXXXXXXXX, 0000000000, 1234567890.
 */
export function isValidAppleTeamId(teamId: string): boolean {
  const normalized = String(teamId || "").trim().toUpperCase();
  if (isPlaceholderSigningValue(normalized)) return false;
  if (!/^[A-Z0-9]{10}$/.test(normalized)) return false;
  if (/^(0+|X+|A+|1234567890)$/.test(normalized)) return false;
  return true;
}

export function isValidReverseDomainId(pkg: string): boolean {
  const clean = String(pkg || "").trim();
  if (isPlaceholderSigningValue(clean)) return false;
  if (clean.startsWith("com.example.")) return false;
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_-]*){1,}$/.test(clean);
}

export function buildAndroidAssetLinksPayload(
  env: Record<string, string | undefined> = process.env
): {
  configured: boolean;
  payload?: Array<{
    relation: string[];
    target: {
      namespace: "android_app";
      package_name: string;
      sha256_cert_fingerprints: string[];
    };
  }>;
  reason?: string;
} {
  const packageName = String(env.ANDROID_APP_PACKAGE || "com.anytrader.app").trim();
  const rawFingerprints = String(env.ANDROID_SHA256_CERT_FINGERPRINTS || "").trim();

  if (!isValidReverseDomainId(packageName)) {
    return {
      configured: false,
      reason: "ANDROID_APP_PACKAGE is invalid or uses a placeholder package name.",
    };
  }

  if (!rawFingerprints) {
    return {
      configured: false,
      reason: "ANDROID_SHA256_CERT_FINGERPRINTS is not configured.",
    };
  }

  const fingerprints = rawFingerprints
    .split(",")
    .map((fp) => fp.trim().toUpperCase())
    .filter(Boolean);

  if (fingerprints.length === 0 || !fingerprints.every(isValidAndroidSha256Fingerprint)) {
    return {
      configured: false,
      reason: "ANDROID_SHA256_CERT_FINGERPRINTS contains an invalid or placeholder SHA-256 fingerprint.",
    };
  }

  return {
    configured: true,
    payload: [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: packageName,
          sha256_cert_fingerprints: Array.from(new Set(fingerprints)),
        },
      },
    ],
  };
}

export function buildAppleAppSiteAssociationPayload(
  env: Record<string, string | undefined> = process.env
): {
  configured: boolean;
  payload?: {
    applinks: {
      apps: string[];
      details: Array<{
        appID: string;
        appIDs: string[];
        paths: string[];
      }>;
    };
  };
  reason?: string;
} {
  const teamId = String(env.IOS_TEAM_ID || "").trim().toUpperCase();
  const bundleId = String(env.IOS_BUNDLE_ID || "com.anytrader.app").trim();

  if (!isValidAppleTeamId(teamId)) {
    return {
      configured: false,
      reason: "IOS_TEAM_ID is missing or contains a placeholder Apple Team ID.",
    };
  }

  if (!isValidReverseDomainId(bundleId)) {
    return {
      configured: false,
      reason: "IOS_BUNDLE_ID is invalid or uses a placeholder bundle identifier.",
    };
  }

  const appID = `${teamId}.${bundleId}`;
  return {
    configured: true,
    payload: {
      applinks: {
        apps: [],
        details: [
          {
            appID,
            appIDs: [appID],
            paths: [...DEFAULT_UNIVERSAL_LINK_PATHS],
          },
        ],
      },
    },
  };
}
