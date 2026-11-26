import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { resolveProfileRoleView } from "../../src/lib/accountRoles";

const ROOT = process.cwd();

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

describe("Task 6 — Profile & Identity Card Role Resolution (resolveProfileRoleView)", () => {
  it("handles solo tradesperson on AnyTrader and AnyRoller portals", () => {
    const profile = { role: "tradesperson" };

    const anyTrader = resolveProfileRoleView(profile, "anytrader");
    expect(anyTrader.isServiceProvider).toBe(true);
    expect(anyTrader.isPropertyOnlyBusiness).toBe(false);
    expect(anyTrader.isDriver).toBe(false);
    expect(anyTrader.isHomeownerOrPropertyBilling).toBe(false);
    expect(anyTrader.isPayoutEligible).toBe(true);
    expect(anyTrader.shouldLoadProviderReviews).toBe(true);
    expect(anyTrader.shouldLoadMonthlyQuoteUsage).toBe(true);
    expect(anyTrader.shouldSyncPublicProfile).toBe(true);
    expect(anyTrader.tierCatalogBucket).toBe("one_off_trades");
    expect(anyTrader.subscriptionRoleScope).toBe("tier");
    expect(anyTrader.shouldShowAnyRollerPassengerView).toBe(false);
    expect(anyTrader.shouldShowRiderRatingBadge).toBe(false);

    const anyRoller = resolveProfileRoleView(profile, "anyroller");
    expect(anyRoller.shouldShowAnyRollerPassengerView).toBe(true);
    expect(anyRoller.shouldShowRiderRatingBadge).toBe(true);
  });

  it("handles Business -> Trades & Field Services (and legacy 'trades' layer) as service providers", () => {
    for (const businessLayer of ["field_services", "trades"]) {
      const view = resolveProfileRoleView({ role: "business", businessLayer }, "anytrader");
      expect(view.isServiceProvider).toBe(true);
      expect(view.isPropertyOnlyBusiness).toBe(false);
      expect(view.isHomeownerOrPropertyBilling).toBe(false);
      expect(view.isPayoutEligible).toBe(true);
      expect(view.shouldLoadProviderReviews).toBe(true);
      expect(view.shouldLoadMonthlyQuoteUsage).toBe(true);
      expect(view.shouldSyncPublicProfile).toBe(true);
      expect(view.tierCatalogBucket).toBe("one_off_trades");
      expect(view.subscriptionRoleScope).toBe("tier");
    }

    const anyRoller = resolveProfileRoleView(
      { role: "business", businessLayer: "field_services" },
      "anyroller"
    );
    expect(anyRoller.shouldShowAnyRollerPassengerView).toBe(true);
    expect(anyRoller.shouldShowRiderRatingBadge).toBe(true);
  });

  it("handles Business -> Consultancy as service providers with reviews, usage & public_profiles sync", () => {
    const view = resolveProfileRoleView({ role: "business", businessLayer: "consultancy" }, "anytrader");
    expect(view.isServiceProvider).toBe(true);
    expect(view.isPropertyOnlyBusiness).toBe(false);
    expect(view.isPayoutEligible).toBe(true);
    expect(view.shouldLoadProviderReviews).toBe(true);
    expect(view.shouldLoadMonthlyQuoteUsage).toBe(true);
    expect(view.shouldSyncPublicProfile).toBe(true);
    expect(view.tierCatalogBucket).toBe("one_off_trades");
    expect(view.subscriptionRoleScope).toBe("tier");
  });

  it("isolates Property-only Businesses from public_profiles, provider reviews/usage, and trader tiers", () => {
    const view = resolveProfileRoleView({ role: "business", businessLayer: "properties" }, "anytrader");
    expect(view.isServiceProvider).toBe(false);
    expect(view.isPropertyOnlyBusiness).toBe(true);
    expect(view.isHomeownerOrPropertyBilling).toBe(true);
    expect(view.isPayoutEligible).toBe(false);
    expect(view.shouldLoadProviderReviews).toBe(false);
    expect(view.shouldLoadMonthlyQuoteUsage).toBe(false);
    expect(view.shouldSyncPublicProfile).toBe(false);
    expect(view.tierCatalogBucket).toBe("homeowners");
    expect(view.subscriptionRoleScope).toBe("landlord");

    // Existing stripeAccountId keeps payout management reachable without leaking into public_profiles
    const withExistingConnect = resolveProfileRoleView(
      { role: "business", businessLayer: "properties", stripeAccountId: "acct_existing123" },
      "anytrader"
    );
    expect(withExistingConnect.isPayoutEligible).toBe(true);
    expect(withExistingConnect.shouldSyncPublicProfile).toBe(false);

    // Still seamlessly acts as a passenger on AnyRoller
    const anyRoller = resolveProfileRoleView({ role: "business", businessLayer: "properties" }, "anyroller");
    expect(anyRoller.shouldShowAnyRollerPassengerView).toBe(true);
    expect(anyRoller.shouldShowRiderRatingBadge).toBe(true);
  });

  it("recognizes both 'fleet_driver' and 'driver' accounts across AnyTrader and AnyRoller", () => {
    for (const role of ["fleet_driver", "driver"]) {
      const anyTrader = resolveProfileRoleView({ role }, "anytrader");
      expect(anyTrader.isDriver).toBe(true);
      expect(anyTrader.isServiceProvider).toBe(false);
      expect(anyTrader.isPayoutEligible).toBe(true);
      expect(anyTrader.shouldLoadProviderReviews).toBe(false);
      expect(anyTrader.shouldLoadMonthlyQuoteUsage).toBe(false);
      expect(anyTrader.shouldSyncPublicProfile).toBe(false);
      expect(anyTrader.tierCatalogBucket).toBe("on_demand_transport");
      expect(anyTrader.subscriptionRoleScope).toBe("driver_gold");
      expect(anyTrader.shouldShowAnyRollerPassengerView).toBe(false);
      expect(anyTrader.shouldShowRiderRatingBadge).toBe(false);

      // Must NOT show passenger menu or Rider Rating badge on AnyRoller
      const anyRoller = resolveProfileRoleView({ role }, "anyroller");
      expect(anyRoller.shouldShowAnyRollerPassengerView).toBe(false);
      expect(anyRoller.shouldShowRiderRatingBadge).toBe(false);
    }
  });

  it("handles homeowner and customer accounts cleanly", () => {
    for (const role of ["homeowner", "customer"]) {
      const anyTrader = resolveProfileRoleView({ role }, "anytrader");
      expect(anyTrader.isServiceProvider).toBe(false);
      expect(anyTrader.isHomeownerOrPropertyBilling).toBe(true);
      expect(anyTrader.isPayoutEligible).toBe(false);
      expect(anyTrader.shouldLoadProviderReviews).toBe(false);
      expect(anyTrader.shouldLoadMonthlyQuoteUsage).toBe(false);
      expect(anyTrader.shouldSyncPublicProfile).toBe(false);
      expect(anyTrader.tierCatalogBucket).toBe("homeowners");
      expect(anyTrader.subscriptionRoleScope).toBe("landlord");
      expect(anyTrader.shouldShowAnyRollerPassengerView).toBe(false);
      expect(anyTrader.shouldShowRiderRatingBadge).toBe(false);

      const anyRoller = resolveProfileRoleView({ role }, "anyroller");
      expect(anyRoller.shouldShowAnyRollerPassengerView).toBe(true);
      expect(anyRoller.shouldShowRiderRatingBadge).toBe(true);
    }
  });

  it("handles dual-capability tradesperson + driver without losing provider features or showing Rider Rating", () => {
    const view = resolveProfileRoleView(
      { role: "tradesperson", isDriver: true, capabilities: ["tradesperson", "fleet_driver"] },
      "anyroller"
    );
    expect(view.isServiceProvider).toBe(true);
    expect(view.isDriver).toBe(true);
    expect(view.shouldLoadProviderReviews).toBe(true);
    expect(view.shouldLoadMonthlyQuoteUsage).toBe(true);
    expect(view.shouldSyncPublicProfile).toBe(true);
    expect(view.shouldShowAnyRollerPassengerView).toBe(false);
    expect(view.shouldShowRiderRatingBadge).toBe(false);
    expect(view.tierCatalogBucket).toBe("one_off_trades");
  });
});

