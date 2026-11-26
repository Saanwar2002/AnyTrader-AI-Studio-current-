import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  clearAdEventDedupCacheForTests,
  editAdCreativeCommand,
  trackSponsoredAdEventCommand,
} from "../../src/server/adEngine";
import { sanitizeRedirectUrl } from "../../src/server/paymentVerification";

function createInMemoryDb(seed: Record<string, Record<string, any>> = {}) {
  const store = new Map<string, Record<string, any>>();
  for (const [k, v] of Object.entries(seed)) {
    store.set(k, { ...v });
  }

  const makeDocRef = (colName: string, docId: string) => {
    const key = `${colName}/${docId}`;
    return {
      id: docId,
      path: key,
      async get() {
        const data = store.get(key);
        return {
          exists: data !== undefined,
          id: docId,
          data: () => (data ? { ...data } : undefined),
        };
      },
      async set(payload: Record<string, any>, opts?: { merge?: boolean }) {
        if (opts?.merge && store.has(key)) {
          store.set(key, { ...store.get(key), ...payload });
        } else {
          store.set(key, { ...payload });
        }
      },
      async update(payload: Record<string, any>) {
        const cur = store.get(key) || {};
        store.set(key, { ...cur, ...payload });
      },
      async delete() {
        store.delete(key);
      },
    };
  };

  const db: any = {
    _store: store,
    collection(colName: string) {
      return {
        doc(docId?: string) {
          const id = docId || `auto_${Math.random().toString(36).slice(2, 10)}`;
          return makeDocRef(colName, id);
        },
      };
    },
    async runTransaction(fn: (tx: any) => Promise<any>) {
      const tx = {
        async get(ref: any) {
          return ref.get();
        },
        set(ref: any, payload: Record<string, any>, opts?: { merge?: boolean }) {
          if (opts?.merge && store.has(ref.path)) {
            store.set(ref.path, { ...store.get(ref.path), ...payload });
          } else {
            store.set(ref.path, { ...payload });
          }
        },
        update(ref: any, payload: Record<string, any>) {
          const cur = store.get(ref.path) || {};
          store.set(ref.path, { ...cur, ...payload });
        },
        delete(ref: any) {
          store.delete(ref.path);
        },
      };
      return fn(tx);
    },
  };
  return db;
}

