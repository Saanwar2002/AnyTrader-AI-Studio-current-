import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  getAllowedBusinessLayers,
  getDefaultBusinessTab,
  isAnyRollerDriverAccount,
  isConsultancyAccount,
  isPayoutEligibleAccount,
  isPropertyBusinessAccount,
  isPropertyOnlyBusinessAccount,
  isServiceProviderProfile,
  isTradeProviderAccount,
} from "../../src/lib/accountRoles";
import { shortlistTradeCategories } from "../../src/lib/tradeCategoryShortlist";
import { TRADE_CATEGORIES } from "../../src/constants";
import {
  assertPayoutEligibleRole,
  isPayoutEligibleUser,
} from "../../src/server/stripeConnectHelpers";
import {
  executeBootstrapProfileCommand,
} from "../../src/server/accountBootstrap";

function createMockFirestore() {
  const store: Record<string, any> = {};
  const makeDocRef = (col: string, id: string) => ({
    _path: `${col}/${id}`,
    id,
    get: async () => ({
      exists: Boolean(store[`${col}/${id}`]),
      id,
      data: () => store[`${col}/${id}`],
    }),
  });

  const db: any = {
    _store: store,
    collection: (col: string) => ({
      doc: (id: string) => makeDocRef(col, id),
      where: () => ({
        limit: () => ({
          get: async () => ({ empty: true, docs: [] }),
        }),
      }),
    }),
    runTransaction: async (fn: any) => {
      const pendingWrites: Array<{ path: string; data: any }> = [];
      const tx = {
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any) => {
          pendingWrites.push({ path: ref._path, data });
        },
      };
      const result = await fn(tx);
      for (const w of pendingWrites) {
        store[w.path] = w.data;
      }
      return result;
    },
  };
  return db;
}

