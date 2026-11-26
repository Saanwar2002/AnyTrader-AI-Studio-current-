import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  getOnboardingStepProgress,
  getPreviousOnboardingStep,
} from "../../src/lib/onboardingSteps.ts";
import { executeBootstrapProfileCommand } from "../../src/server/accountBootstrap.ts";
import { BadRequestError } from "../../src/server/httpErrors.ts";

function createMockFirestore() {
  const store: Record<string, any> = {};

  const db: any = {
    _store: store,
    collection: (col: string) => ({
      doc: (id: string) => ({
        id,
        path: `${col}/${id}`,
        async get() {
          const data = store[`${col}/${id}`];
          return {
            id,
            exists: data !== undefined,
            data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
          };
        },
      }),
    }),
    runTransaction: async (fn: any) => {
      const transaction = {
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any, options?: any) => {
          const current = store[ref.path];
          if (options?.merge && current) {
            store[ref.path] = { ...current, ...JSON.parse(JSON.stringify(data)) };
          } else {
            store[ref.path] = JSON.parse(JSON.stringify(data));
          }
        },
        update: (ref: any, data: any) => {
          const current = store[ref.path];
          if (!current) throw new Error(`Document ${ref.path} does not exist`);
          store[ref.path] = { ...current, ...JSON.parse(JSON.stringify(data)) };
        },
      };
      return fn(transaction);
    },
  };

  return db;
}

