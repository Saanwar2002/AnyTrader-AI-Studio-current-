import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  BANNER_AD_DAILY_RATE_GBP,
  calculateBannerAdCostGbp,
  calculateBannerAdCostPence,
} from "../../src/lib/adPricing";
import { resolveAuthoritativeLineItem } from "../../src/server/pricingCatalog";
import {
  createBannerAdCommand,
  moderateAdCommand,
  toggleAdActiveCommand,
  topUpAdCampaignCommand,
  trackSponsoredAdEventCommand,
} from "../../src/server/adEngine";
import { executeProviderPayoutCommand } from "../../src/server/providerPayoutCommand";

function clone<T>(val: T): T {
  return JSON.parse(JSON.stringify(val));
}

function createMockFirestore(initialData: Record<string, Record<string, any>> = {}) {
  const store = new Map<string, Map<string, any>>();
  for (const [colName, docs] of Object.entries(initialData)) {
    const colMap = new Map<string, any>();
    for (const [docId, data] of Object.entries(docs)) {
      colMap.set(docId, clone(data));
    }
    store.set(colName, colMap);
  }

  let autoIdCounter = 0;

  const getColMap = (colName: string) => {
    let m = store.get(colName);
    if (!m) {
      m = new Map<string, any>();
      store.set(colName, m);
    }
    return m;
  };

  const makeDocRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    async get() {
      const data = getColMap(colName).get(docId);
      return {
        exists: data !== undefined,
        id: docId,
        data: () => (data !== undefined ? clone(data) : undefined),
      };
    },
    async set(payload: any, opts?: { merge?: boolean }) {
      const existing = getColMap(colName).get(docId) || {};
      const next = opts?.merge ? { ...existing, ...clone(payload) } : clone(payload);
      getColMap(colName).set(docId, next);
    },
    async update(payload: any) {
      const existing = getColMap(colName).get(docId);
      if (!existing) throw new Error(`Document ${colName}/${docId} does not exist`);
      getColMap(colName).set(docId, { ...existing, ...clone(payload) });
    },
  });

  const db: any = {
    store,
    collection(colName: string) {
      return {
        doc(docId?: string) {
          const id = docId || `auto_${++autoIdCounter}`;
          return makeDocRef(colName, id);
        },
      };
    },
    async runTransaction(fn: (tx: any) => Promise<any>) {
      const tx = {
        async get(ref: any) {
          return ref.get();
        },
        set(ref: any, payload: any, opts?: { merge?: boolean }) {
          const [colName, docId] = ref.path.split("/");
          const existing = getColMap(colName).get(docId) || {};
          const next = opts?.merge ? { ...existing, ...clone(payload) } : clone(payload);
          getColMap(colName).set(docId, next);
        },
        update(ref: any, payload: any) {
          const [colName, docId] = ref.path.split("/");
          const existing = getColMap(colName).get(docId);
          if (!existing) throw new Error(`Document ${colName}/${docId} does not exist`);
          getColMap(colName).set(docId, { ...existing, ...clone(payload) });
        },
        delete(ref: any) {
          const [colName, docId] = ref.path.split("/");
          getColMap(colName).delete(docId);
        },
      };
      return fn(tx);
    },
  };

  return db;
}

