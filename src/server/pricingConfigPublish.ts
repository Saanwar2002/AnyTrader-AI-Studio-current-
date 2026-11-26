/**
 * Atomic Versioned Pricing & Commission Configuration Publisher (AT-ADMIN-CONFIG-01)
 *
 * Ensures platform_config/global, platform_config/global_tiers, an immutable
 * platform_config_versions/{version} audit snapshot, and admin_audit_logs
 * are published inside a single atomic Firestore transaction.
 */

import { BadRequestError } from "./httpErrors.ts";
import {
  DEFAULT_ANYTRADER_COMMISSION_CAP_GBP,
  invalidateDynamicConfigCache,
} from "./pricingCatalog.ts";
import { resolveFlexiPayMode, type FlexiPayMode } from "../lib/marketplaceContracts.ts";

export interface PublishPricingConfigInput {
  db: any;
  adminUid: string;
  adminEmail?: string;
  tempConfig: Record<string, any>;
  feeTiers?: any[];
  businessTiers?: any[];
  paidAddons?: Record<string, any>;
  commissionCapGbp?: number;
  globalTiersProviderModels?: Record<string, any>;
}

export interface PublishPricingConfigResult {
  success: boolean;
  configVersion: number;
  publishedAt: string;
  publishedBy: string;
  commissionCapGbp: number;
  flexiPayMode: FlexiPayMode;
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

  const hasExplicitFeeTiers = Array.isArray(feeTiers)
    ? true
    : Array.isArray(tempConfig.feeTiers);
  const inputFeeTiers = Array.isArray(feeTiers)
    ? feeTiers
    : Array.isArray(tempConfig.feeTiers)
      ? tempConfig.feeTiers
      : [];

  const hasExplicitBusinessTiers = Array.isArray(businessTiers)
    ? true
    : Array.isArray(tempConfig.businessTiers);
  const inputBusinessTiers = Array.isArray(businessTiers)
    ? businessTiers
    : Array.isArray(tempConfig.businessTiers)
      ? tempConfig.businessTiers
      : [];

  const hasExplicitPaidAddons = Boolean(
    (paidAddons && typeof paidAddons === "object" && !Array.isArray(paidAddons)) ||
    (tempConfig.paidAddons && typeof tempConfig.paidAddons === "object" && !Array.isArray(tempConfig.paidAddons))
  );
  const inputPaidAddons =
    (paidAddons && typeof paidAddons === "object" && !Array.isArray(paidAddons)
      ? paidAddons
      : tempConfig.paidAddons && typeof tempConfig.paidAddons === "object" && !Array.isArray(tempConfig.paidAddons)
        ? tempConfig.paidAddons
        : null);

  // Validate optional globalTiersProviderModels patch (e.g. from AdminTierManager)
  const sanitizedProviderModelsPatch: Record<string, any> = {};
  if (input.globalTiersProviderModels && typeof input.globalTiersProviderModels === "object") {
    for (const [modelKey, modelVal] of Object.entries(input.globalTiersProviderModels)) {
      if (!modelVal || typeof modelVal !== "object") continue;
      const modelCopy: Record<string, any> = { ...modelVal };
      if (modelCopy.commissionCapGbp !== undefined) {
        modelCopy.commissionCapGbp = assertFiniteNonNegative(
          modelCopy.commissionCapGbp,
          `globalTiersProviderModels.${modelKey}.commissionCapGbp`
        );
      }
      if (modelCopy.tiers && typeof modelCopy.tiers === "object") {
        const validatedTiers: Record<string, any> = {};
        for (const [tierKey, tierCfg] of Object.entries<any>(modelCopy.tiers)) {
          if (!tierCfg || typeof tierCfg !== "object") continue;
          const price = assertFiniteNonNegative(
            tierCfg.price ?? 0,
            `globalTiersProviderModels.${modelKey}.tiers.${tierKey}.price`
          );
          const commission = assertFiniteNonNegative(
            tierCfg.commission ?? 0,
            `globalTiersProviderModels.${modelKey}.tiers.${tierKey}.commission`
          );
          if (commission > 1) {
            throw new BadRequestError(
              `Invalid decimal commission rate for '${modelKey}.${tierKey}': must be between 0 and 1.`
            );
          }
          validatedTiers[tierKey] = {
            ...tierCfg,
            price,
            commission,
          };
        }
        modelCopy.tiers = validatedTiers;
      }
      sanitizedProviderModelsPatch[modelKey] = modelCopy;
    }
  }

