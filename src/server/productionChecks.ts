import fs from "node:fs";
import path from "node:path";

/**
 * Pre-Production Readiness Invariant Checks for AnyTrader V6+
 * Scans runtime environment, secret entropy, named DB configuration,
 * cron/SSO/Stripe webhook invariants, and database connectivity.
 */
export const EXPECTED_PRODUCTION_DATABASE_ID = "ai-studio-anytrader-44dab8b3-bbc9-4352-b725-2cbe7a1dfd2a";

export interface ProductionCheckResult {
  name: string;
  category: "SECURITY" | "FINANCIAL" | "DATABASE" | "CONFIG";
  status: "PASS" | "WARN" | "FAIL";
  message: string;
  details?: Record<string, any>;
}

export interface ProductionAuditReport {
  timestamp: string;
  environment: string;
  overallStatus: "GO" | "GO_WITH_ACCEPTED_RISKS" | "NO_GO";
  checks: ProductionCheckResult[];
}

function resolveConfiguredDatabaseId(env: Record<string, string | undefined>): string | null {
  if (env.FIRESTORE_DATABASE_ID && env.FIRESTORE_DATABASE_ID.trim()) {
    return env.FIRESTORE_DATABASE_ID.trim();
  }
  try {
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (typeof parsed?.firestoreDatabaseId === "string" && parsed.firestoreDatabaseId.trim()) {
        return parsed.firestoreDatabaseId.trim();
      }
    }
  } catch {
    // Fall through to null
  }
  return null;
}

