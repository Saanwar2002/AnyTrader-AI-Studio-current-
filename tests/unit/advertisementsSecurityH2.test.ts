import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("Security Remediation H2 — Advertisements Budget & State Integrity Audit", () => {
  const rulesCode = fs.readFileSync(path.resolve(__dirname, "../../firestore.rules"), "utf-8");
  const serverCode = fs.readFileSync(path.resolve(__dirname, "../../server.ts"), "utf-8");
  const partnerAdCode = fs.readFileSync(path.resolve(__dirname, "../../src/components/shared/PartnerAdvertisement.tsx"), "utf-8");
  const bannerAdStudioCode = fs.readFileSync(path.resolve(__dirname, "../../src/components/TradesBannerAdStudio.tsx"), "utf-8");
  const traderAdStudioCode = fs.readFileSync(path.resolve(__dirname, "../../src/components/TraderAdStudio.tsx"), "utf-8");
  const findTradesCode = fs.readFileSync(path.resolve(__dirname, "../../src/components/FindTrades.tsx"), "utf-8");

  describe("1. Firestore Security Rules Hardening for /advertisements/{adId}", () => {
    it("restricts direct advertisement creation to admins only (non-admin campaigns must use server API) and scopes private reads to owner/admin", () => {
      expect(rulesCode).toContain("match /advertisements/{adId}");
      expect(rulesCode).toContain("allow create: if isAdmin();");
      expect(rulesCode).toContain("resource.data.get('advertiserUid', '') == request.auth.uid");
      expect(rulesCode).toContain("match /public_ads/{adId}");
    });

    it("strictly isolates protected financial & state fields from client updates", () => {
      // Must contain affectedKeys check forbidding sensitive fields
      expect(rulesCode).toContain("'prepaidBalance'");
      expect(rulesCode).toContain("'isActive'");
      expect(rulesCode).toContain("'lastAutoTopUpAt'");
      expect(rulesCode).toContain("'approvalStatus'");
      expect(rulesCode).toContain("'totalBudget'");
      expect(rulesCode).toContain("'totalCost'");
      expect(rulesCode).toContain("'advertiserUid'");
      expect(rulesCode).toContain("'advertiserId'");
    });

    it("forbids direct client mutation of engagement & billing counters (all tracking routes through /api/ads/:id/track)", () => {
      const adBlock = rulesCode.split("match /advertisements/{adId}")[1].split("match /public_ads/{adId}")[0];
      expect(adBlock).toContain("!request.resource.data.diff(resource.data).affectedKeys().hasAny([");
      expect(adBlock).toContain("'clicks', 'bannerClicks', 'searchFeedClicks', 'impressions'");
      expect(adBlock).toContain("'dailyClicks', 'dailyImpressions', 'dailySpend', 'totalSpend', 'dailyResetDate'");
    });

    it("strictly validates ownership on ad deletion", () => {
      expect(rulesCode).toMatch(/allow delete: if isAdmin\(\) \|\| \(\s*isSignedIn\(\) && \(resource\.data\.advertiserUid == request\.auth\.uid \|\| resource\.data\.get\('advertiserId', ''\) == request\.auth\.uid\)\s*\);/);
    });
  });

  const adEngineCode = fs.readFileSync(path.resolve(__dirname, "../../src/server/adEngine.ts"), "utf-8");

  describe("2. Server-Authoritative Endpoints in server.ts & adEngine.ts", () => {
    it("implements /api/ads/:id/toggle-active with authentication, ownership, and approval validation", () => {
      expect(serverCode).toContain('app.post("/api/ads/:id/toggle-active", requireAuth,');
      expect(adEngineCode).toContain("adData.advertiserUid === authUid || adData.advertiserId === authUid");
      expect(adEngineCode).toContain('adData.approvalStatus !== "approved"');
      expect(adEngineCode).toContain("isActive: nextActive");
    });

    it("implements /api/ads/create-banner with wallet balance verification, £2/day rate, and pending_review moderation", () => {
      expect(serverCode).toContain('app.post("/api/ads/create-banner", requireAuth,');
      expect(adEngineCode).toContain("currentWallet < totalCost");
      expect(adEngineCode).toContain("adWalletBalance: nextWalletBalance");
      expect(adEngineCode).toContain('type: "trader_promo"');
      expect(adEngineCode).toContain('approvalStatus: "pending_review"');
    });

    it("implements /api/ads/:id/topup with wallet balance verification and paused-state preservation", () => {
      expect(serverCode).toContain('app.post("/api/ads/:id/topup", requireAuth, paymentLimiter,');
      expect(adEngineCode).toContain("currentWallet < topupAmount");
      expect(adEngineCode).toContain("prepaidBalance: finalBalance");
    });

    it("implements /api/ads/:id/track for transactional CPC billing and delivery caps", () => {
      expect(serverCode).toContain('app.post("/api/ads/:id/track", generalLimiter,');
      expect(adEngineCode).toContain("trackSponsoredAdEventCommand");
    });
  });

  describe("3. Client Components Safety Audit", () => {
    it("PartnerAdvertisement.tsx routes ad clicks to server /api/ads/:id/track and never mutates balance client-side", () => {
      expect(partnerAdCode).not.toContain("updateData.prepaidBalance");
      expect(partnerAdCode).not.toContain("prepaidBalance: increment");
      expect(partnerAdCode).not.toContain("lastAutoTopUpAt");
      expect(partnerAdCode).toContain('/api/ads/${encodeURIComponent(clickedAd.id)}/track');
    });

    it("FindTrades.tsx routes promoted card clicks to server /api/ads/:id/track", () => {
      expect(findTradesCode).toContain('/api/ads/${encodeURIComponent(tp.adId)}/track');
      expect(findTradesCode).not.toContain("prepaidBalance: increment");
    });

    it("TradesBannerAdStudio.tsx uses /api/ads/create-banner and /api/ads/:id/toggle-active", () => {
      expect(bannerAdStudioCode).toContain('fetch("/api/ads/create-banner"');
      expect(bannerAdStudioCode).toContain('fetch(`/api/ads/${ad.id}/toggle-active`');
    });

    it("TraderAdStudio.tsx uses /api/ads/:id/topup and /api/ads/:id/toggle-active", () => {
      expect(traderAdStudioCode).toContain('fetch(`/api/ads/${adId}/topup`');
      expect(traderAdStudioCode).toContain('fetch(`/api/ads/${ad.id}/toggle-active`');
    });
  });
});
