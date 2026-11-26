import { describe, it, expect } from "vitest";
import {
  isOpenJobStatus,
  normalizeJobUrgency,
  formatJobUrgencyLabel,
  normalizeQuoteScope,
  isLabourOnlyScope,
  isCompletePackageScope,
  formatQuoteScopeLabel,
  isProfileAcceptingNewWork,
  resolveFlexiPayMode,
} from "../../src/lib/marketplaceContracts.ts";
import {
  isActiveProvisionalTrader,
  evaluateLeadRecipient,
} from "../../src/server/leadDistribution.ts";
import { evaluateInstantMatchCandidate } from "../../src/server/instantMatchEligibility.ts";
import { calculateTraderMatchScore } from "../../src/services/matchingEngine.ts";
import { executeBootstrapProfileCommand } from "../../src/server/accountBootstrap.ts";
import { publishPlatformPricingConfigAtomic } from "../../src/server/pricingConfigPublish.ts";
import { executeJobLifecycleCommand } from "../../src/server/jobLifecycleCommands.ts";
import { BadRequestError, ForbiddenError } from "../../src/server/httpErrors.ts";

function createMockFirestore(initialStore: Record<string, any> = {}) {
  const store: Record<string, any> = { ...initialStore };
  return {
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
      const tx = {
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
          if (!current) throw new Error(`Missing doc ${ref.path}`);
          store[ref.path] = { ...current, ...JSON.parse(JSON.stringify(data)) };
        },
      };
      return fn(tx);
    },
  };
}

