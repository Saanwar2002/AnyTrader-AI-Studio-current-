/**
 * Atomic Versioned Pricing & Commission Configuration Publisher (AT-ADMIN-CONFIG-01)
 *
 * Ensures platform_config/global, platform_config/global_tiers, an immutable
 * platform_config_versions/{version} audit snapshot, and admin_audit_logs
 * are published inside a single atomic Firestore transaction.
 */

import { BadRequestError } from "./httpErrors.ts";
import { invalidateDynamicConfigCache } from "./pricingCatalog.ts";

export interface PublishPricingConfigInput {
  db: any;
  adminUid: string;
  adminEmail?: string;
  tempConfig: Record<string, any>;
  feeTiers?: any[];
  businessTiers?: any[];
  paidAddons?: Record<string, any>;
}

export interface PublishPricingConfigResult {
  success: boolean;
  configVersion: number;
  publishedAt: string;
  publishedBy: string;
}

function normalizeTraderTierKey(name: unknown): string {
  const raw = String(name || "").trim().toLowerCase();
  if (!raw || raw.includes("free") || raw.includes("payg") || raw.includes("explorer")) return "payg";
  if (raw.includes("silver") || raw.includes("pro")) return "pro";
  if (raw.includes("gold") || raw.includes("premium") || raw.includes("elite")) return "premium";
  if (raw.includes("platinum") || raw.includes("enterprise")) return "platinum";
  return raw.replace(/[^a-z0-9_]+/g, "_");
}

function assertFiniteNonNegative(value: unknown, field: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new BadRequestError(`Invalid configuration value for '${field}': must be a finite non-negative number.`);
  }
  return num;
}