describe("Batch 7 — Banner Ads, Sponsored CPC & Provider Payout Idempotency", () => {
  describe("AT-ADS-04: Canonical £2.00/day Banner Ad Pricing Alignment", () => {
    it("uses £2.00/day across shared pricing helper, UI studio, server command, and checkout catalog", async () => {
      expect(BANNER_AD_DAILY_RATE_GBP).toBe(2.0);
      expect(calculateBannerAdCostGbp(7)).toBe(14.0);
      expect(calculateBannerAdCostPence(7)).toBe(1400);

      const bannerUiCode = fs.readFileSync(
        path.resolve(__dirname, "../../src/components/TradesBannerAdStudio.tsx"),
        "utf-8"
      );
      expect(bannerUiCode).toContain("BANNER_AD_DAILY_RATE_GBP");

      const serverCode = fs.readFileSync(path.resolve(__dirname, "../../server.ts"), "utf-8");
      expect(serverCode).not.toContain("const DAILY_RATE = 4.99");

      const checkoutItem = await resolveAuthoritativeLineItem(
        { metadata: { type: "banner_ad", durationDays: "14" } },
        "trader_1",
        null
      );
      expect(checkoutItem.authoritativeAmountPence).toBe(2800);
      expect(checkoutItem.metadata.dailyRate).toBe("2.00");
    });
  });

  describe("AT-ADS-02: Banner Promotion Moderation & Verification Badge Stripping", () => {
    it("creates banner ads in pending_review state (isActive=false) and withholds verified badge for unverified traders", async () => {
      const db = createMockFirestore({
        users: {
          trader_unverified: {
            uid: "trader_unverified",
            businessName: "Quick Fix Ltd",
            trade: "Plumbing",
            adWalletBalance: 50,
            isVerified: false,
            verificationStatus: "unverified",
          },
        },
      });

      const res = await createBannerAdCommand({
        db,
        authUid: "trader_unverified",
        headline: "24/7 Verified Pro Guaranteed",
        durationDays: 7,
        targetCategories: ["Plumbing"],
      });

      expect(res.totalCost).toBe(14);
      expect(res.dailyRate).toBe(2);
      expect(res.status).toBe("pending_review");
      expect(res.approvalStatus).toBe("pending_review");
      expect(res.isActive).toBe(false);
      expect(res.isVerifiedBadgeApplied).toBe(false);

      const savedAd = db.store.get("advertisements")?.get(res.adId);
      expect(savedAd.badgeLabel).toBe("SPONSORED");
      expect(savedAd.isActive).toBe(false);
      expect(savedAd.approvalStatus).toBe("pending_review");
      expect(savedAd.dailyRate).toBe(2);

      const updatedUser = db.store.get("users")?.get("trader_unverified");
      expect(updatedUser.adWalletBalance).toBe(36);

      // Cannot self-activate while pending_review
      await expect(
        toggleAdActiveCommand({ db, authUid: "trader_unverified", adId: res.adId })
      ).rejects.toThrow(/unapproved/i);

      // Admin approval transitions cleanly to approved & active with non-verified badge preserved
      const modRes = await moderateAdCommand({
        db,
        adminUid: "admin_1",
        adId: res.adId,
        decision: "approve",
      });
      expect(modRes.approvalStatus).toBe("approved");
      expect(modRes.isActive).toBe(true);
      expect(db.store.get("advertisements")?.get(res.adId).badgeLabel).toBe("SPONSORED");
    });

    it("grants FEATURED PRO badge only when server user record is authoritatively verified", async () => {
      const db = createMockFirestore({
        users: {
          trader_verified: {
            uid: "trader_verified",
            businessName: "Master Gas & Heating",
            trade: "Gas & Heating",
            adWalletBalance: 30,
            isVerified: true,
            verificationStatus: "verified",
          },
        },
      });

      const res = await createBannerAdCommand({
        db,
        authUid: "trader_verified",
        headline: "Gas Safe Registered Engineer",
        durationDays: 3,
      });

      expect(res.totalCost).toBe(6);
      expect(res.isVerifiedBadgeApplied).toBe(true);
      const savedAd = db.store.get("advertisements")?.get(res.adId);
      expect(savedAd.badgeLabel).toBe("FEATURED PRO");
      expect(savedAd.approvalStatus).toBe("pending_review");
    });
  });

  describe("AT-ADS-03: Preserve Explicitly Paused State on Campaign Wallet Top-Up", () => {
    it("keeps a paused campaign paused after top-up unless resumeAfterTopup is explicitly true", async () => {
      const db = createMockFirestore({
        users: {
          trader_1: { uid: "trader_1", adWalletBalance: 200 },
        },
        advertisements: {
          ad_paused: {
            advertiserUid: "trader_1",
            approvalStatus: "approved",
            billingCycle: "prepaid",
            prepaidBalance: 10,
            totalBudget: 50,
            isActive: false,
            status: "paused",
            pausedByAdvertiser: true,
          },
        },
      });

      const topup1 = await topUpAdCampaignCommand({
        db,
        authUid: "trader_1",
        adId: "ad_paused",
        amount: 50,
      });

      expect(topup1.prepaidBalance).toBe(60);
      expect(topup1.isActive).toBe(false);
      expect(topup1.status).toBe("paused");
      expect(db.store.get("advertisements")?.get("ad_paused").isActive).toBe(false);
      expect(db.store.get("users")?.get("trader_1").adWalletBalance).toBe(150);

      // Explicit resumeAfterTopup activates only if approved and balance > 0
      const topup2 = await topUpAdCampaignCommand({
        db,
        authUid: "trader_1",
        adId: "ad_paused",
        amount: 25,
        resumeAfterTopup: true,
      });
      expect(topup2.prepaidBalance).toBe(85);
      expect(topup2.isActive).toBe(true);
      expect(topup2.status).toBe("active");
    });

    it("never activates an unapproved campaign even when resumeAfterTopup is requested", async () => {
      const db = createMockFirestore({
        users: { trader_1: { uid: "trader_1", adWalletBalance: 100 } },
        advertisements: {
          ad_pending: {
            advertiserUid: "trader_1",
            approvalStatus: "pending_review",
            billingCycle: "prepaid",
            prepaidBalance: 0,
            totalBudget: 50,
            isActive: false,
            status: "pending_review",
          },
        },
      });

      const topup = await topUpAdCampaignCommand({
        db,
        authUid: "trader_1",
        adId: "ad_pending",
        amount: 50,
        resumeAfterTopup: true,
      });

      expect(topup.prepaidBalance).toBe(50);
      expect(topup.isActive).toBe(false);
    });
  });

  describe("AT-ADS-01: Transactional CPC Click/Impression Deduction & Caps", () => {
    it("deducts prepaidBalance atomically per click, writes ledger event, enforces daily cap, and auto-pauses on exhaustion", async () => {
      const now = new Date("2026-11-19T10:00:00.000Z");
      const db = createMockFirestore({
        advertisements: {
          ad_cpc: {
            advertiserUid: "trader_1",
            approvalStatus: "approved",
            isActive: true,
            status: "active",
            billingCycle: "prepaid",
            costPerDisplay: 1.0,
            prepaidBalance: 2.0,
            totalBudget: 10.0,
            totalSpend: 0,
            dailyDisplayLimit: 2,
            dailyResetDate: "2026-11-19",
            dailyClicks: 0,
            dailyImpressions: 0,
            dailySpend: 0,
            clicks: 0,
            searchFeedClicks: 0,
            bannerClicks: 0,
            impressions: 0,
          },
        },
      });

      const click1 = await trackSponsoredAdEventCommand({
        db,
        adId: "ad_cpc",
        eventType: "click",
        placement: "search_feed",
        viewerUid: "homeowner_1",
        now,
      });
      expect(click1.tracked).toBe(true);
      expect(click1.billed).toBe(true);
      expect(click1.chargeAmount).toBe(1.0);
      expect(click1.remainingBalance).toBe(1.0);
      expect(click1.pausedByCap).toBe(false);

      const imp1 = await trackSponsoredAdEventCommand({
        db,
        adId: "ad_cpc",
        eventType: "impression",
        placement: "banner_ad",
        now,
      });
      expect(imp1.tracked).toBe(true);
      expect(imp1.billed).toBe(false);
      expect(imp1.remainingBalance).toBe(1.0);

      // Click 2 hits £0 remaining balance and triggers auto-pause + daily cap (2/2)
      const click2 = await trackSponsoredAdEventCommand({
        db,
        adId: "ad_cpc",
        eventType: "click",
        placement: "banner_ad",
        viewerUid: "homeowner_2",
        now,
      });
      expect(click2.tracked).toBe(true);
      expect(click2.chargeAmount).toBe(1.0);
      expect(click2.remainingBalance).toBe(0);
      expect(click2.pausedByCap).toBe(true);

      const adAfter = db.store.get("advertisements")?.get("ad_cpc");
      expect(adAfter.isActive).toBe(false);
      expect(adAfter.status).toBe("paused");
      expect(adAfter.clicks).toBe(2);
      expect(adAfter.searchFeedClicks).toBe(1);
      expect(adAfter.bannerClicks).toBe(1);
      expect(db.store.get("ad_billing_events")?.size).toBe(2);

      // Click 3 is cleanly blocked without negative balance
      const click3 = await trackSponsoredAdEventCommand({
        db,
        adId: "ad_cpc",
        eventType: "click",
        placement: "banner_ad",
        now,
      });
      expect(click3.tracked).toBe(false);
      expect(db.store.get("advertisements")?.get("ad_cpc").prepaidBalance).toBe(0);
    });

    it("enforces dailyDisplayLimit even when prepaid balance remains", async () => {
      const now = new Date("2026-11-19T12:00:00.000Z");
      const db = createMockFirestore({
        advertisements: {
          ad_capped: {
            advertiserUid: "trader_1",
            approvalStatus: "approved",
            isActive: true,
            status: "active",
            billingCycle: "prepaid",
            costPerDisplay: 0.5,
            prepaidBalance: 100.0,
            totalBudget: 100.0,
            totalSpend: 0,
            dailyDisplayLimit: 1,
            dailyResetDate: "2026-11-19",
            dailyClicks: 1,
            clicks: 1,
          },
        },
      });

      const capped = await trackSponsoredAdEventCommand({
        db,
        adId: "ad_capped",
        eventType: "click",
        placement: "search_feed",
        now,
      });
      expect(capped.tracked).toBe(false);
      expect(capped.reason).toBe("daily_limit_reached");
      expect(db.store.get("advertisements")?.get("ad_capped").prepaidBalance).toBe(100.0);
    });
  });

  describe("AT-PAY-09: Provider Payout Idempotency & Transactional Lock", () => {
    it("rejects missing or short Idempotency-Key", async () => {
      const db = createMockFirestore({
        users: {
          driver_1: { uid: "driver_1", stripeAccountId: "acct_live_driver_1" },
        },
      });
      await expect(
        executeProviderPayoutCommand({
          db,
          stripe: {},
          authUid: "driver_1",
          idempotencyKey: "short",
          isMockDisallowed: true,
        })
      ).rejects.toThrow(/Idempotency-Key/i);
    });

    it("passes Stripe idempotencyKey, releases lock, replays identical key cleanly, and blocks mismatched payload reuse", async () => {
      const db = createMockFirestore({
        users: {
          driver_1: { uid: "driver_1", stripeAccountId: "acct_live_driver_1" },
        },
      });
      const payoutsCreate = vi.fn().mockResolvedValue({
        id: "po_live_001",
        amount: 5000,
        currency: "gbp",
        status: "in_transit",
      });
      const balanceRetrieve = vi.fn().mockResolvedValue({
        available: [{ currency: "gbp", amount: 12000 }],
      });
      const stripe = {
        balance: { retrieve: balanceRetrieve },
        payouts: { create: payoutsCreate },
      };

      const first = await executeProviderPayoutCommand({
        db,
        stripe,
        authUid: "driver_1",
        idempotencyKey: "payout_req_12345678",
        amountGbp: 50,
        isMockDisallowed: true,
      });

      expect(first.success).toBe(true);
      expect(first.payout.id).toBe("po_live_001");
      expect(payoutsCreate).toHaveBeenCalledTimes(1);
      expect(payoutsCreate.mock.calls[0][1].idempotencyKey).toMatch(/^provider-payout:driver_1:/);
      expect(db.store.get("provider_payout_locks")?.get("driver_1").active).toBe(false);

      // Replay with same Idempotency-Key returns cached response without calling Stripe again
      const replay = await executeProviderPayoutCommand({
        db,
        stripe,
        authUid: "driver_1",
        idempotencyKey: "payout_req_12345678",
        amountGbp: 50,
        isMockDisallowed: true,
      });
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.payout.id).toBe("po_live_001");
      expect(payoutsCreate).toHaveBeenCalledTimes(1);

      // Replay with same Idempotency-Key but different amount rejects with ConflictError
      await expect(
        executeProviderPayoutCommand({
          db,
          stripe,
          authUid: "driver_1",
          idempotencyKey: "payout_req_12345678",
          amountGbp: 80,
          isMockDisallowed: true,
        })
      ).rejects.toThrow(/different payout amount/i);
    });

    it("blocks concurrent payout execution when an active per-provider lease lock exists", async () => {
      const nowMs = Date.now();
      const db = createMockFirestore({
        users: {
          trader_1: { uid: "trader_1", stripeAccountId: "acct_live_trader_1" },
        },
        provider_payout_locks: {
          trader_1: {
            active: true,
            lockToken: "other_req_lock",
            expiresAtMs: nowMs + 30000,
          },
        },
      });

      await expect(
        executeProviderPayoutCommand({
          db,
          stripe: { balance: { retrieve: vi.fn() }, payouts: { create: vi.fn() } },
          authUid: "trader_1",
          idempotencyKey: "concurrent_req_999999",
          amountGbp: 25,
          nowMs,
        })
      ).rejects.toThrow(/already|currently being processed/i);
    });
  });
});