  const explicitCapInput =
    input.commissionCapGbp !== undefined
      ? input.commissionCapGbp
      : tempConfig.commissionCapGbp;
  const validatedExplicitCap =
    explicitCapInput !== undefined && explicitCapInput !== null && explicitCapInput !== ""
      ? assertFiniteNonNegative(explicitCapInput, "commissionCapGbp")
      : null;

  // Validate tiers before entering transaction
  const mappedOneOffTiers: Record<string, any> = {};
  for (const ft of inputFeeTiers) {
    if (!ft || typeof ft !== "object") {
      throw new BadRequestError("Each fee tier must be an object.");
    }
    const price = assertFiniteNonNegative(ft.price ?? 0, `feeTiers[${ft.name || "tier"}].price`);
    const rawCommission = assertFiniteNonNegative(ft.commission ?? 0, `feeTiers[${ft.name || "tier"}].commission`);
    if (rawCommission > 100) {
      throw new BadRequestError(`Invalid commission rate for '${ft.name}': cannot exceed 100%.`);
    }
    // feeTiers[].commission from Admin UI is ALWAYS a percentage (0..100, e.g. 5, 3.5, 1, 0.5, 0).
    // Always divide by 100 so promotional <= 1% rates (e.g. 1% or 0.5%) map to 0.01 / 0.005 instead of 100% / 50%.
    const normalizedCommission = Math.round((rawCommission / 100) * 1000000) / 1000000;
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

  for (const bt of inputBusinessTiers) {
    if (!bt || typeof bt !== "object") continue;
    assertFiniteNonNegative(bt.price ?? 0, `businessTiers[${bt.name || "tier"}].price`);
    const comm = assertFiniteNonNegative(bt.commission ?? 0, `businessTiers[${bt.name || "tier"}].commission`);
    if (comm > 100) {
      throw new BadRequestError(`Invalid business tier commission for '${bt.name}': cannot exceed 100%.`);
    }
  }

  const nowIso = new Date().toISOString();
  let publishedVersion = 1;
  let resolvedCommissionCapGbp = validatedExplicitCap ?? DEFAULT_ANYTRADER_COMMISSION_CAP_GBP;
  let resolvedFlexiPayMode: FlexiPayMode = "coming_soon";

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

    if (validatedExplicitCap !== null) {
      resolvedCommissionCapGbp = validatedExplicitCap;
    } else {
      const existingCap =
        currentTiers.providerModels?.one_off_trades?.commissionCapGbp ??
        currentTiers.commissionCapGbp ??
        currentGlobal.commissionCapGbp;
      const parsedExisting = existingCap === undefined || existingCap === null ? NaN : Number(existingCap);
      resolvedCommissionCapGbp =
        Number.isFinite(parsedExisting) && parsedExisting >= 0
          ? parsedExisting
          : DEFAULT_ANYTRADER_COMMISSION_CAP_GBP;
    }

    const rawGraceDays = tempConfig.documentGracePeriodDays;
    const resolvedGraceDays =
      rawGraceDays !== undefined && rawGraceDays !== null && rawGraceDays !== ""
        ? Math.floor(assertFiniteNonNegative(rawGraceDays, "documentGracePeriodDays"))
        : Number.isFinite(Number(currentGlobal.documentGracePeriodDays))
          ? Math.floor(Number(currentGlobal.documentGracePeriodDays))
          : 14;
    const resolvedEnforceGrace =
      typeof tempConfig.enforceDocumentGracePeriod === "boolean"
        ? tempConfig.enforceDocumentGracePeriod
        : typeof currentGlobal.enforceDocumentGracePeriod === "boolean"
          ? currentGlobal.enforceDocumentGracePeriod
          : true;
    const rawProvisionalMaxQuotes = tempConfig.provisionalMaxQuotes;
    const resolvedProvisionalMaxQuotes =
      rawProvisionalMaxQuotes !== undefined && rawProvisionalMaxQuotes !== null && rawProvisionalMaxQuotes !== ""
        ? Math.floor(assertFiniteNonNegative(rawProvisionalMaxQuotes, "provisionalMaxQuotes"))
        : Number.isFinite(Number(currentGlobal.provisionalMaxQuotes))
          ? Math.floor(Number(currentGlobal.provisionalMaxQuotes))
          : 5;

    const rawFlexiPayMode = tempConfig.flexiPayMode;
    if (
      rawFlexiPayMode !== undefined &&
      rawFlexiPayMode !== null &&
      !["off", "coming_soon", "live"].includes(String(rawFlexiPayMode).trim().toLowerCase())
    ) {
      throw new BadRequestError("Invalid configuration value for 'flexiPayMode': must be 'off', 'coming_soon', or 'live'.");
    }
    resolvedFlexiPayMode =
      rawFlexiPayMode !== undefined && rawFlexiPayMode !== null
        ? resolveFlexiPayMode({ flexiPayMode: rawFlexiPayMode })
        : resolveFlexiPayMode(currentGlobal);

    const finalFeeTiers = hasExplicitFeeTiers
      ? inputFeeTiers
      : Array.isArray(currentGlobal.feeTiers)
        ? currentGlobal.feeTiers
        : [];
    const finalBusinessTiers = hasExplicitBusinessTiers
      ? inputBusinessTiers
      : Array.isArray(currentGlobal.businessTiers)
        ? currentGlobal.businessTiers
        : [];
    const finalPaidAddons = hasExplicitPaidAddons
      ? { ...(currentGlobal.paidAddons || {}), ...(inputPaidAddons || {}) }
      : (currentGlobal.paidAddons && typeof currentGlobal.paidAddons === "object"
        ? currentGlobal.paidAddons
        : {});

    // Merge currentGlobal FIRST so partial publishes (e.g. Launch Controls or FlexiPay toggles)
    // NEVER wipe out existing maintenanceMode, taxiPortalMode, feeTiers, businessTiers, or paidAddons.
    const nextGlobalPayload = {
      ...currentGlobal,
      ...tempConfig,
      feeTiers: finalFeeTiers,
      businessTiers: finalBusinessTiers,
      paidAddons: finalPaidAddons,
      commissionCapGbp: resolvedCommissionCapGbp,
      documentGracePeriodDays: resolvedGraceDays,
      enforceDocumentGracePeriod: resolvedEnforceGrace,
      provisionalMaxQuotes: resolvedProvisionalMaxQuotes,
      flexiPayMode: resolvedFlexiPayMode,
      configVersion: publishedVersion,
      updatedAt: nowIso,
      updatedBy: adminUid,
    };

    const mergedProviderModels: Record<string, any> = {
      ...(currentTiers.providerModels || {}),
      ...sanitizedProviderModelsPatch,
    };
    const existingOneOff = mergedProviderModels.one_off_trades || currentTiers.providerModels?.one_off_trades || {};
    mergedProviderModels.one_off_trades = {
      ...existingOneOff,
      commissionCapGbp: resolvedCommissionCapGbp,
      tiers: {
        ...(currentTiers.providerModels?.one_off_trades?.tiers || {}),
        ...(sanitizedProviderModelsPatch.one_off_trades?.tiers || {}),
        ...mappedOneOffTiers,
      },
    };

    const nextGlobalTiersPayload = {
      ...currentTiers,
      commissionCapGbp: resolvedCommissionCapGbp,
      configVersion: publishedVersion,
      updatedAt: nowIso,
      updatedBy: adminUid,
      providerModels: mergedProviderModels,
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
      feeTiersCount: finalFeeTiers.length,
      businessTiersCount: finalBusinessTiers.length,
      commissionCapGbp: resolvedCommissionCapGbp,
      globalSnapshot: nextGlobalPayload,
      globalTiersSnapshot: nextGlobalTiersPayload,
    });
    tx.set(auditRef, {
      action: "update_settings",
      targetId: "global",
      targetType: "config",
      details: `Atomically published platform pricing config v${publishedVersion} across global and global_tiers (cap £${resolvedCommissionCapGbp})`,
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
    commissionCapGbp: resolvedCommissionCapGbp,
    flexiPayMode: resolvedFlexiPayMode,
  };
}
