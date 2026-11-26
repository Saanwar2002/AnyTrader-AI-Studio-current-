import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS,
  DEFAULT_PROVISIONAL_MAX_QUOTES,
  TRADER_COMPLIANCE_DECLARATION_SUMMARY,
  getRequiredCertificationsForTrades,
  isCategoryRegulated,
  evaluateTraderDocumentCompliance,
} from "../../src/lib/traderCompliance";
import {
  executeUpgradeHomeownerToTraderCommand,
  normalizeUkPhoneForFingerprint,
  computePhoneFingerprintHash,
} from "../../src/server/accountUpgrade";
import { executeQuoteCommand } from "../../src/server/quoteCommands";
import { publishPlatformPricingConfigAtomic } from "../../src/server/pricingConfigPublish";

function createInMemoryFirestore(initialDocs: Record<string, Record<string, any>>) {
  const store = new Map<string, Record<string, any>>();
  for (const [docPath, data] of Object.entries(initialDocs)) {
    store.set(docPath, structuredClone(data));
  }

  function makeDocRef(docPath: string): any {
    return {
      path: docPath,
      id: docPath.split("/").pop()!,
      collection(subName: string) {
        return makeCollectionRef(`${docPath}/${subName}`);
      },
      async get() {
        const val = store.get(docPath);
        return {
          id: docPath.split("/").pop()!,
          exists: val !== undefined,
          data: () => (val !== undefined ? structuredClone(val) : undefined),
        };
      },
      async set(data: Record<string, any>, opts?: { merge?: boolean }) {
        if (opts?.merge && store.has(docPath)) {
          store.set(docPath, { ...store.get(docPath)!, ...structuredClone(data) });
        } else {
          store.set(docPath, structuredClone(data));
        }
      },
      async update(data: Record<string, any>) {
        if (!store.has(docPath)) throw new Error(`Document ${docPath} does not exist`);
        store.set(docPath, { ...store.get(docPath)!, ...structuredClone(data) });
      },
    };
  }

  function makeCollectionRef(colPath: string): any {
    return {
      doc(id?: string) {
        const docId = id || `auto_${Math.random().toString(36).slice(2, 10)}`;
        return makeDocRef(`${colPath}/${docId}`);
      },
      where() {
        return {
          where() {
            return this;
          },
          limit() {
            return this;
          },
          async get() {
            return { empty: true, size: 0, docs: [] };
          },
        };
      },
      async get() {
        const prefix = `${colPath}/`;
        const docs: any[] = [];
        for (const [k, v] of store.entries()) {
          if (k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) {
            docs.push({
              id: k.slice(prefix.length),
              exists: true,
              data: () => structuredClone(v),
            });
          }
        }
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    };
  }

  return {
    store,
    collection(name: string) {
      return makeCollectionRef(name);
    },
    async runTransaction(fn: (tx: any) => Promise<any>) {
      const tx = {
        async get(ref: any) {
          if (typeof ref?.get === "function") return ref.get();
          return { empty: true, size: 0, docs: [] };
        },
        set(ref: any, data: Record<string, any>, opts?: { merge?: boolean }) {
          if (opts?.merge && store.has(ref.path)) {
            store.set(ref.path, { ...store.get(ref.path)!, ...structuredClone(data) });
          } else {
            store.set(ref.path, structuredClone(data));
          }
        },
        update(ref: any, data: Record<string, any>) {
          if (!store.has(ref.path)) throw new Error(`Document ${ref.path} does not exist`);
          store.set(ref.path, { ...store.get(ref.path)!, ...structuredClone(data) });
        },
      };
      return fn(tx);
    },
  };
}

describe("Task 8: Guided Homeowner -> Tradesperson Upgrade & Anti-Abuse Compliance", () => {
  describe("1. Regulated vs Non-Regulated Category Detection & Defaults", () => {
    it("uses 14-day grace period and 5-quote provisional cap as canonical defaults", () => {
      expect(DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS).toBe(14);
      expect(DEFAULT_PROVISIONAL_MAX_QUOTES).toBe(5);
    });

    it("identifies regulated trades requiring mandatory UK certificates", () => {
      const gas = getRequiredCertificationsForTrades(["Gas Engineering"]);
      expect(gas.hasRegulatedCategory).toBe(true);
      expect(gas.regulatedCategories).toContain("Gas Engineering");
      expect(gas.requiredCertifications.length).toBeGreaterThan(0);
      expect(isCategoryRegulated("Gas Engineering")).toBe(true);

      const elec = getRequiredCertificationsForTrades(["Electrical"]);
      expect(elec.hasRegulatedCategory).toBe(true);
      expect(isCategoryRegulated("Electrical")).toBe(true);
    });

    it("identifies non-regulated side-hustle categories with zero mandatory certificates", () => {
      const sideHustle = getRequiredCertificationsForTrades(["Gardening & Landscaping", "Cleaning Services"]);
      expect(sideHustle.hasRegulatedCategory).toBe(false);
      expect(sideHustle.regulatedCategories).toEqual([]);
      expect(sideHustle.requiredCertifications).toEqual([]);
      expect(isCategoryRegulated("Gardening & Landscaping")).toBe(false);
      expect(isCategoryRegulated("Cleaning Services")).toBe(false);
    });
  });

  describe("2. Trader Document Compliance, 14-Day Grace Window & 5-Quote Provisional Cap", () => {
    const day0 = new Date("2026-10-01T10:00:00.000Z");
    const day5 = new Date("2026-10-06T10:00:00.000Z");
    const day14 = new Date("2026-10-15T10:00:00.000Z");
    const day20 = new Date("2026-10-21T10:00:00.000Z");

    it("allows provisional non-regulated trader to quote within 14-day window & 5-quote cap while surfacing reminder", () => {
      const res = evaluateTraderDocumentCompliance(
        {
          role: "tradesperson",
          verificationStatus: "provisional",
          trades: ["Gardening & Landscaping"],
          traderActivatedAt: day0.toISOString(),
          provisionalQuotesUsed: 2,
          verificationDocs: [],
        },
        { now: day5, gracePeriodDays: 14, enforceGracePeriod: true, provisionalMaxQuotes: 5 }
      );

      expect(res.status).toBe("provisional_grace_active");
      expect(res.canQuote).toBe(true);
      expect(res.needsDocumentReminder).toBe(true);
      expect(res.daysActive).toBe(5);
      expect(res.daysRemaining).toBe(9);
      expect(res.provisionalQuotesUsed).toBe(2);
      expect(res.provisionalQuotesRemaining).toBe(3);
      expect(res.isProvisionalQuoteCapReached).toBe(false);
      expect(res.isGraceExpired).toBe(false);
    });

    it("blocks provisional trader once 5-quote provisional cap is reached with 0 docs uploaded", () => {
      const res = evaluateTraderDocumentCompliance(
        {
          role: "tradesperson",
          verificationStatus: "provisional",
          trades: ["Gardening & Landscaping"],
          traderActivatedAt: day0.toISOString(),
          provisionalQuotesUsed: 5,
          verificationDocs: [],
        },
        { now: day5, gracePeriodDays: 14, enforceGracePeriod: true, provisionalMaxQuotes: 5 }
      );

      expect(res.status).toBe("provisional_quote_cap_reached");
      expect(res.canQuote).toBe(false);
      expect(res.isProvisionalQuoteCapReached).toBe(true);
      expect(res.provisionalQuotesRemaining).toBe(0);
      expect(res.needsDocumentReminder).toBe(true);
      expect(res.blockReason).toMatch(/provisional limit of 5 quotes/i);
    });

    it("automatically restricts quoting after 14 days if 0 documents were uploaded", () => {
      const res = evaluateTraderDocumentCompliance(
        {
          role: "tradesperson",
          verificationStatus: "provisional",
          trades: ["Gardening & Landscaping"],
          traderActivatedAt: day0.toISOString(),
          provisionalQuotesUsed: 1,
          verificationDocs: [],
        },
        { now: day14, gracePeriodDays: 14, enforceGracePeriod: true, provisionalMaxQuotes: 5 }
      );

      expect(res.status).toBe("grace_expired_restricted");
      expect(res.canQuote).toBe(false);
      expect(res.isGraceExpired).toBe(true);
      expect(res.needsDocumentReminder).toBe(true);
      expect(res.blockReason).toMatch(/14-day document upload grace period has ended/i);
    });

    it("respects Admin toggle when enforceGracePeriod is turned off", () => {
      const res = evaluateTraderDocumentCompliance(
        {
          role: "tradesperson",
          verificationStatus: "provisional",
          trades: ["Gardening & Landscaping"],
          traderActivatedAt: day0.toISOString(),
          provisionalQuotesUsed: 1,
          verificationDocs: [],
        },
        { now: day20, gracePeriodDays: 14, enforceGracePeriod: false, provisionalMaxQuotes: 5 }
      );

      expect(res.status).toBe("provisional_grace_active");
      expect(res.canQuote).toBe(true);
      expect(res.isGraceExpired).toBe(false);
    });

    it("lifts both 14-day restriction and 5-quote cap immediately once non-regulated trader uploads at least one document", () => {
      const res = evaluateTraderDocumentCompliance(
        {
          role: "tradesperson",
          verificationStatus: "pending",
          trades: ["Gardening & Landscaping"],
          traderActivatedAt: day0.toISOString(),
          provisionalQuotesUsed: 5,
          verificationDocs: [
            {
              type: "Public Liability Insurance",
              fileUrl: "https://firebasestorage.googleapis.com/v0/b/test/o/doc.pdf",
              status: "pending",
            },
          ],
        },
        { now: day20, gracePeriodDays: 14, enforceGracePeriod: true, provisionalMaxQuotes: 5 }
      );

      expect(res.status).toBe("docs_submitted_pending_review");
      expect(res.canQuote).toBe(true);
      expect(res.needsDocumentReminder).toBe(false);
      expect(res.isProvisionalQuoteCapReached).toBe(false);
    });

    it("strictly blocks regulated trade quoting until Admin approval (even within 14 days or with docs uploaded)", () => {
      const res = evaluateTraderDocumentCompliance(
        {
          role: "tradesperson",
          verificationStatus: "pending",
          trades: ["Gas Engineering"],
          traderActivatedAt: day0.toISOString(),
          verificationDocs: [
            {
              type: "Gas Safe Registration (MANDATORY)",
              fileUrl: "https://firebasestorage.googleapis.com/v0/b/test/o/gassafe.pdf",
              status: "pending",
            },
          ],
        },
        { now: day5, gracePeriodDays: 14, enforceGracePeriod: true }
      );

      expect(res.status).toBe("regulated_pending_admin");
      expect(res.canQuote).toBe(false);
      expect(res.needsDocumentReminder).toBe(true);
    });

    it("blocks provisional non-regulated trader from quoting on a regulated job category", () => {
      const res = evaluateTraderDocumentCompliance(
        {
          role: "tradesperson",
          verificationStatus: "provisional",
          trades: ["Handyman & Odd Jobs"],
          traderActivatedAt: day0.toISOString(),
          verificationDocs: [],
        },
        {
          now: day5,
          gracePeriodDays: 14,
          enforceGracePeriod: true,
          targetJobCategory: "Electrical",
        }
      );

      expect(res.status).toBe("regulated_pending_admin");
      expect(res.canQuote).toBe(false);
    });

    it("blocks accounts flagged with duplicatePhoneFingerprintDetected until Admin approval", () => {
      const res = evaluateTraderDocumentCompliance(
        {
          role: "tradesperson",
          verificationStatus: "pending",
          trades: ["Gardening & Landscaping"],
          duplicatePhoneFingerprintDetected: true,
          verificationDocs: [
            {
              type: "Identity Verification (Passport/Driving License)",
              fileUrl: "https://firebasestorage.googleapis.com/v0/b/test/o/id.pdf",
              status: "pending",
            },
          ],
        },
        { now: day5 }
      );

      expect(res.status).toBe("regulated_pending_admin");
      expect(res.canQuote).toBe(false);
      expect(res.duplicatePhoneFingerprintDetected).toBe(true);
      expect(res.blockReason).toMatch(/previously linked to another trader profile/i);
    });

    it("continues to block raw unverified profiles without provisional activation", () => {
      const res = evaluateTraderDocumentCompliance(
        {
          role: "tradesperson",
          verificationStatus: "unverified",
          trades: ["Cleaning Services"],
        },
        { now: day5 }
      );

      expect(res.status).toBe("blocked");
      expect(res.canQuote).toBe(false);
    });
  });

  describe("3. GDPR-Safe Phone Normalization & Anti-Cycling Upgrade Command", () => {
    const validNonRegulatedPayload = {
      displayName: "Alex's Garden Care",
      phone: "07700 900 123",
      postcode: "SW1A 1AA",
      city: "London",
      bio: "Reliable local lawn mowing, hedge trimming, and garden tidy-ups across SW London.",
      trades: ["Gardening & Landscaping"],
      subcategories: [],
      acceptedComplianceDeclaration: true as const,
      verificationDocs: [],
    };

    it("normalizes UK phone variants consistently into identical HMAC-SHA256 fingerprints", () => {
      expect(normalizeUkPhoneForFingerprint("+44 7700 900123")).toBe("07700900123");
      expect(normalizeUkPhoneForFingerprint("0044 (0)7700-900-123")).toBe("07700900123");
      expect(normalizeUkPhoneForFingerprint("07700 900 123")).toBe("07700900123");

      const h1 = computePhoneFingerprintHash("+44 7700 900123", "test-pepper");
      const h2 = computePhoneFingerprintHash("07700 900 123", "test-pepper");
      const h3 = computePhoneFingerprintHash("00447700900123", "test-pepper");
      expect(h1).toHaveLength(64);
      expect(h1).toBe(h2);
      expect(h2).toBe(h3);
    });

    it("upgrades a Homeowner to dual-role Tradesperson (14-day / 5-quote provisional) & stores GDPR-safe phone hash without raw phone", async () => {
      const db = createInMemoryFirestore({
        "users/home_1": {
          uid: "home_1",
          email: "alex@example.com",
          role: "homeowner",
          name: "Alex Smith",
          homeownerTierId: "Premium Landlord",
          isLandlord: true,
          landlordSubscriptionId: "sub_landlord_123",
          stripeCustomerId: "cus_abc123",
        },
        "platform_config/global": {
          documentGracePeriodDays: 14,
          enforceDocumentGracePeriod: true,
          provisionalMaxQuotes: 5,
        },
      });

      const res = await executeUpgradeHomeownerToTraderCommand(
        db,
        { uid: "home_1", email: "alex@example.com" },
        validNonRegulatedPayload
      );

      expect(res.success).toBe(true);
      expect(res.role).toBe("tradesperson");
      expect(res.verificationStatus).toBe("provisional");
      expect(res.requiresAdminVerification).toBe(false);
      expect(res.duplicatePhoneFingerprintDetected).toBe(false);
      expect(res.documentGracePeriodDays).toBe(14);
      expect(res.provisionalMaxQuotes).toBe(5);
      expect(res.documentGraceDeadlineAt).toBeTruthy();

      const updatedUser = db.store.get("users/home_1")!;
      expect(updatedUser.role).toBe("tradesperson");
      expect(updatedUser.accountType).toBe("service_provider");
      expect(updatedUser.capabilities).toEqual(expect.arrayContaining(["homeowner", "tradesperson"]));
      expect(updatedUser.homeownerTierId).toBe("Premium Landlord");
      expect(updatedUser.isLandlord).toBe(true);
      expect(updatedUser.landlordSubscriptionId).toBe("sub_landlord_123");
      expect(updatedUser.stripeCustomerId).toBe("cus_abc123");
      expect(updatedUser.provisionalQuotesUsed).toBe(0);
      expect(updatedUser.traderComplianceDeclaration?.accepted).toBe(true);
      expect(updatedUser.traderComplianceDeclaration?.confirmsInsuranceAndHealthSafety).toBe(true);
      expect(updatedUser.traderComplianceDeclaration?.summary).toBe(TRADER_COMPLIANCE_DECLARATION_SUMMARY);

      const expectedHash = computePhoneFingerprintHash(validNonRegulatedPayload.phone);
      const fpDoc = db.store.get(`trader_phone_fingerprints/${expectedHash}`)!;
      expect(fpDoc).toBeDefined();
      expect(fpDoc.firstUid).toBe("home_1");
      expect(fpDoc.activationCount).toBe(1);
      expect(JSON.stringify(fpDoc)).not.toContain("07700");

      const publicProf = db.store.get("public_profiles/home_1")!;
      expect(publicProf).toBeDefined();
      expect(publicProf.role).toBe("tradesperson");
      expect(publicProf.trades).toEqual(["Gardening & Landscaping"]);
      expect(publicProf.verificationStatus).toBe("provisional");
    });

    it("denies a second provisional grace window and logs an Admin alert when a deleted/new account re-uses the same UK phone number", async () => {
      const priorPhoneHash = computePhoneFingerprintHash("07700900123");
      const db = createInMemoryFirestore({
        // Original user was deleted, but GDPR-safe phone hash remains in server registry
        [`trader_phone_fingerprints/${priorPhoneHash}`]: {
          firstUid: "deleted_user_old",
          lastUid: "deleted_user_old",
          seenUids: ["deleted_user_old"],
          activationCount: 1,
          firstActivatedAt: "2026-10-01T10:00:00.000Z",
          lastActivatedAt: "2026-10-01T10:00:00.000Z",
          flaggedDuplicateAttempt: false,
        },
        "users/home_recreated": {
          uid: "home_recreated",
          email: "fresh_throwaway@example.com",
          role: "homeowner",
          name: "Fresh Alias",
        },
      });

      const res = await executeUpgradeHomeownerToTraderCommand(
        db,
        { uid: "home_recreated", email: "fresh_throwaway@example.com" },
        {
          ...validNonRegulatedPayload,
          phone: "+44 7700 900 123", // Different format, same number
        }
      );

      expect(res.duplicatePhoneFingerprintDetected).toBe(true);
      expect(res.requiresAdminVerification).toBe(true);
      expect(res.verificationStatus).toBe("unverified");
      expect(res.documentGraceDeadlineAt).toBeNull();

      const auditEntries = Array.from(db.store.entries()).filter(([k]) =>
        k.startsWith("admin_audit_logs/dup_phone_upgrade_home_recreated_")
      );
      expect(auditEntries.length).toBe(1);
      expect(auditEntries[0][1].action).toBe("duplicate_phone_trader_upgrade_flagged");
    });

    it("requires Admin approval and sets verificationStatus=pending when upgrading into a regulated category with uploaded docs", async () => {
      const db = createInMemoryFirestore({
        "users/home_2": {
          uid: "home_2",
          email: "sam@example.com",
          role: "homeowner",
          name: "Sam Gas",
        },
      });

      const res = await executeUpgradeHomeownerToTraderCommand(
        db,
        { uid: "home_2", email: "sam@example.com" },
        {
          ...validNonRegulatedPayload,
          phone: "07700 900 555",
          trades: ["Gas Engineering"],
          verificationDocs: [
            {
              type: "Gas Safe Registration (MANDATORY)",
              fileUrl: "https://firebasestorage.googleapis.com/v0/b/anytrader/o/verifications%2Fhome_2%2Fgas.pdf?alt=media",
              storagePath: "verifications/home_2/upgrade/gas.pdf",
              fileName: "gas.pdf",
              contentType: "application/pdf",
            },
          ],
        }
      );

      expect(res.requiresAdminVerification).toBe(true);
      expect(res.verificationStatus).toBe("pending");
      expect(res.regulatedCategories).toContain("Gas Engineering");
      expect(res.uploadedDocsCount).toBe(1);
    });

    it("rejects upgrade if compliance & Terms tick box is not checked", async () => {
      const db = createInMemoryFirestore({
        "users/home_3": { uid: "home_3", role: "homeowner" },
      });

      await expect(
        executeUpgradeHomeownerToTraderCommand(
          db,
          { uid: "home_3" },
          { ...validNonRegulatedPayload, acceptedComplianceDeclaration: false }
        )
      ).rejects.toThrow(/Terms & Conditions|paperwork/i);
    });

    it("strictly blocks Property-only Businesses, Fleet Drivers, Admins, and existing Tradespeople from this homeowner upgrade path", async () => {
      const db = createInMemoryFirestore({
        "users/prop_biz": { uid: "prop_biz", role: "business", businessLayer: "properties" },
        "users/driver_1": { uid: "driver_1", role: "fleet_driver" },
        "users/admin_1": { uid: "admin_1", role: "admin" },
        "users/trader_1": { uid: "trader_1", role: "tradesperson" },
      });

      await expect(
        executeUpgradeHomeownerToTraderCommand(db, { uid: "prop_biz" }, validNonRegulatedPayload)
      ).rejects.toThrow(/Homeowner accounts only/i);

      await expect(
        executeUpgradeHomeownerToTraderCommand(db, { uid: "driver_1" }, validNonRegulatedPayload)
      ).rejects.toThrow(/Homeowner accounts only/i);

      await expect(
        executeUpgradeHomeownerToTraderCommand(db, { uid: "admin_1" }, validNonRegulatedPayload)
      ).rejects.toThrow(/Homeowner accounts only/i);

      await expect(
        executeUpgradeHomeownerToTraderCommand(db, { uid: "trader_1" }, validNonRegulatedPayload)
      ).rejects.toThrow(/already has an active Tradesperson profile/i);
    });

    it("rejects foreign user storagePath or non-Firebase-Storage URLs in uploaded docs", async () => {
      const db = createInMemoryFirestore({
        "users/home_4": { uid: "home_4", role: "homeowner" },
      });

      await expect(
        executeUpgradeHomeownerToTraderCommand(
          db,
          { uid: "home_4" },
          {
            ...validNonRegulatedPayload,
            verificationDocs: [
              {
                type: "Public Liability Insurance",
                fileUrl: "https://evil.example.com/fake.pdf",
              },
            ],
          }
        )
      ).rejects.toThrow(/Firebase Storage/i);

      await expect(
        executeUpgradeHomeownerToTraderCommand(
          db,
          { uid: "home_4" },
          {
            ...validNonRegulatedPayload,
            verificationDocs: [
              {
                type: "Public Liability Insurance",
                fileUrl: "https://firebasestorage.googleapis.com/v0/b/anytrader/o/verifications%2Fother%2Fdoc.pdf",
                storagePath: "verifications/other_uid/upgrade/doc.pdf",
              },
            ],
          }
        )
      ).rejects.toThrow(/must belong to the authenticated user/i);
    });
  });

  describe("4. Server Quote Command Gate (14-Day Grace, 5-Quote Atomic Cap & Regulated Blocking)", () => {
    it("increments provisionalQuotesUsed atomically, blocks quote #6 without docs, blocks past 14 days, and blocks regulated jobs", async () => {
      const now = Date.now();
      const fiveDaysAgo = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
      const sixteenDaysAgo = new Date(now - 16 * 24 * 60 * 60 * 1000).toISOString();

      const db = createInMemoryFirestore({
        "platform_config/global": {
          documentGracePeriodDays: 14,
          enforceDocumentGracePeriod: true,
          provisionalMaxQuotes: 5,
        },
        "users/trader_fresh": {
          uid: "trader_fresh",
          role: "tradesperson",
          name: "Fresh Gardener",
          verificationStatus: "provisional",
          isVerified: false,
          trades: ["Gardening & Landscaping"],
          traderActivatedAt: fiveDaysAgo,
          provisionalQuotesUsed: 4,
          verificationDocs: [],
        },
        "users/trader_expired": {
          uid: "trader_expired",
          role: "tradesperson",
          name: "Expired Gardener",
          verificationStatus: "provisional",
          isVerified: false,
          trades: ["Gardening & Landscaping"],
          traderActivatedAt: sixteenDaysAgo,
          provisionalQuotesUsed: 1,
          verificationDocs: [],
        },
        "jobs/job_garden_1": {
          id: "job_garden_1",
          title: "Trim front hedge",
          category: "Gardening & Landscaping",
          homeownerId: "client_1",
          status: "open",
        },
        "jobs/job_garden_2": {
          id: "job_garden_2",
          title: "Mow back lawn",
          category: "Gardening & Landscaping",
          homeownerId: "client_2",
          status: "open",
        },
        "jobs/job_gas": {
          id: "job_gas",
          title: "Boiler service",
          category: "Gas Engineering",
          homeownerId: "client_1",
          status: "open",
        },
      });

      const identityFresh: any = {
        uid: "trader_fresh",
        email: "fresh@example.com",
        role: "tradesperson",
        capabilities: ["homeowner", "tradesperson"],
        isAdmin: false,
      };
      const identityExpired: any = {
        uid: "trader_expired",
        email: "expired@example.com",
        role: "tradesperson",
        capabilities: ["homeowner", "tradesperson"],
        isAdmin: false,
      };

      // Quote #5 succeeds and atomically increments provisionalQuotesUsed from 4 -> 5
      const quoteRes = await executeQuoteCommand({
        db: db as any,
        identity: identityFresh,
        idempotencyKey: "task8_quote_provisional_5th_001",
        command: {
          type: "CreateQuote",
          payload: {
            jobId: "job_garden_1",
            amount: 120,
            coverNote: "Happy to trim and tidy your hedge this weekend.",
          },
        },
      });
      expect(quoteRes.quoteId).toBeTruthy();
      expect(db.store.get("users/trader_fresh")!.provisionalQuotesUsed).toBe(5);

      // Quote #6 is immediately blocked by the 5-quote provisional cap
      await expect(
        executeQuoteCommand({
          db: db as any,
          identity: identityFresh,
          idempotencyKey: "task8_quote_provisional_6th_blocked",
          command: {
            type: "CreateQuote",
            payload: {
              jobId: "job_garden_2",
              amount: 95,
              coverNote: "Happy to mow your back lawn too.",
            },
          },
        })
      ).rejects.toThrow(/provisional limit of 5 quotes/i);

      // Regulated job category is blocked even before cap
      db.store.get("users/trader_fresh")!.provisionalQuotesUsed = 0;
      await expect(
        executeQuoteCommand({
          db: db as any,
          identity: identityFresh,
          idempotencyKey: "task8_quote_regulated_block_002",
          command: {
            type: "CreateQuote",
            payload: {
              jobId: "job_gas",
              amount: 150,
              coverNote: "Can inspect boiler.",
            },
          },
        })
      ).rejects.toThrow(/Admin document verification is required/i);

      // Blocked after 14-day grace window with 0 docs uploaded
      await expect(
        executeQuoteCommand({
          db: db as any,
          identity: identityExpired,
          idempotencyKey: "task8_quote_expired_block_003",
          command: {
            type: "CreateQuote",
            payload: {
              jobId: "job_garden_1",
              amount: 110,
              coverNote: "Can trim hedge.",
            },
          },
        })
      ).rejects.toThrow(/14-day document upload grace period has ended/i);
    });
  });

  describe("5. Admin Atomic Config Publish, Security Rules & UI Wiring Regression Checks", () => {
    it("persists documentGracePeriodDays, provisionalMaxQuotes, and enforceDocumentGracePeriod atomically", async () => {
      const db = createInMemoryFirestore({
        "platform_config/global": { configVersion: 3 },
      });

      await publishPlatformPricingConfigAtomic({
        db: db as any,
        adminUid: "admin_1",
        adminEmail: "admin@anytrader.co.uk",
        tempConfig: {
          documentGracePeriodDays: 14,
          enforceDocumentGracePeriod: true,
          provisionalMaxQuotes: 5,
        },
        feeTiers: [],
        businessTiers: [],
        paidAddons: {},
        commissionCapGbp: 250,
      });

      const globalCfg = db.store.get("platform_config/global")!;
      expect(globalCfg.documentGracePeriodDays).toBe(14);
      expect(globalCfg.enforceDocumentGracePeriod).toBe(true);
      expect(globalCfg.provisionalMaxQuotes).toBe(5);
    });

    it("verifies server route, Firestore phone-fingerprint lock, homeowner-only upgrade CTAs, TrustPulse pending badge, and Admin panel controls", () => {
      const root = path.resolve(__dirname, "../..");
      const serverSrc = fs.readFileSync(path.join(root, "server.ts"), "utf8");
      const rulesSrc = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");
      const dashboardSrc = fs.readFileSync(path.join(root, "src/components/Dashboard.tsx"), "utf8");
      const profileSrc = fs.readFileSync(path.join(root, "src/components/Profile.tsx"), "utf8");
      const tradesDashSrc = fs.readFileSync(path.join(root, "src/components/TradesDashboard.tsx"), "utf8");
      const trustPulseSrc = fs.readFileSync(path.join(root, "src/components/TrustPulse.tsx"), "utf8");
      const adminSrc = fs.readFileSync(path.join(root, "src/components/AnyTraderAdmin.tsx"), "utf8");

      expect(serverSrc).toContain('"/api/account/upgrade-to-trader"');
      expect(serverSrc).toContain("executeUpgradeHomeownerToTraderCommand");

      // Server-only Firestore rule on GDPR phone fingerprint registry
      expect(rulesSrc).toContain("match /trader_phone_fingerprints/{fingerprintHash}");
      expect(rulesSrc).toContain("allow read, write: if false;");

      // Homeowner-only gating (Property Businesses intentionally excluded)
      expect(dashboardSrc).toContain("BecomeTradespersonModal");
      expect(dashboardSrc).toContain('profile?.role === "homeowner" || profile?.role === "customer"');

      expect(profileSrc).toContain("BecomeTradespersonModal");
      expect(profileSrc).toContain("DocumentComplianceReminderBanner");
      expect(profileSrc).toContain("!isPropertyBusiness");
      expect(profileSrc).toContain('if (id === "verification")');

      expect(tradesDashSrc).toContain("DocumentComplianceReminderBanner");
      expect(tradesDashSrc).toContain('"Provisional Access"');

      // Honest homeowner-facing Verification Pending badge on quotes
      expect(trustPulseSrc).toContain("New Trader · Verification Pending");
      expect(trustPulseSrc).toContain("Verification In Review");

      // Admin Control Panel grace-period & provisional quote cap controls
      expect(adminSrc).toContain("enforceDocumentGracePeriod");
      expect(adminSrc).toContain("documentGracePeriodDays");
      expect(adminSrc).toContain("provisionalMaxQuotes");
      expect(adminSrc).toContain("DEFAULT_PROVISIONAL_MAX_QUOTES");
    });
  });
});