describe("Task 5: Role Separation, Business Layer Isolation & Multi-Word Trade Shortlisting", () => {
  describe("1. Role & Business Layer Separation (accountRoles.ts)", () => {
    it("classifies pure solo tradesperson as trade provider, service provider, and payout-eligible", () => {
      const profile = { role: "tradesperson", capabilities: ["tradesperson", "homeowner"] };
      expect(isTradeProviderAccount(profile)).toBe(true);
      expect(isServiceProviderProfile(profile)).toBe(true);
      expect(isPropertyBusinessAccount(profile)).toBe(false);
      expect(isPropertyOnlyBusinessAccount(profile)).toBe(false);
      expect(isPayoutEligibleAccount(profile)).toBe(true);
      expect(isAnyRollerDriverAccount(profile)).toBe(false);
    });

    it("classifies Business -> Property & Asset Management as property-only (NOT trade provider, NOT service provider, NOT payout-eligible)", () => {
      const profile = {
        role: "business",
        businessLayer: "properties",
        capabilities: ["homeowner", "landlord", "property_manager", "estate_agent"],
      };
      expect(isPropertyBusinessAccount(profile)).toBe(true);
      expect(isPropertyOnlyBusinessAccount(profile)).toBe(true);
      expect(isTradeProviderAccount(profile)).toBe(false);
      expect(isConsultancyAccount(profile)).toBe(false);
      expect(isServiceProviderProfile(profile)).toBe(false);
      expect(isPayoutEligibleAccount(profile)).toBe(false);
      expect(getAllowedBusinessLayers(profile)).toEqual(["properties"]);
      expect(getDefaultBusinessTab(profile)).toBe("properties");
    });

    it("classifies Business -> Trades & Field Services as trade provider, service provider, payout-eligible, and locked to field_services tab", () => {
      const profile = {
        role: "business",
        businessLayer: "field_services",
        capabilities: ["contractor", "tradesperson", "homeowner"],
      };
      expect(isTradeProviderAccount(profile)).toBe(true);
      expect(isServiceProviderProfile(profile)).toBe(true);
      expect(isPropertyBusinessAccount(profile)).toBe(false);
      expect(isPayoutEligibleAccount(profile)).toBe(true);
      expect(getAllowedBusinessLayers(profile)).toEqual(["field_services"]);
      expect(getDefaultBusinessTab(profile)).toBe("field_services");
    });

    it("normalizes legacy businessLayer 'trades' to 'field_services'", () => {
      const profile = { role: "business", businessLayer: "trades" };
      expect(isTradeProviderAccount(profile)).toBe(true);
      expect(getAllowedBusinessLayers(profile)).toEqual(["field_services"]);
      expect(getDefaultBusinessTab(profile)).toBe("field_services");
    });

    it("classifies Business -> Consultancy as consultancy provider locked to consultancy tab", () => {
      const profile = {
        role: "business",
        businessLayer: "consultancy",
        capabilities: ["homeowner", "consultant"],
      };
      expect(isConsultancyAccount(profile)).toBe(true);
      expect(isServiceProviderProfile(profile)).toBe(true);
      expect(isTradeProviderAccount(profile)).toBe(false);
      expect(isPropertyBusinessAccount(profile)).toBe(false);
      expect(isPayoutEligibleAccount(profile)).toBe(true);
      expect(getAllowedBusinessLayers(profile)).toEqual(["consultancy"]);
      expect(getDefaultBusinessTab(profile)).toBe("consultancy");
    });

    it("preserves driver classification and allows dual-capability accounts without cross-leakage", () => {
      const driver = { role: "fleet_driver", capabilities: ["fleet_driver", "homeowner"] };
      expect(isAnyRollerDriverAccount(driver)).toBe(true);
      expect(isPayoutEligibleAccount(driver)).toBe(true);
      expect(isTradeProviderAccount(driver)).toBe(false);

      const dualLandlordDriver = {
        role: "business",
        businessLayer: "properties",
        capabilities: ["homeowner", "landlord", "fleet_driver"],
      };
      expect(isPropertyBusinessAccount(dualLandlordDriver)).toBe(true);
      expect(isPayoutEligibleAccount(dualLandlordDriver)).toBe(true);
      expect(getAllowedBusinessLayers(dualLandlordDriver)).toEqual(["properties"]);
    });

    it("classifies homeowner as consumer with no provider or payout flags", () => {
      const homeowner = { role: "homeowner", capabilities: ["homeowner"] };
      expect(isTradeProviderAccount(homeowner)).toBe(false);
      expect(isPropertyBusinessAccount(homeowner)).toBe(false);
      expect(isServiceProviderProfile(homeowner)).toBe(false);
      expect(isPayoutEligibleAccount(homeowner)).toBe(false);
    });
  });

  describe("2. Server-Side Stripe Connect Payout Eligibility (stripeConnectHelpers.ts)", () => {
    it("blocks Property & Asset Management businesses from Stripe Connect payout onboarding", () => {
      const propertyBiz = {
        role: "business",
        businessLayer: "properties",
        capabilities: ["homeowner", "landlord", "property_manager", "estate_agent"],
      };
      expect(isPayoutEligibleUser(propertyBiz)).toBe(false);
      expect(() => assertPayoutEligibleRole(propertyBiz)).toThrow(/restricted/i);
    });

    it("blocks homeowners from Stripe Connect payout onboarding", () => {
      expect(isPayoutEligibleUser({ role: "homeowner" })).toBe(false);
      expect(() => assertPayoutEligibleRole({ role: "homeowner" })).toThrow(/restricted/i);
    });

    it("allows tradespeople, trade businesses, consultancies, and AnyRoller drivers", () => {
      expect(isPayoutEligibleUser({ role: "tradesperson" })).toBe(true);
      expect(isPayoutEligibleUser({ role: "business", businessLayer: "field_services" })).toBe(true);
      expect(isPayoutEligibleUser({ role: "business", businessLayer: "trades" })).toBe(true);
      expect(isPayoutEligibleUser({ role: "business", businessLayer: "consultancy" })).toBe(true);
      expect(isPayoutEligibleUser({ role: "fleet_driver" })).toBe(true);
      expect(isPayoutEligibleUser({ role: "driver" })).toBe(true);
      expect(() => assertPayoutEligibleRole({ role: "tradesperson" })).not.toThrow();
      expect(() => assertPayoutEligibleRole({ role: "business", businessLayer: "field_services" })).not.toThrow();
    });
  });

  describe("3. Multi-Word Trade Category Shortlisting (tradeCategoryShortlist.ts)", () => {
    it("returns all categories unmodified when search query is empty", () => {
      const all = shortlistTradeCategories(TRADE_CATEGORIES, "");
      expect(all.length).toBe(TRADE_CATEGORIES.length);
    });

    it("shortlists relevant heating/plumbing categories for multi-word queries like 'boiler leak radiator'", () => {
      const results = shortlistTradeCategories(TRADE_CATEGORIES, "boiler leak radiator");
      expect(results.length).toBeGreaterThan(0);
      const topNames = results.slice(0, 5).map((r) => r.category.name.toLowerCase());
      expect(
        topNames.some((n) => n.includes("gas") || n.includes("heating") || n.includes("plumb"))
      ).toBe(true);
      expect(results[0].matchedTokenCount).toBeGreaterThanOrEqual(2);
    });

    it("shortlists outdoor/fencing categories for 'garden fence decking'", () => {
      const results = shortlistTradeCategories(TRADE_CATEGORIES, "garden fence decking");
      expect(results.length).toBeGreaterThan(0);
      const names = results.slice(0, 6).map((r) => r.category.name.toLowerCase());
      expect(
        names.some((n) => n.includes("garden") || n.includes("landscap") || n.includes("fenc"))
      ).toBe(true);
    });

    it("enforces strict front-of-word prefix matching so 'pet' matches Pet services and never 'Carpet'", () => {
      const results = shortlistTradeCategories(TRADE_CATEGORIES, "pet");
      const names = results.map((r) => r.category.name.toLowerCase());
      expect(names.some((n) => n.includes("pet"))).toBe(true);
      expect(names.some((n) => n.includes("carpet"))).toBe(false);
    });

    it("ranks categories matching multiple words above single-word matches", () => {
      const results = shortlistTradeCategories(TRADE_CATEGORIES, "mobile tyre fitting");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category.name.toLowerCase()).toContain("tyre");
      expect(results[0].matchedTokenCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("4. Account Bootstrap: Tradesperson vs Property Business", () => {
    it("creates a public_profiles listing and tradesperson capability for standalone tradesperson signup with multiple categories", async () => {
      const mockDb = createMockFirestore();
      await executeBootstrapProfileCommand(
        mockDb,
        { uid: "trader_multi_1", email: "plumber@example.com" },
        {
          role: "tradesperson",
          name: "Sam Patel",
          postcode: "SW1A 1AA",
          trades: ["Plumbing", "Gas & Heating"],
          subcategories: ["Boiler Repair", "Leak Detection"],
        },
        "127.0.0.1"
      );

      const userDoc = mockDb._store["users/trader_multi_1"];
      const pubDoc = mockDb._store["public_profiles/trader_multi_1"];
      expect(userDoc.role).toBe("tradesperson");
      expect(userDoc.accountType).toBe("service_provider");
      expect(userDoc.capabilities).toEqual(["tradesperson", "homeowner"]);
      expect(userDoc.businessLayer).toBeNull();
      expect(userDoc.trades).toEqual(["Plumbing", "Gas & Heating"]);
      expect(pubDoc).toBeDefined();
      expect(pubDoc.trades).toEqual(["Plumbing", "Gas & Heating"]);
    });

    it("creates NO public_profiles listing for Business -> Property & Asset Management", async () => {
      const mockDb = createMockFirestore();
      await executeBootstrapProfileCommand(
        mockDb,
        { uid: "prop_biz_1", email: "lettings@example.com" },
        {
          role: "business",
          name: "Oakridge Lettings",
          postcode: "E1 6AN",
          businessLayer: "properties",
          businessCategory: "Letting & Estate Agency",
          trades: [],
        },
        "127.0.0.1"
      );

      const userDoc = mockDb._store["users/prop_biz_1"];
      expect(userDoc.role).toBe("business");
      expect(userDoc.businessLayer).toBe("properties");
      expect(userDoc.businessCategory).toBe("Letting & Estate Agency");
      expect(userDoc.capabilities).toEqual(["homeowner", "landlord", "property_manager", "estate_agent"]);
      expect(mockDb._store["public_profiles/prop_biz_1"]).toBeUndefined();
    });
  });

  describe("5. Firestore Rules Security Guard: businessLayer locked after creation", () => {
    it("allows businessLayer on /users/{userId} create but excludes it from client self-update allowlist", () => {
      const rulesText = fs.readFileSync(path.resolve(process.cwd(), "firestore.rules"), "utf8");
      const usersMatch = rulesText.match(/match \/users\/\{userId\}\s*\{[\s\S]*?allow update:[\s\S]*?\);/);
      expect(usersMatch).not.toBeNull();
      const usersSection = usersMatch![0];

      const createPart = usersSection.split("allow update:")[0];
      const updatePart = usersSection.split("allow update:")[1];

      expect(createPart).toContain("'businessLayer'");
      expect(updatePart).not.toContain("'businessLayer'");
    });
  });
});
