import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import admin from "firebase-admin";
import { buildClaimPropertyTransferUpdate } from "../../src/server/propertyTransferCommand";
import {
  extractOutwardPostcode,
  sanitizePropertyTenantContext,
  resolveTenantIssueCreationPayload,
  TenantIssueValidationError,
} from "../../src/server/propertyLifecycleHelpers";
import {
  derivePropertyRiskProfile,
  derivePropertyPredictiveInsights,
} from "../../src/lib/propertyInsights";

const FIXED_NOW = Date.parse("2026-11-25T12:00:00.000Z");

describe("Slice 5: Property Passports, Landlords, Tenants & B2B Gotham Hardening", () => {
  describe("1. Ownership Transfer Revocation & PII Cleanup (buildClaimPropertyTransferUpdate)", () => {
    it("revokes public passport sharing consent and deletes prior owner's tenant/contact PII and authorities", () => {
      const update = buildClaimPropertyTransferUpdate({
        property: {
          name: "42 Oak Avenue",
          ownerId: "seller_uid_1",
          isPublicPassport: true,
          publicConsent: true,
          tenantName: "Jane Tenant",
          tenantEmail: "jane@example.com",
          tenantPhone: "07700900111",
          contactName: "Seller Contact",
          contactPhone: "07700900222",
          accessInstructions: "Key safe code 4821",
          previousOwnersCount: 1,
          transferHistory: [],
        },
        newOwnerId: "buyer_uid_2",
        newOwnerEmail: "buyer@example.com",
        transferCode: "TRF-8K92X4",
        transferredAtIso: "2026-11-25T12:00:00.000Z",
      });

      const deleteSentinel = admin.firestore.FieldValue.delete();

      expect(update.ownerId).toBe("buyer_uid_2");
      expect(update.userId).toBe("buyer_uid_2");
      expect(update.homeownerId).toBe("buyer_uid_2");
      expect(update.isPublicPassport).toBe(false);
      expect(update.publicConsent).toBe(false);
      expect(update.publicConsentRevokedAt).toBe("2026-11-25T12:00:00.000Z");

      expect(update.landlordId).toEqual(deleteSentinel);
      expect(update.managerId).toEqual(deleteSentinel);
      expect(update.propertyManagerId).toEqual(deleteSentinel);
      expect(update.assignedManagerId).toEqual(deleteSentinel);
      expect(update.tenantName).toEqual(deleteSentinel);
      expect(update.tenantEmail).toEqual(deleteSentinel);
      expect(update.tenantPhone).toEqual(deleteSentinel);
      expect(update.contactName).toEqual(deleteSentinel);
      expect(update.contactPhone).toEqual(deleteSentinel);
      expect(update.accessInstructions).toEqual(deleteSentinel);

      expect(update.transferStatus).toBe("completed");
      expect(update.transferCode).toBeNull();
      expect(update.previousOwnersCount).toBe(2);
      expect(update.transferHistory).toHaveLength(1);
      expect(update.transferHistory[0].fromOwnerUid).toBe("seller_uid_1");
      expect(update.transferHistory[0].toOwnerUid).toBe("buyer_uid_2");
    });
  });

  describe("2. Privacy-Safe Tenant Property Context (sanitizePropertyTenantContext)", () => {
    it("extracts outward postcode cleanly with or without spacing", () => {
      expect(extractOutwardPostcode("sw1a 1aa")).toBe("SW1A");
      expect(extractOutwardPostcode("SE12AA")).toBe("SE1");
      expect(extractOutwardPostcode("M1 1AE")).toBe("M1");
      expect(extractOutwardPostcode("")).toBe("");
    });

    it("strips street line1, full postcode, landlord/tenant PII, and access codes", () => {
      const ctx = sanitizePropertyTenantContext("prop_123", {
        name: "Maple Court Block B",
        propertyType: "Apartment",
        ownerId: "landlord_secret_uid",
        address: {
          line1: "Flat 9, 120 Secret Street",
          city: "London",
          postcode: "SW1A 1AA",
        },
        tenantName: "Private Tenant",
        tenantPhone: "+44 7700 900999",
        accessInstructions: "Gate PIN 9999",
      });

      expect(ctx).toEqual({
        id: "prop_123",
        name: "Maple Court Block B",
        outwardPostcode: "SW1A",
        city: "London",
        propertyType: "Apartment",
      });
      const serialized = JSON.stringify(ctx);
      expect(serialized).not.toContain("Secret Street");
      expect(serialized).not.toContain("1AA");
      expect(serialized).not.toContain("landlord_secret_uid");
      expect(serialized).not.toContain("Private Tenant");
      expect(serialized).not.toContain("9999");
    });
  });

  describe("3. Tenant Issue Creation Payload Resolution (resolveTenantIssueCreationPayload)", () => {
    it("rejects client-forged landlordOwnerId", () => {
      expect(() =>
        resolveTenantIssueCreationPayload(
          {
            tenantName: "Alex",
            title: "Boiler leak",
            description: "Dripping pipe under boiler",
            landlordOwnerId: "forged_uid_attacker",
          },
          null
        )
      ).toThrow(TenantIssueValidationError);
    });

    it("binds authoritative landlordOwnerId, propertyName, address, and postcode when linked to a property", () => {
      const resolved = resolveTenantIssueCreationPayload(
        {
          tenantName: "Alex Morgan",
          tenantEmail: "ALEX@EXAMPLE.COM",
          category: "Plumbing",
          urgency: "emergency",
          title: "Burst pipe",
          description: "Water leaking from kitchen ceiling",
          manualAddress: "Ignored Fake Address",
          postcode: "ZZ99 9ZZ",
        },
        {
          id: "prop_abc",
          data: {
            ownerId: "real_landlord_42",
            name: "Oakridge Flats",
            address: {
              line1: "14 Oakridge Lane",
              postcode: "E1 6AN",
            },
          },
        }
      );

      expect(resolved.propertyId).toBe("prop_abc");
      expect(resolved.landlordOwnerId).toBe("real_landlord_42");
      expect(resolved.linkedToLandlord).toBe(true);
      expect(resolved.propertyName).toBe("Oakridge Flats");
      expect(resolved.address).toBe("14 Oakridge Lane");
      expect(resolved.postcode).toBe("E1 6AN");
      expect(resolved.tenantEmail).toBe("alex@example.com");
      expect(resolved.urgency).toBe("emergency");
    });

    it("preserves manualAddress (and legacy address fallback) + postcode with linkedToLandlord: false when unlinked", () => {
      const manual = resolveTenantIssueCreationPayload(
        {
          tenantName: "Sam Lee",
          title: "Broken window latch",
          description: "Bedroom window will not lock",
          manualAddress: "22 Baker Street, Flat 3",
          postcode: "nw1 6xe",
        },
        null
      );

      expect(manual.propertyId).toBe("manual");
      expect(manual.linkedToLandlord).toBe(false);
      expect(manual.landlordOwnerId).toBeNull();
      expect(manual.address).toBe("22 Baker Street, Flat 3");
      expect(manual.propertyName).toBe("22 Baker Street, Flat 3");
      expect(manual.postcode).toBe("NW1 6XE");

      const legacyFallback = resolveTenantIssueCreationPayload(
        {
          tenantName: "Sam Lee",
          title: "Radiator cold",
          description: "Living room radiator stays cold",
          address: "88 High Road",
        },
        null
      );
      expect(legacyFallback.address).toBe("88 High Road");
      expect(legacyFallback.linkedToLandlord).toBe(false);
    });
  });

  describe("4. Truthful Property Risk Analytics (derivePropertyRiskProfile)", () => {
    it("never reports CP12 or EICR as valid when missing or expired", () => {
      const missingProfile = derivePropertyRiskProfile({}, FIXED_NOW);
      expect(missingProfile.isGasValid).toBe(false);
      expect(missingProfile.isEicrValid).toBe(false);
      expect(missingProfile.estInsuranceDiscount).toContain("Complete CP12 & EICR");

      const expiredProfile = derivePropertyRiskProfile(
        {
          gasSafetyExpiry: "2025-01-01",
          eicrExpiry: "2025-06-01",
          roofCondition: "Poor",
          epcRating: "F",
        },
        FIXED_NOW
      );
      expect(expiredProfile.isGasValid).toBe(false);
      expect(expiredProfile.isEicrValid).toBe(false);
      expect(expiredProfile.overallRiskScore).toBeGreaterThanOrEqual(60);
      expect(expiredProfile.riskBand).toBe("Elevated Risk");
    });

    it("computes low risk score and discount eligibility when valid future CP12, EICR, EPC A/B, and Excellent roof are recorded", () => {
      const compliantProfile = derivePropertyRiskProfile(
        {
          gasSafetyExpiry: "2027-08-01",
          eicrExpiry: "2030-05-01",
          roofCondition: "Excellent",
          epcRating: "B",
          boilerInfo: { brand: "Worcester Bosch", age: 3 },
        },
        FIXED_NOW
      );

      expect(compliantProfile.isGasValid).toBe(true);
      expect(compliantProfile.isEicrValid).toBe(true);
      expect(compliantProfile.overallRiskScore).toBeLessThanOrEqual(20);
      expect(compliantProfile.riskBand).toBe("Very Low Risk");
      expect(compliantProfile.estInsuranceDiscount).toContain("10–15%");
    });
  });

  describe("5. Grammar-Safe Predictive Insights (derivePropertyPredictiveInsights)", () => {
    it("never emits blank template placeholders when boiler age or roof condition are omitted", () => {
      const insights = derivePropertyPredictiveInsights(
        {
          name: "10 Downing Mews",
          gasSafetyExpiry: "2025-05-01",
          eicrExpiry: "",
          boilerInfo: {},
          roofCondition: "",
        },
        FIXED_NOW
      );

      const allText = insights.map((i) => `${i.title} ${i.summary}`).join(" ");
      expect(allText).not.toContain("is  years old");
      expect(allText).not.toContain('flagged as ""');
      expect(allText).not.toContain("undefined");

      const cp12 = insights.find((i) => i.idKey === "pred-cp12");
      const eicr = insights.find((i) => i.idKey === "pred-eicr");
      expect(cp12?.badge).toBe("Overdue");
      expect(eicr?.title).toContain("Missing EICR");
    });
  });

  describe("6. Static Regression Guards for Gotham Portal & Standalone Claim Route", () => {
    it("GothamHousingPortal has zero fake estates, zero /corporate redirects, and zero setTimeout dispatch simulation", () => {
      const gothamPath = path.resolve(process.cwd(), "src/components/anytrader/GothamHousingPortal.tsx");
      const content = fs.readFileSync(gothamPath, "utf8");
      expect(content).not.toContain("Clarion Riverside Estate");
      expect(content).not.toContain("Peabody Green Towers");
      expect(content).not.toContain("148,250");
      expect(content).not.toContain("/corporate?gotham_saas");
      expect(content).toContain("/gotham-portal?gotham_saas=success");
      expect(content).toContain("createPropertyViaCommand");
      expect(content).toContain("createJobViaCommand");
    });

    it("App.tsx mounts /claim-passport route for standalone buyer transfer claims", () => {
      const appPath = path.resolve(process.cwd(), "src/App.tsx");
      const content = fs.readFileSync(appPath, "utf8");
      expect(content).toContain('path="/claim-passport"');
      expect(content).toContain("ClaimPassportPage");
    });
  });
});