describe("Task 6 — Source Regression Checks (Profile, HomeownerIdentityCard, BusinessDashboard)", () => {
  it("Profile.tsx uses resolveProfileRoleView, collectionGroup('quotes'), and universal homeownerJobs history", () => {
    const src = readSource("src/components/Profile.tsx");

    expect(src).toContain("resolveProfileRoleView");
    expect(src).toContain("const roleView = resolveProfileRoleView(profile, activePortal);");
    expect(src).toContain("roleView.shouldLoadProviderReviews");
    expect(src).toContain("roleView.shouldLoadMonthlyQuoteUsage");
    expect(src).toContain('collectionGroup(db, "quotes")');
    expect(src).not.toContain('collection(db, "quotes")');
    expect(src).toContain("roleView.shouldSyncPublicProfile");
    expect(src).toContain("roleView.shouldShowAnyRollerPassengerView");
    expect(src).toContain("roleView.tierCatalogBucket");
    expect(src).toContain("roleView.subscriptionRoleScope");

    // Ensure homeowner jobs listener is NOT restricted to role === "homeowner"
    expect(src).not.toMatch(/if\s*\(\s*user\?\.uid\s*&&\s*profile\?\.role\s*===\s*"homeowner"\s*\)/);
    // Ensure AnyRoller passenger view is NOT checking raw `profile?.role !== "driver"`
    expect(src).not.toContain('activePortal === "anyroller" && profile?.role !== "driver"');
  });

  it("HomeownerIdentityCard.tsx uses resolveProfileRoleView().shouldShowRiderRatingBadge", () => {
    const src = readSource("src/components/profile/HomeownerIdentityCard.tsx");
    expect(src).toContain("resolveProfileRoleView");
    expect(src).toContain("shouldShowRiderRatingBadge");
    expect(src).not.toContain('profile.role !== "driver"');
  });

  it("BusinessDashboard.tsx gates Properties section on effectiveTab and links Upgrade Now to /billing", () => {
    const src = readSource("src/components/BusinessDashboard.tsx");
    expect(src).toContain('{effectiveTab === "properties" && (');
    expect(src).not.toContain('{activeTab === "properties" && (');
    expect(src).toContain('to="/billing"');
    expect(src).not.toContain('/settings?tab=subscription');
  });
});