describe("Slice 7 — Discovery, Ads, Search & Public Pages Hardening", () => {
  beforeEach(() => {
    clearAdEventDedupCacheForTests();
  });

  describe("1. Server-Authoritative Ad Creative Re-Moderation (editAdCreativeCommand)", () => {
    it("resets approvalStatus to pending_review, pauses delivery, and retracts public_ads on edit", async () => {
      const db = createInMemoryDb({
        "advertisements/ad-1": {
          advertiserUid: "trader-1",
          advertiserId: "trader-1",
          title: "Approved Headline",
          description: "Approved Description",
          approvalStatus: "approved",
          status: "active",
          isActive: true,
          prepaidBalance: 50,
          costPerClick: 1,
        },
        "public_ads/ad-1": {
          adId: "ad-1",
          title: "Approved Headline",
          isActive: true,
        },
      });

      const result = await editAdCreativeCommand({
        db,
        authUid: "trader-1",
        adId: "ad-1",
        title: "Updated Headline",
        description: "Updated Description",
      });

      expect(result.success).toBe(true);
      expect(result.approvalStatus).toBe("pending_review");
      expect(result.isActive).toBe(false);
      expect(result.requiresReModeration).toBe(true);

      const updatedAd = db._store.get("advertisements/ad-1");
      expect(updatedAd.title).toBe("Updated Headline");
      expect(updatedAd.description).toBe("Updated Description");
      expect(updatedAd.approvalStatus).toBe("pending_review");
      expect(updatedAd.isActive).toBe(false);
      // Retracted from public_ads because approvalStatus !== 'approved' and isActive === false
      expect(db._store.get("public_ads/ad-1")).toBeUndefined();
    });

    it("rejects creative edits from non-owner accounts", async () => {
      const db = createInMemoryDb({
        "advertisements/ad-1": {
          advertiserUid: "trader-1",
          title: "Original",
          description: "Original desc",
          approvalStatus: "approved",
          isActive: true,
        },
      });

      await expect(
        editAdCreativeCommand({
          db,
          authUid: "attacker-2",
          adId: "ad-1",
          description: "Hijacked copy",
        })
      ).rejects.toThrow(/do not own/i);
    });
  });

  describe("2. Sponsored Ad Self-Click Exclusion (trackSponsoredAdEventCommand)", () => {
    it("ignores and does not bill clicks when viewerUid matches the ad owner", async () => {
      const db = createInMemoryDb({
        "advertisements/ad-cpc-1": {
          advertiserUid: "trader-owner",
          advertiserId: "trader-owner",
          title: "Emergency Plumber",
          billingCycle: "prepaid",
          approvalStatus: "approved",
          isActive: true,
          prepaidBalance: 25,
          totalBudget: 25,
          totalSpend: 0,
          costPerClick: 1.0,
          clicks: 0,
          dailyClicks: 0,
          dailyDisplayLimit: 50,
          dailyResetDate: "2026-11-25",
        },
      });

      const res = await trackSponsoredAdEventCommand({
        db,
        adId: "ad-cpc-1",
        eventType: "click",
        placement: "banner_ad",
        viewerUid: "trader-owner",
        now: new Date("2026-11-25T12:00:00Z"),
      });

      expect(res.tracked).toBe(false);
      expect(res.billed).toBe(false);
      expect(res.chargeAmount).toBe(0);
      expect(res.reason).toBe("self_click_ignored");

      const adAfter = db._store.get("advertisements/ad-cpc-1");
      expect(adAfter.prepaidBalance).toBe(25);
      expect(adAfter.clicks).toBe(0);
    });

    it("still bills legitimate clicks from distinct viewers", async () => {
      const db = createInMemoryDb({
        "advertisements/ad-cpc-2": {
          advertiserUid: "trader-owner",
          advertiserId: "trader-owner",
          title: "Boiler Servicing",
          billingCycle: "prepaid",
          approvalStatus: "approved",
          isActive: true,
          prepaidBalance: 25,
          totalBudget: 25,
          totalSpend: 0,
          costPerClick: 1.0,
          clicks: 0,
          dailyClicks: 0,
          dailyDisplayLimit: 50,
          dailyResetDate: "2026-11-25",
        },
      });

      const res = await trackSponsoredAdEventCommand({
        db,
        adId: "ad-cpc-2",
        eventType: "click",
        placement: "search_feed",
        viewerUid: "homeowner-99",
        now: new Date("2026-11-25T12:00:00Z"),
      });

      expect(res.tracked).toBe(true);
      expect(res.billed).toBe(true);
      expect(res.chargeAmount).toBe(1);
      expect(res.remainingBalance).toBe(24);
    });
  });

  describe("3. Stripe Ad Studio Redirect Allowlist", () => {
    it("allows /trader/banner-ads and /ad-studio redirect URLs", () => {
      const appUrl = "https://www.anytrader.co.uk";
      expect(
        sanitizeRedirectUrl(
          "https://www.anytrader.co.uk/trader/banner-ads?ad_paid=true",
          appUrl,
          "/dashboard"
        )
      ).toBe("https://www.anytrader.co.uk/trader/banner-ads?ad_paid=true");

      expect(
        sanitizeRedirectUrl(
          "https://www.anytrader.co.uk/ad-studio?topup=success",
          appUrl,
          "/dashboard"
        )
      ).toBe("https://www.anytrader.co.uk/ad-studio?topup=success");
    });
  });

  describe("4. Firestore Rules & Public Surface Hygiene", () => {
    const root = path.resolve(__dirname, "../..");
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

    it("locks compliance self-assertion flags on public_profiles in firestore.rules", () => {
      const rules = read("firestore.rules");
      const pubSection = rules.slice(
        rules.indexOf("match /public_profiles/{userId}"),
        rules.indexOf("match /public_profiles/{userId}") + 3600
      );
      expect(pubSection).toContain("isGasSafeRegistered");
      expect(pubSection).toContain("isNiceicApproved");
      expect(pubSection).toContain("insuranceVerified");
      expect(pubSection).toContain("publicLiabilityVerified");
    });

    it("blocks post-approval creative edit bypass on advertisements in firestore.rules", () => {
      const rules = read("firestore.rules");
      const adSection = rules.slice(
        rules.indexOf("match /advertisements/{adId}"),
        rules.indexOf("match /advertisements/{adId}") + 2500
      );
      expect(adSection).toContain("resource.data.get('approvalStatus', '') != 'approved'");
    });

    it("enforces flash_deals claim status transition integrity in firestore.rules", () => {
      const rules = read("firestore.rules");
      const dealSection = rules.slice(
        rules.indexOf("match /flash_deals/{dealId}"),
        rules.indexOf("match /flash_deals/{dealId}") + 2500
      );
      expect(dealSection).toContain("resource.data.get('status', 'active') == 'active'");
      expect(dealSection).toContain("request.resource.data.claimedCount >= resource.data.get('maxBookings', 0)");
    });

    it("removes placeholder links, fake seed traders, and broken routes across Slice 7 surfaces", () => {
      const partnerAd = read("src/components/shared/PartnerAdvertisement.tsx");
      const partnerPerks = read("src/components/PartnerPerks.tsx");
      const homeownerPerks = read("src/components/HomeownerPerks.tsx");
      const headerSearch = read("src/components/HeaderAccountSearch.tsx");
      const headerTicker = read("src/components/HeaderSmartTicker.tsx");
      const illustratedTicker = read("src/components/shared/IllustratedAdTicker.tsx");
      const adminAdverts = read("src/components/AdminAdvertsTab.tsx");
      const gotham = read("src/components/anytrader/GothamHousingPortal.tsx");
      const seo = read("src/components/SEO.tsx");
      const robots = read("public/robots.txt");
      const indexHtml = read("index.html");
      const llms = read("public/llms.txt");

      expect(partnerAd).not.toContain("seed-promoted-");
      expect(partnerAd).not.toContain("HOMECARE24");
      expect(partnerAd).not.toContain("SCREWPRO");
      expect(partnerPerks).not.toContain("example.com");
      expect(homeownerPerks).not.toContain("example.com");
      expect(headerSearch).not.toContain('"/trade-dashboard"');
      expect(headerSearch).not.toContain('"/payment-protection"');
      expect(headerSearch).not.toContain('"/corporate"');
      expect(headerSearch).not.toContain("14m average arrival");
      expect(headerTicker).not.toContain("14M AVG");
      expect(illustratedTicker).not.toContain("14m Avg Dispatch");
      expect(illustratedTicker).not.toContain('"/corporate"');
      expect(adminAdverts).not.toContain("/public-profile/");
      expect(gotham).not.toContain("/public-profile/");
      expect(seo).not.toContain("picsum.photos");
      expect(seo).not.toContain("/logo.png");
      expect(robots).not.toContain("anytrader.uk");
      expect(robots).toContain("Disallow: /admin");
      expect(indexHtml).not.toContain("86+");
      expect(indexHtml).not.toContain("keep 100% of their earnings");
      expect(llms).not.toContain("86+");
      expect(llms).not.toContain("keep 100% of their earnings");
    });
  });
});