export async function publishPlatformPricingConfigAtomic(
  input: PublishPricingConfigInput
): Promise<PublishPricingConfigResult> {
  const { db, adminUid, adminEmail, tempConfig, feeTiers, businessTiers, paidAddons } = input;

  if (!db) {
    throw new BadRequestError("Database service unavailable");
  }
  if (!tempConfig || typeof tempConfig !== "object" || Array.isArray(tempConfig)) {
    throw new BadRequestError("Valid tempConfig object is required");
  }

  const resolvedFeeTiers = Array.isArray(feeTiers)
    ? feeTiers
    : Array.isArray(tempConfig.feeTiers)
      ? tempConfig.feeTiers
      : [];
  const resolvedBusinessTiers = Array.isArray(businessTiers)
    ? businessTiers
    : Array.isArray(tempConfig.businessTiers)
      ? tempConfig.businessTiers
      : [];
  const resolvedPaidAddons = (paidAddons && typeof paidAddons === "object" ? paidAddons : tempConfig.paidAddons) || {};

  // Validate tiers before entering transaction
  const mappedOneOffTiers: Record<string, any> = {};
  for (const ft of resolvedFeeTiers) {
    if (!ft || typeof ft !== "object") {
      throw new BadRequestError("Each fee tier must be an object.");
    }
    const price = assertFiniteNonNegative(ft.price ?? 0, `feeTiers[${ft.name || "tier"}].price`);
    const rawCommission = assertFiniteNonNegative(ft.commission ?? 0, `feeTiers[${ft.name || "tier"}].commission`);
    if (rawCommission > 100) {
      throw new BadRequestError(`Invalid commission rate for '${ft.name}': cannot exceed 100%.`);
    }
    const normalizedCommission = rawCommission > 1 ? rawCommission / 100 : rawCommission;
    const canonical = normalizeTraderTierKey(ft.name);

    mappedOneOffTiers[canonical] = {
      price,
      commission: normalizedCommission,
      maxQuotes: Number(ft.maxQuotes) || 9999,
      maxAcceptedQuotes: Number(ft.maxAcceptedQuotes) || 9999,
      leadFee: assertFiniteNonNegative(ft.leadFee ?? 0, `feeTiers[${ft.name || "tier"}].leadFee`),
      description: String(ft.description || ""),
      features: Array.isArray(ft.features) ? ft.features : ft.description ? [String(ft.description)] : [],
    };
  }

  for (const bt of resolvedBusinessTiers) {
    if (!bt || typeof bt !== "object") continue;
    assertFiniteNonNegative(bt.price ?? 0, `businessTiers[${bt.name || "tier"}].price`);
    const comm = assertFiniteNonNegative(bt.commission ?? 0, `businessTiers[${bt.name || "tier"}].commission`);
    if (comm > 100) {
      throw new BadRequestError(`Invalid business tier commission for '${bt.name}': cannot exceed 100%.`);
    }
  }

  const nowIso = new Date().toISOString();
  let publishedVersion = 1;

  await db.runTransaction(async (tx: any) => {
    const globalRef = db.collection("platform_config").doc("global");
    const globalTiersRef = db.collection("platform_config").doc("global_tiers");

    const [globalSnap, globalTiersSnap] = await Promise.all([
      tx.get(globalRef),
      tx.get(globalTiersRef),
    ]);

    const currentGlobal =
      (typeof globalSnap?.exists === "function" ? globalSnap.exists() : Boolean(globalSnap?.exists))
        ? (typeof globalSnap.data === "function" ? globalSnap.data() : globalSnap.data) || {}
        : {};
    const currentTiers =
      (typeof globalTiersSnap?.exists === "function" ? globalTiersSnap.exists() : Boolean(globalTiersSnap?.exists))
        ? (typeof globalTiersSnap.data === "function" ? globalTiersSnap.data() : globalTiersSnap.data) || { providerModels: {} }
        : { providerModels: {} };

    const prevVersion = Math.max(
      Number(currentGlobal.configVersion || 0) || 0,
      Number(currentTiers.configVersion || 0) || 0
    );
    publishedVersion = prevVersion + 1;

    const nextGlobalPayload = {
      ...tempConfig,
      feeTiers: resolvedFeeTiers,
      businessTiers: resolvedBusinessTiers,
      paidAddons: resolvedPaidAddons,
      configVersion: publishedVersion,
      updatedAt: nowIso,
      updatedBy: adminUid,
    };

    const nextGlobalTiersPayload = {
      ...currentTiers,
      configVersion: publishedVersion,
      updatedAt: nowIso,
      updatedBy: adminUid,
      providerModels: {
        ...(currentTiers.providerModels || {}),
        one_off_trades: {
          ...(currentTiers.providerModels?.one_off_trades || {}),
          tiers: {
            ...(currentTiers.providerModels?.one_off_trades?.tiers || {}),
            ...mappedOneOffTiers,
          },
        },
      },
    };

    const versionRef = db.collection("platform_config_versions").doc(`v${publishedVersion}`);
    const auditRef = db.collection("admin_audit_logs").doc(`config_publish_v${publishedVersion}_${Date.now()}`);

    tx.set(globalRef, nextGlobalPayload);
    tx.set(globalTiersRef, nextGlobalTiersPayload, { merge: true });
    tx.set(versionRef, {
      version: publishedVersion,
      publishedAt: nowIso,
      publishedBy: adminUid,
      publishedByEmail: adminEmail || null,
      feeTiersCount: resolvedFeeTiers.length,
      businessTiersCount: resolvedBusinessTiers.length,
      globalSnapshot: nextGlobalPayload,
      globalTiersSnapshot: nextGlobalTiersPayload,
    });
    tx.set(auditRef, {
      action: "update_settings",
      targetId: "global",
      targetType: "config",
      details: `Atomically published platform pricing config v${publishedVersion} across global and global_tiers`,
      configVersion: publishedVersion,
      adminId: adminUid,
      adminEmail: adminEmail || null,
      timestamp: nowIso,
    });
  });

  invalidateDynamicConfigCache(db);

  return {
    success: true,
    configVersion: publishedVersion,
    publishedAt: nowIso,
    publishedBy: adminUid,
  };
}