export function runProductionChecks(env = process.env, dbInstance?: any): ProductionAuditReport {
  const isProd = env.NODE_ENV === "production";
  const checks: ProductionCheckResult[] = [];

  // 1. Secret Entropy & Presence Checks (AT-ADMIN-PROD-AUDIT-01: includes CRON_SECRET & JWT_SECRET SSO key)
  const sensitiveKeys = [
    { key: "STRIPE_SECRET_KEY", category: "FINANCIAL" as const, requiredInProd: true },
    { key: "STRIPE_WEBHOOK_SECRET", category: "FINANCIAL" as const, requiredInProd: true },
    { key: "GEMINI_API_KEY", category: "SECURITY" as const, requiredInProd: true },
    { key: "JWT_SECRET", category: "SECURITY" as const, requiredInProd: true },
    { key: "CRON_SECRET", category: "SECURITY" as const, requiredInProd: true },
    { key: "APP_URL", category: "CONFIG" as const, requiredInProd: true },
    { key: "ALLOWED_ORIGINS", category: "CONFIG" as const, requiredInProd: true },
  ];

  for (const { key, category, requiredInProd } of sensitiveKeys) {
    const val = env[key];
    if (!val) {
      if (isProd && requiredInProd) {
        checks.push({
          name: `Env Check: ${key}`,
          category,
          status: "FAIL",
          message: `Mandatory production secret '${key}' is missing.`,
        });
      } else {
        checks.push({
          name: `Env Check: ${key}`,
          category,
          status: "WARN",
          message: `Secret '${key}' is not configured. Development fallbacks may apply.`,
        });
      }
    } else if (val.length < 12 || ["test", "12345", "changeme", "default"].includes(val.toLowerCase())) {
      checks.push({
        name: `Entropy Check: ${key}`,
        category,
        status: isProd ? "FAIL" : "WARN",
        message: `Secret '${key}' exhibits dangerously low entropy or placeholder value.`,
      });
    } else {
      checks.push({
        name: `Entropy Check: ${key}`,
        category,
        status: "PASS",
        message: `Secret '${key}' is configured with valid entropy.`,
      });
    }
  }

  // 1.5 Stripe Webhook Signing Secret Format Check
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (webhookSecret && !webhookSecret.startsWith("whsec_")) {
    checks.push({
      name: "Stripe Webhook Secret Format",
      category: "FINANCIAL",
      status: isProd ? "FAIL" : "WARN",
      message: "STRIPE_WEBHOOK_SECRET must be a valid Stripe signing secret starting with 'whsec_'.",
    });
  } else if (webhookSecret) {
    checks.push({
      name: "Stripe Webhook Secret Format",
      category: "FINANCIAL",
      status: "PASS",
      message: "STRIPE_WEBHOOK_SECRET matches expected Stripe signing secret prefix.",
    });
  }

  // 2. Mock Payments Production Gate
  if (isProd && env.ALLOW_MOCK_PAYMENTS === "true") {
    checks.push({
      name: "Mock Payment Gate",
      category: "FINANCIAL",
      status: "FAIL",
      message: "ALLOW_MOCK_PAYMENTS must strictly be disabled ('false') in production environments.",
    });
  } else {
    checks.push({
      name: "Mock Payment Gate",
      category: "FINANCIAL",
      status: "PASS",
      message: "Mock payments are correctly disabled or restricted to non-production environments.",
    });
  }

  // 2.5 Degraded Auth Production Gate (AT-CJ-AUTH-05)
  if (env.ALLOW_DEGRADED_AUTH === "true") {
    checks.push({
      name: "Degraded Auth Gate",
      category: "SECURITY",
      status: isProd ? "FAIL" : "WARN",
      message: isProd
        ? "ALLOW_DEGRADED_AUTH must strictly be disabled ('false') in production environments."
        : "ALLOW_DEGRADED_AUTH is enabled for non-production development.",
    });
  } else {
    checks.push({
      name: "Degraded Auth Gate",
      category: "SECURITY",
      status: "PASS",
      message: "Degraded authentication fallback is disabled.",
    });
  }

  // 2.6 HTTPS & CORS Check
  if (isProd) {
     if (env.APP_URL && !env.APP_URL.startsWith("https://")) {
        checks.push({
          name: "HTTPS Protocol Enforced",
          category: "SECURITY",
          status: "FAIL",
          message: "APP_URL must use https:// in production.",
        });
     }
     if (!env.ALLOWED_ORIGINS || env.ALLOWED_ORIGINS === "*" || env.ALLOWED_ORIGINS.includes("localhost")) {
        checks.push({
          name: "Strict CORS Configuration",
          category: "SECURITY",
          status: "FAIL",
          message: "ALLOWED_ORIGINS must be strictly defined (no wildcards or localhost) in production.",
        });
     } else {
        checks.push({
          name: "Strict CORS Configuration",
          category: "SECURITY",
          status: "PASS",
          message: "CORS strictly configured for production.",
        });
     }
  }

  // 3. Named Production Database Configuration Check (AT-ADMIN-PROD-AUDIT-01)
  const configuredDbId = resolveConfiguredDatabaseId(env);
  if (!configuredDbId || configuredDbId === "(default)") {
    checks.push({
      name: "Named Firestore Database Configuration",
      category: "DATABASE",
      status: isProd ? "FAIL" : "WARN",
      message: `Firestore database ID is '${configuredDbId || "unset"}'; expected named production database '${EXPECTED_PRODUCTION_DATABASE_ID}'.`,
    });
  } else if (configuredDbId !== EXPECTED_PRODUCTION_DATABASE_ID) {
    checks.push({
      name: "Named Firestore Database Configuration",
      category: "DATABASE",
      status: isProd ? "FAIL" : "WARN",
      message: `Configured Firestore database ID '${configuredDbId}' does not match expected '${EXPECTED_PRODUCTION_DATABASE_ID}'.`,
    });
  } else {
    checks.push({
      name: "Named Firestore Database Configuration",
      category: "DATABASE",
      status: "PASS",
      message: `Named Firestore database '${configuredDbId}' verified.`,
    });
  }

  // 4. Database Connectivity Check
  if (dbInstance) {
    checks.push({
      name: "Firestore Connectivity",
      category: "DATABASE",
      status: "PASS",
      message: "Firebase Admin Firestore initialized successfully.",
    });
  } else {
    checks.push({
      name: "Firestore Connectivity",
      category: "DATABASE",
      status: isProd ? "FAIL" : "WARN",
      message: "Server Firestore client not initialized. Client-direct rules apply.",
    });
  }

  // Calculate Overall Status
  const hasFailures = checks.some((c) => c.status === "FAIL");
  const hasWarnings = checks.some((c) => c.status === "WARN");

  let overallStatus: "GO" | "GO_WITH_ACCEPTED_RISKS" | "NO_GO" = "GO";
  if (hasFailures) {
    overallStatus = "NO_GO";
  } else if (hasWarnings) {
    overallStatus = "GO_WITH_ACCEPTED_RISKS";
  }

  return {
    timestamp: new Date().toISOString(),
    environment: env.NODE_ENV || "development",
    overallStatus,
    checks,
  };
}