describe("AnyTrader End-to-End Marketplace Remediation", () => {
  describe("Core Marketplace Contracts", () => {
    it("normalizes open job statuses, urgency values, and quote scopes consistently", () => {
      expect(isOpenJobStatus("open")).toBe(true);
      expect(isOpenJobStatus("quoted")).toBe(true);
      expect(isOpenJobStatus("posted")).toBe(true);
      expect(isOpenJobStatus("accepted")).toBe(false);
      expect(isOpenJobStatus("completed")).toBe(false);

      expect(normalizeJobUrgency("Urgent")).toBe("urgent");
      expect(normalizeJobUrgency("Within 48 Hours")).toBe("urgent");
      expect(normalizeJobUrgency("Emergency (24h)")).toBe("emergency");
      expect(formatJobUrgencyLabel("urgent")).toBe("Urgent");

      expect(normalizeQuoteScope("Labour Only")).toBe("labor_only");
      expect(isLabourOnlyScope("Labour Only")).toBe(true);
      expect(normalizeQuoteScope("all_inclusive")).toBe("full_project");
      expect(isCompletePackageScope("Labour & Materials (Complete Package)")).toBe(true);
      expect(formatQuoteScopeLabel("labour_only")).toBe("Labour Only");
    });

    it("checks both acceptingNewWork and isAcceptingRequests flags for trader availability", () => {
      expect(isProfileAcceptingNewWork({ acceptingNewWork: true, isAcceptingRequests: true })).toBe(true);
      expect(isProfileAcceptingNewWork({ acceptingNewWork: false, isAcceptingRequests: true })).toBe(false);
      expect(isProfileAcceptingNewWork({ acceptingNewWork: true, isAcceptingRequests: false })).toBe(false);
      expect(isProfileAcceptingNewWork({})).toBe(true);
    });

    it("resolves 3-state FlexiPay mode defaulting to coming_soon", () => {
      expect(resolveFlexiPayMode(null)).toBe("coming_soon");
      expect(resolveFlexiPayMode({})).toBe("coming_soon");
      expect(resolveFlexiPayMode({ flexiPayMode: "off" })).toBe("off");
      expect(resolveFlexiPayMode({ flexiPayMode: "live" })).toBe("live");
      expect(resolveFlexiPayMode({ flexiPayMode: "coming_soon" })).toBe("coming_soon");
    });
  });

  describe("Lead Distribution & Instant Match Eligibility", () => {
    const baseJob = {
      jobId: "job_remediation_1",
      ownerId: "homeowner_1",
      callerUid: "homeowner_1",
      category: "Painting & Decorating",
      postcode: "M1 1AE",
      location: "Manchester",
    };

    it("allows active provisional traders within 14-day grace & under 5 quotes, and blocks expired/capped provisional traders", () => {
      const futureDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const pastDeadline = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const activeProvisional = {
        uid: "trader_prov_1",
        role: "tradesperson",
        verificationStatus: "provisional",
        documentGraceDeadlineAt: futureDeadline,
        provisionalQuotesUsed: 2,
        provisionalMaxQuotes: 5,
        trades: ["Painting & Decorating"],
        postcode: "M1 2AB",
        acceptingNewWork: true,
        isAcceptingRequests: true,
      };
      expect(isActiveProvisionalTrader(activeProvisional)).toBe(true);
      expect(evaluateLeadRecipient("trader_prov_1", activeProvisional, baseJob).eligible).toBe(true);

      const cappedProvisional = { ...activeProvisional, provisionalQuotesUsed: 5 };
      expect(isActiveProvisionalTrader(cappedProvisional)).toBe(false);
      expect(evaluateLeadRecipient("trader_prov_1", cappedProvisional, baseJob).eligible).toBe(false);

      const expiredProvisional = { ...activeProvisional, documentGraceDeadlineAt: pastDeadline };
      expect(isActiveProvisionalTrader(expiredProvisional)).toBe(false);
      expect(evaluateLeadRecipient("trader_prov_1", expiredProvisional, baseJob).eligible).toBe(false);
    });

    it("excludes property-only businesses and unavailable traders while allowing trade businesses", () => {
      const tradeBusiness = {
        uid: "biz_trade_1",
        role: "business",
        businessLayer: "field_services",
        isVerified: true,
        trades: ["Painting & Decorating"],
        postcode: "M1 3CD",
        acceptingNewWork: true,
        isAcceptingRequests: true,
      };
      expect(evaluateLeadRecipient("biz_trade_1", tradeBusiness, baseJob).eligible).toBe(true);

      const propertyBusiness = {
        ...tradeBusiness,
        uid: "biz_prop_1",
        businessLayer: "properties",
      };
      expect(evaluateLeadRecipient("biz_prop_1", propertyBusiness, baseJob).eligible).toBe(false);

      const pausedTrader = {
        ...tradeBusiness,
        uid: "trader_paused_1",
        isAcceptingRequests: false,
      };
      expect(evaluateLeadRecipient("trader_paused_1", pausedTrader, baseJob).eligible).toBe(false);
    });

    it("scores Instant Match normalized tiers and strictly requires verified video status", () => {
      const candidateBase = {
        uid: "trader_im_1",
        role: "tradesperson",
        verificationStatus: "verified",
        isVerified: true,
        isAvailableForInstantMatch: true,
        acceptingNewWork: true,
        isAcceptingRequests: true,
        trades: ["Plumbing"],
        postcode: "M1 1AE",
        tier: "pro",
        rating: 4.9,
        reviewCount: 15,
      };
      const imJob = {
        category: "Plumbing",
        postcode: "M1 1AE",
        location: "Manchester",
        urgency: "emergency",
        triedTraderIds: [],
      };

      const pendingVideo = evaluateInstantMatchCandidate(
        "trader_im_1",
        { ...candidateBase, videoVerificationStatus: "pending" },
        candidateBase,
        {},
        imJob
      );
      const verifiedVideo = evaluateInstantMatchCandidate(
        "trader_im_1",
        { ...candidateBase, videoVerificationStatus: "verified" },
        candidateBase,
        {},
        imJob
      );
      expect(pendingVideo.eligible).toBe(true);
      expect(verifiedVideo.eligible).toBe(true);
      expect(verifiedVideo.score - pendingVideo.score).toBe(25);

      const pausedCandidate = evaluateInstantMatchCandidate(
        "trader_im_1",
        { ...candidateBase, isAcceptingRequests: false },
        { ...candidateBase, isAcceptingRequests: false },
        {},
        imJob
      );
      expect(pausedCandidate.eligible).toBe(false);
    });
  });

  describe("Matching Engine Accuracy", () => {
    it("does not award inflated 4.8 rating points to 0-review traders or unverified video submissions", () => {
      const zeroReviewTrader = {
        uid: "t_new",
        trades: ["Plumbing"],
        postcode: "M1 1AE",
        rating: 0,
        reviewCount: 0,
        videoVerificationStatus: "pending",
      };
      const reviewedVerifiedTrader = {
        uid: "t_vet",
        trades: ["Plumbing"],
        postcode: "M1 1AE",
        rating: 4.9,
        reviewCount: 20,
        videoVerificationStatus: "verified",
      };
      const job = {
        title: "Fix leaking tap",
        category: "Plumbing",
        description: "Kitchen mixer tap dripping",
        postcode: "M1 1AE",
      };

      const newScore = calculateTraderMatchScore(zeroReviewTrader, job);
      const vetScore = calculateTraderMatchScore(reviewedVerifiedTrader, job);
      expect(vetScore.compositeScore).toBeGreaterThan(newScore.compositeScore);
      expect(newScore.keyHighlights.some((h) => h.toLowerCase().includes("video"))).toBe(false);
      expect(vetScore.keyHighlights.some((h) => h.toLowerCase().includes("video"))).toBe(true);
    });
  });

  describe("Unified 14-Day / 5-Quote Provisional Onboarding (accountBootstrap)", () => {
    it("grants 14-day / 5-quote provisional status and full public_profiles sync for non-regulated direct trader signups", async () => {
      const mockDb = createMockFirestore();
      const res = await executeBootstrapProfileCommand(
        mockDb,
        { uid: "direct_painter_1", email: "painter@example.com" },
        {
          role: "tradesperson",
          name: "Sam Decorator",
          phone: "07700900111",
          postcode: "M1 1AE",
          city: "Manchester",
          trades: ["Painting & Decorating"],
          subcategories: ["Interior Painting"],
          acceptedComplianceDeclaration: true,
        },
        "127.0.0.1"
      );

      expect(res.success).toBe(true);
      const userDoc = mockDb._store["users/direct_painter_1"];
      const publicDoc = mockDb._store["public_profiles/direct_painter_1"];

      expect(userDoc.verificationStatus).toBe("provisional");
      expect(userDoc.documentGracePeriodDays).toBe(14);
      expect(userDoc.provisionalMaxQuotes).toBe(5);
      expect(userDoc.provisionalQuotesUsed).toBe(0);
      expect(userDoc.documentGraceDeadlineAt).toBeTruthy();
      expect(userDoc.traderComplianceDeclaration?.accepted).toBe(true);

      expect(publicDoc.verificationStatus).toBe("provisional");
      expect(publicDoc.postcodeArea).toBe("M1");
      expect(publicDoc.postcode).toBe("M1");
      expect(publicDoc.serviceRadius).toBe(20);
      expect(publicDoc.acceptingNewWork).toBe(true);
      expect(publicDoc.isAcceptingRequests).toBe(true);
    });

    it("denies second provisional window when phone number fingerprint already belongs to another trader", async () => {
      const mockDb = createMockFirestore();
      await executeBootstrapProfileCommand(
        mockDb,
        { uid: "trader_first", email: "first@example.com" },
        {
          role: "tradesperson",
          name: "First Account",
          phone: "07700900222",
          postcode: "B1 1AA",
          trades: ["Painting & Decorating"],
          acceptedComplianceDeclaration: true,
        }
      );

      await executeBootstrapProfileCommand(
        mockDb,
        { uid: "trader_second", email: "second@example.com" },
        {
          role: "tradesperson",
          name: "Second Account",
          phone: "+44 7700 900 222",
          postcode: "B1 1AA",
          trades: ["Painting & Decorating"],
          acceptedComplianceDeclaration: true,
        }
      );

      const secondUser = mockDb._store["users/trader_second"];
      expect(secondUser.duplicatePhoneFingerprintDetected).toBe(true);
      expect(secondUser.requiresAdminVerification).toBe(true);
      expect(secondUser.verificationStatus).toBe("unverified");
      expect(secondUser.documentGraceDeadlineAt).toBeNull();
    });
  });

  describe("Admin 3-State FlexiPay Configuration Publisher", () => {
    it("persists off / coming_soon / live modes and rejects invalid values", async () => {
      const mockDb = createMockFirestore();

      const resDefault = await publishPlatformPricingConfigAtomic({
        db: mockDb,
        adminUid: "admin_1",
        tempConfig: { feeTiers: [] },
      });
      expect(resDefault.flexiPayMode).toBe("coming_soon");
      expect(mockDb._store["platform_config/global"].flexiPayMode).toBe("coming_soon");

      const resOff = await publishPlatformPricingConfigAtomic({
        db: mockDb,
        adminUid: "admin_1",
        tempConfig: { feeTiers: [], flexiPayMode: "off" },
      });
      expect(resOff.flexiPayMode).toBe("off");
      expect(mockDb._store["platform_config/global"].flexiPayMode).toBe("off");

      const resLive = await publishPlatformPricingConfigAtomic({
        db: mockDb,
        adminUid: "admin_1",
        tempConfig: { feeTiers: [], flexiPayMode: "live" },
      });
      expect(resLive.flexiPayMode).toBe("live");

      await expect(
        publishPlatformPricingConfigAtomic({
          db: mockDb,
          adminUid: "admin_1",
          tempConfig: { feeTiers: [], flexiPayMode: "invalid_mode" },
        })
      ).rejects.toThrow(BadRequestError);
    });
  });

  describe("Pre-Live Provisional Document Upload & Job Start Continuity", () => {
    it("keeps non-regulated provisional/pending traders eligible for leads once documents are uploaded, while blocking regulated/flagged accounts", () => {
      const job = {
        jobId: "job_doc_review_1",
        ownerId: "homeowner_1",
        callerUid: "homeowner_1",
        category: "Painting & Decorating",
        postcode: "M1 1AE",
      };

      const uploadedPendingTrader = {
        uid: "trader_uploaded_1",
        role: "tradesperson",
        verificationStatus: "pending",
        isVerified: false,
        trades: ["Painting & Decorating"],
        postcode: "M1 2AB",
        acceptingNewWork: true,
        isAcceptingRequests: true,
        verificationDocs: [
          { type: "Photo ID", status: "pending", fileUrl: "https://storage.googleapis.com/anytrader/id.pdf" },
        ],
      };

      expect(isActiveProvisionalTrader(uploadedPendingTrader)).toBe(true);
      expect(evaluateLeadRecipient("trader_uploaded_1", uploadedPendingTrader, job).eligible).toBe(true);

      const regulatedPendingTrader = {
        ...uploadedPendingTrader,
        requiresAdminVerification: true,
      };
      expect(isActiveProvisionalTrader(regulatedPendingTrader)).toBe(false);
      expect(evaluateLeadRecipient("trader_uploaded_1", regulatedPendingTrader, job).eligible).toBe(false);
    });

    it("allows an accepted non-regulated provisional trader to start a job, while blocking provisional start on regulated jobs", async () => {
      const provisionalIdentity: any = {
        uid: "trader_prov_start",
        email: "prov@example.com",
        primaryRole: "tradesperson",
        capabilities: new Set(["tradesperson"]),
        isAdmin: false,
      };

      const mockDb = createMockFirestore({
        "users/trader_prov_start": {
          uid: "trader_prov_start",
          role: "tradesperson",
          verificationStatus: "provisional",
          isVerified: false,
          verified: false,
          verifiedTrader: false,
          trades: ["Painting & Decorating", "Gas Engineering"],
        },
        "jobs/job_nonreg_1": {
          id: "job_nonreg_1",
          homeownerId: "homeowner_1",
          acceptedTradespersonId: "trader_prov_start",
          status: "accepted",
          category: "Painting & Decorating",
          title: "Hallway repaint",
        },
        "jobs/job_reg_1": {
          id: "job_reg_1",
          homeownerId: "homeowner_1",
          acceptedTradespersonId: "trader_prov_start",
          status: "accepted",
          category: "Gas Engineering",
          title: "Boiler service",
        },
      });

      const started = await executeJobLifecycleCommand({
        db: mockDb,
        identity: provisionalIdentity,
        command: { type: "StartJob", payload: { jobId: "job_nonreg_1" } },
        idempotencyKey: "start_prov_nonreg_001",
      });
      expect(started.status).toBe("in_progress");
      expect(mockDb._store["jobs/job_nonreg_1"].status).toBe("in_progress");

      await expect(
        executeJobLifecycleCommand({
          db: mockDb,
          identity: provisionalIdentity,
          command: { type: "StartJob", payload: { jobId: "job_reg_1" } },
          idempotencyKey: "start_prov_reg_001",
        })
      ).rejects.toThrow(ForbiddenError);
    });
  });
});