describe("Task 9 — Onboarding Flow Polish & Server/Client Sync", () => {
  describe("Dynamic Role-Aware Step Progress", () => {
    it("shows neutral prompt before role selection", () => {
      const progress = getOnboardingStepProgress({ step: 1, role: null });
      expect(progress.label).toBe("Step 1 · Choose Role");
      expect(progress.currentStep).toBe(1);
    });

    it("computes 1-step flow for Homeowner (and 2-step if SMS verification runs)", () => {
      expect(getOnboardingStepProgress({ step: 1, role: "homeowner" }).label).toBe("Step 1 of 1");
      expect(getOnboardingStepProgress({ step: 4, role: "homeowner" }).label).toBe("Step 2 of 2");
    });

    it("computes 2-step or 3-step flow for Tradesperson depending on required certifications", () => {
      expect(
        getOnboardingStepProgress({ step: 1, role: "tradesperson", requiresVerification: false }).label
      ).toBe("Step 1 of 2");
      expect(
        getOnboardingStepProgress({ step: 2, role: "tradesperson", requiresVerification: false }).label
      ).toBe("Step 2 of 2");
      expect(
        getOnboardingStepProgress({ step: 2, role: "tradesperson", requiresVerification: true }).label
      ).toBe("Step 2 of 3");
      expect(
        getOnboardingStepProgress({ step: 3, role: "tradesperson", requiresVerification: true }).label
      ).toBe("Step 3 of 3");
    });

    it("computes 2-step flow for Driver (Details -> Driver Verification)", () => {
      expect(getOnboardingStepProgress({ step: 1, role: "fleet_driver" }).label).toBe("Step 1 of 2");
      expect(getOnboardingStepProgress({ step: 3, role: "fleet_driver" }).label).toBe("Step 2 of 2");
    });

    it("computes 3-step or 4-step flow for Business across Step 1, 1.5, 2, and 3", () => {
      expect(
        getOnboardingStepProgress({ step: 1, role: "business", businessLayer: null }).label
      ).toBe("Step 1 of 3");
      expect(
        getOnboardingStepProgress({ step: 1.5, role: "business", businessLayer: null }).label
      ).toBe("Step 2 of 3");
      expect(
        getOnboardingStepProgress({ step: 2, role: "business", businessLayer: "properties" }).label
      ).toBe("Step 3 of 3");
      expect(
        getOnboardingStepProgress({
          step: 2,
          role: "business",
          businessLayer: "field_services",
          requiresVerification: true,
        }).label
      ).toBe("Step 3 of 4");
      expect(
        getOnboardingStepProgress({
          step: 3,
          role: "business",
          businessLayer: "field_services",
          requiresVerification: true,
        }).label
      ).toBe("Step 4 of 4");
    });
  });

  describe("Deterministic Back Navigation", () => {
    it("routes Business back to Step 1.5 from Step 2 and Tradesperson back to Step 1", () => {
      expect(getPreviousOnboardingStep(2, "business")).toBe(1.5);
      expect(getPreviousOnboardingStep(2, "tradesperson")).toBe(1);
      expect(getPreviousOnboardingStep(1.5, "business")).toBe(1);
      expect(getPreviousOnboardingStep(3, "fleet_driver")).toBe(1);
      expect(getPreviousOnboardingStep(3, "tradesperson")).toBe(2);
      expect(getPreviousOnboardingStep(3, "business")).toBe(2);
    });
  });

  describe("Server Bootstrap Sync (memberId, memberSequence, deviceId, subscriptionType)", () => {
    it("persists validated memberId, memberSequence, deviceId, and server-derived subscriptionType for Business", async () => {
      const mockDb = createMockFirestore();
      const result = await executeBootstrapProfileCommand(
        mockDb,
        { uid: "biz_sync_1", email: "director@example.com" },
        {
          role: "business",
          name: "Prime Properties Ltd",
          phone: "07700900123",
          postcode: "SW1A 1AA",
          city: "London",
          businessLayer: "properties",
          businessCategory: "Portfolio Landlord",
          memberId: "BUS-00042",
          memberSequence: 42,
          deviceId: "ZGV2aWNlX2hhc2hfMTIz",
        },
        "198.51.100.10"
      );

      expect(result.success).toBe(true);
      const saved = mockDb._store["users/biz_sync_1"];
      expect(saved.subscriptionType).toBe("business");
      expect(saved.memberId).toBe("BUS-00042");
      expect(saved.memberSequence).toBe(42);
      expect(saved.deviceId).toBe("ZGV2aWNlX2hhc2hfMTIz");
      expect(saved.ipAddress).toBe("198.51.100.10");
      expect(saved.category).toBe("Portfolio Landlord");
      expect(saved.primaryTrade).toBe("");
      expect(saved.trades).toEqual([]);
      expect(saved.subcategories).toEqual([]);
    });

    it("derives fallback memberId and sets subscriptionType=null for Homeowner & Tradesperson", async () => {
      const mockDb = createMockFirestore();
      await executeBootstrapProfileCommand(
        mockDb,
        { uid: "trader_sync_99", email: "solo@example.com" },
        {
          role: "tradesperson",
          name: "Sam Sparky",
          trades: ["Electrical"],
          subcategories: ["Rewiring"],
        },
        "203.0.113.5"
      );

      const saved = mockDb._store["users/trader_sync_99"];
      expect(saved.subscriptionType).toBeNull();
      expect(saved.memberId).toBe("AT-TRADER_S");
      expect(saved.memberSequence).toBeNull();
      expect(saved.deviceId).toBeNull();

      const pub = mockDb._store["public_profiles/trader_sync_99"];
      expect(pub).toBeDefined();
      expect(pub.primaryTrade).toBe("Electrical");
      expect(pub.categories).toEqual(["Electrical"]);
    });

    it("rejects client-supplied subscriptionType or malformed memberId (strict schema)", async () => {
      const mockDb = createMockFirestore();
      await expect(
        executeBootstrapProfileCommand(
          mockDb,
          { uid: "attacker_sub", email: "a@example.com" },
          {
            role: "homeowner",
            name: "Attacker",
            subscriptionType: "business",
          },
          "127.0.0.1"
        )
      ).rejects.toThrow(BadRequestError);

      await expect(
        executeBootstrapProfileCommand(
          mockDb,
          { uid: "attacker_mid", email: "b@example.com" },
          {
            role: "homeowner",
            name: "Bad MemberId",
            memberId: "<script>alert(1)</script>",
          },
          "127.0.0.1"
        )
      ).rejects.toThrow(BadRequestError);
    });
  });

  describe("Onboarding.tsx Security, UX & Firestore Allowlist Regression Guards", () => {
    const onboardingSource = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/Onboarding.tsx"),
      "utf8"
    );
    const rulesSource = fs.readFileSync(
      path.resolve(process.cwd(), "firestore.rules"),
      "utf8"
    );

    it("removes external api64.ipify.org calls and native browser confirm/alert dialogs", () => {
      expect(onboardingSource).not.toContain("api64.ipify.org");
      expect(onboardingSource).not.toContain("window.confirm(");
      expect(onboardingSource).not.toMatch(/\balert\(/);
    });

    it("replaces hardcoded Step 1 of 3 with dynamic stepProgress and clarifies role labels", () => {
      expect(onboardingSource).not.toContain("Step 1 of 3");
      expect(onboardingSource).toContain("{stepProgress.label}");
      expect(onboardingSource).toContain("getPreviousOnboardingStep(");
      expect(onboardingSource).toContain("Homeowner / Customer");
      expect(onboardingSource).toContain("Solo trader & side-hustle");
      expect(onboardingSource).toContain("Multi-staff firms, landlords & agencies");
    });

    it("aligns every clientFallbackProfile key strictly with firestore.rules /users/{userId} allow create allowlist", () => {
      const usersMatch = rulesSource.match(
        /match \/users\/\{userId\}[\s\S]*?allow create:[\s\S]*?hasOnly\(\[([\s\S]*?)\]\)/
      );
      expect(usersMatch).not.toBeNull();
      const allowedKeys = new Set(
        Array.from(usersMatch![1].matchAll(/'([^']+)'/g)).map((m) => m[1])
      );

      const fallbackMatch = onboardingSource.match(
        /const clientFallbackProfile = \{([\s\S]*?)\};/
      );
      expect(fallbackMatch).not.toBeNull();
      const fallbackKeys = Array.from(
        fallbackMatch![1].matchAll(/^\s*([a-zA-Z0-9_]+)\s*:/gm)
      ).map((m) => m[1]);

      expect(fallbackKeys.length).toBeGreaterThan(10);
      for (const key of fallbackKeys) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    });
  });
});
