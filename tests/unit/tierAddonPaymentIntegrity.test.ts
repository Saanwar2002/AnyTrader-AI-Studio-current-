import { describe, it, expect } from "vitest";
import { resolveAuthoritativeLineItem, resolveAnyTraderCommission } from "../../src/server/pricingCatalog.ts";
import { getSubscriptionIdForProduct, resolveVerifiedSubscriptionTarget } from "../../src/server/stripeSubscriptionGuards.ts";
import { resolveSubscriptionProductMatch, buildLandlordCheckoutFulfillmentPatch, buildSubscriptionLifecyclePatch } from "../../src/server/subscriptionLifecycle.ts";
import { resolveTier, PROVIDER_TIERS } from "../../src/lib/useEntitlements.ts";
import { PUBLIC_PROFILE_ALLOWED_KEYS, sanitizePublicProfilePayload } from "../../src/lib/publicProfileProjection.ts";

function buildMockDb(docs: Record<string, any> = {}) {
  return {
    collection: (col: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const key = `${col}/${id}`;
          return docs[key]
            ? { exists: true, id, data: () => docs[key] }
            : { exists: false, id, data: () => ({}) };
        }
      })
    })
  };
}

describe("Task 3B: Tier & Add-On Stripe Checkout, Founding PRO, Dual-Role Isolation & Revocation", () => {
  it("routes Exclusive Leads, Video Pro, Ad Wallet Top-Up, and Gotham SaaS correctly even when body.tierName is set without priceId", async () => {
    const db = buildMockDb();

    // 1. Exclusive Leads (BillingManager style: tierName set, no priceId)
    const excl1 = await resolveAuthoritativeLineItem({
      tierName: "Exclusive Leads Add-on",
      metadata: { isExclusiveAddon: "true", type: "exclusive_leads" }
    }, "u_trader_1", db);
    expect(excl1.authoritativeAmountPence).toBe(2900);
    expect(excl1.metadata.type).toBe("exclusive_leads");
    expect(excl1.metadata.isExclusiveAddon).toBe("true");

    // 2. Exclusive Leads (legacy TradesDashboard price_mock_exclusive_addon)
    const excl2 = await resolveAuthoritativeLineItem({
      priceId: "price_mock_exclusive_addon",
      tierName: "Exclusive Leads Add-on",
      metadata: { isExclusiveAddon: "true" }
    }, "u_trader_1", db);
    expect(excl2.authoritativeAmountPence).toBe(2900);
    expect(excl2.metadata.type).toBe("exclusive_leads");

    // 3. Verified Video Pro (tierName set, no priceId)
    const video = await resolveAuthoritativeLineItem({
      tierName: "Verified Video Pro",
      metadata: { isVideoPro: "true", type: "video_pro_subscription" }
    }, "u_trader_1", db);
    expect(video.authoritativeAmountPence).toBe(1500);
    expect(video.metadata.type).toBe("video_pro_subscription");
    expect(video.metadata.isVideoPro).toBe("true");

    // 4. Ad Wallet Top-Up (tierName set, no priceId)
    const topup = await resolveAuthoritativeLineItem({
      tierName: "Ad Wallet Topup (£50.00)",
      mode: "payment",
      metadata: { type: "ad_wallet_topup", topupAmount: 50 }
    }, "u_trader_1", db);
    expect(topup.authoritativeAmountPence).toBe(5000);
    expect(topup.mode).toBe("payment");
    expect(topup.metadata.type).toBe("ad_wallet_topup");

    // 5. Gotham B2B SaaS (tierName set, no priceId)
    const gotham = await resolveAuthoritativeLineItem({
      tierName: "Growth Portfolio",
      mode: "subscription",
      metadata: { type: "gotham_saas", subscriptionType: "gotham_saas", gothamDoorsCount: "200", gothamBillingCycle: "monthly" }
    }, "u_corp_1", db);
    expect(gotham.authoritativeAmountPence).toBe(70000); // 200 doors * £3.50
    expect(gotham.metadata.type).toBe("gotham_saas");
  });

  it("routes Appointment System add-on (£9.99/mo default and dynamic Admin override)", async () => {
    const defaultDb = buildMockDb();
    const resDefault = await resolveAuthoritativeLineItem({
      priceId: "price_appointments",
      metadata: { type: "appointments", subscriptionType: "appointments" }
    }, "u_trader_1", defaultDb);
    expect(resDefault.authoritativeAmountPence).toBe(999);
    expect(resDefault.mode).toBe("subscription");
    expect(resDefault.metadata.type).toBe("appointments");

    const customDb = buildMockDb({
      "platform_config/global": {
        paidAddons: { appointments: { price: 12.50 } }
      }
    });
    const resCustom = await resolveAuthoritativeLineItem({
      tierName: "Appointment System Add-on",
      metadata: { type: "appointments" }
    }, "u_trader_1", customDb);
    expect(resCustom.authoritativeAmountPence).toBe(1250);
  });

  it("rejects Free Explorer (price_payg) and unrecognized tiers at Checkout instead of silently billing Silver Pro", async () => {
    const db = buildMockDb();

    await expect(
      resolveAuthoritativeLineItem({ priceId: "price_payg", tierName: "Free Explorer" }, "u_trader_1", db)
    ).rejects.toThrow(/free/i);

    await expect(
      resolveAuthoritativeLineItem({ tierName: "Completely Unknown Mystery Plan" }, "u_trader_1", db)
    ).rejects.toThrow(/unrecognized/i);
  });

  it("honors Founding PRO (£9.99/mo) exclusively when verified in Firestore users/{uid}", async () => {
    const db = buildMockDb({
      "users/u_founder": { uid: "u_founder", isFoundingMember: true, role: "tradesperson" },
      "users/u_regular": { uid: "u_regular", isFoundingMember: false, role: "tradesperson" }
    });

    // Verified founder gets £9.99 (999p)
    const founderRes = await resolveAuthoritativeLineItem(
      { priceId: "price_pro", tierName: "Founding PRO" },
      "u_founder",
      db
    );
    expect(founderRes.authoritativeAmountPence).toBe(999);
    expect(founderRes.metadata.isFoundingPro).toBe("true");
    expect(founderRes.metadata.tierName).toBe("Founding PRO");

    // Non-founder attempting to spoof tierName "Founding PRO" still pays standard £19.99 (1999p)
    const spoofRes = await resolveAuthoritativeLineItem(
      { priceId: "price_pro", tierName: "Founding PRO" },
      "u_regular",
      db
    );
    expect(spoofRes.authoritativeAmountPence).toBe(1999);
    expect(spoofRes.metadata.isFoundingPro).not.toBe("true");
  });

  it("immediately downgrades cancelled/unpaid paid Trader tiers to PAYG commission and entitlements", async () => {
    const db = buildMockDb();

    // Active Platinum trader -> 1.5%
    const activePlat = await resolveAnyTraderCommission({
      amountPence: 100000,
      traderData: { tier: "platinum", tierId: "Platinum Enterprise", subscriptionStatus: "active" },
      firestoreDb: db
    });
    expect(activePlat.commissionRate).toBe(0.015);
    expect(activePlat.normalizedTier).toBe("platinum");

    // Canceled Platinum trader (even if stale tier field remains) -> forced back to PAYG 5%
    const canceledPlat = await resolveAnyTraderCommission({
      amountPence: 100000,
      traderData: { tier: "platinum", tierId: "Platinum Enterprise", subscriptionStatus: "canceled" },
      firestoreDb: db
    });
    expect(canceledPlat.commissionRate).toBe(0.05);
    expect(canceledPlat.normalizedTier).toBe("payg");

    // Client-side entitlement evaluator also downgrades terminal subscriptionStatus to PAYG
    const resolvedTier = resolveTier({
      uid: "u_canceled",
      role: "tradesperson",
      tier: "platinum",
      tierId: "Platinum Enterprise",
      subscriptionStatus: "canceled"
    });
    expect(resolvedTier).toBe("PAYG");
    expect(PROVIDER_TIERS[resolvedTier].hasApiAccess).toBe(false);
  });

  it("keeps Dual-Role Trader + Landlord Pro subscriptions completely isolated across lifecycle and cancellation", async () => {
    const dualRoleProfile = {
      uid: "u_dual",
      role: "tradesperson",
      tier: "premium",
      tierId: "Gold Elite",
      subscriptionId: "sub_trader_gold",
      subscriptionType: "tier",
      subscriptionStatus: "active",
      isLandlord: true,
      homeownerTierId: "landlord",
      landlordSubscriptionId: "sub_landlord_pro",
      homeownerSubscriptionStatus: "active",
      appointmentsSubscriptionId: "sub_appt_1",
      hasAppointmentsAddon: true,
      appointmentsSubscriptionStatus: "active"
    };

    expect(getSubscriptionIdForProduct(dualRoleProfile, "tier")).toBe("sub_trader_gold");
    expect(getSubscriptionIdForProduct(dualRoleProfile, "landlord")).toBe("sub_landlord_pro");
    expect(getSubscriptionIdForProduct(dualRoleProfile, "appointments")).toBe("sub_appt_1");

    // Landlord fulfillment does not overwrite trader subscriptionId
    const landlordPatch = buildLandlordCheckoutFulfillmentPatch("sub_landlord_new", {
      id: "sub_landlord_new",
      status: "active",
      cancel_at_period_end: false,
      current_period_end: 1_800_000_000
    });
    expect(landlordPatch.landlordSubscriptionId).toBe("sub_landlord_new");
    expect(landlordPatch).not.toHaveProperty("subscriptionId");
    expect(landlordPatch).not.toHaveProperty("tier");

    // Canceling Landlord Pro revokes isLandlord without touching Trader Gold Elite
    const landlordCancelPatch = buildSubscriptionLifecyclePatch("landlord", {
      id: "sub_landlord_pro",
      status: "canceled",
      cancel_at_period_end: true,
      current_period_end: 1_800_000_000
    });
    expect(landlordCancelPatch.isLandlord).toBe(false);
    expect(landlordCancelPatch.homeownerTierId).toBe("standard");
    expect(landlordCancelPatch).not.toHaveProperty("tier");
    expect(landlordCancelPatch).not.toHaveProperty("isPro");

    // Product resolution ignores superseded legacy landlord subscriptionId
    const membershipDesc = { key: "membership" as const, idField: "subscriptionId", lastCreated: "subscriptionLastEventCreated", lastId: "subscriptionLastEventId" };
    const staleLegacyMatch = resolveSubscriptionProductMatch([{
      product: membershipDesc,
      userDoc: {
        id: "u_dual",
        data: () => ({ subscriptionType: "landlord", subscriptionId: "sub_old_landlord", landlordSubscriptionId: "sub_landlord_pro" })
      }
    }]);
    expect(staleLegacyMatch).toBeNull();

    // Stripe guard resolves appointments & landlord targets independently
    const verifiedAppt = resolveVerifiedSubscriptionTarget({
      userData: dualRoleProfile,
      requestedType: "appointments",
      action: "cancel"
    });
    expect(verifiedAppt.subscriptionId).toBe("sub_appt_1");
    expect(verifiedAppt.subscriptionType).toBe("appointments");

    const verifiedLandlord = resolveVerifiedSubscriptionTarget({
      userData: dualRoleProfile,
      requestedType: "landlord",
      action: "cancel"
    });
    expect(verifiedLandlord.subscriptionId).toBe("sub_landlord_pro");
    expect(verifiedLandlord.subscriptionType).toBe("landlord");
  });

  it("keeps tier and hasVerifiedVideoProSubscription server-only in public_profiles projection", () => {
    expect(PUBLIC_PROFILE_ALLOWED_KEYS.includes("tier")).toBe(true);
    expect(PUBLIC_PROFILE_ALLOWED_KEYS.includes("hasVerifiedVideoProSubscription")).toBe(true);

    const sanitized = sanitizePublicProfilePayload({
      displayName: "Trusted Plumber",
      tier: "platinum",
      tierId: "Platinum Enterprise",
      hasVerifiedVideoProSubscription: true
    });
    expect(sanitized.displayName).toBe("Trusted Plumber");
    // Client writes cannot spoof server-only entitlement fields on public_profiles
    expect(sanitized).not.toHaveProperty("tier");
    expect(sanitized).not.toHaveProperty("tierId");
    expect(sanitized).not.toHaveProperty("hasVerifiedVideoProSubscription");
  });
});
