import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const readRepo = (relPath: string) =>
  fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");

describe("Slice 8 — Production Readiness, Infrastructure & Dry-Run Hardening", () => {
  const serverSource = readRepo("server.ts");
  const bootstrapSource = readRepo("src/server/bootstrap.ts");
  const envExample = readRepo(".env.example");
  const indexesJson = JSON.parse(readRepo("firestore.indexes.json"));
  const storageRules = readRepo("storage.rules");
  const viteConfig = readRepo("vite.config.ts");
  const indexHtml = readRepo("index.html");
  const manifestJson = JSON.parse(readRepo("public/manifest.json"));
  const dealUtils = readRepo("src/lib/dealUtils.tsx");
  const errorBoundary = readRepo("src/components/ErrorBoundary.tsx");
  const jobDetails = readRepo("src/components/JobDetails.tsx");

  describe("1. Server Production Security & Resilience (CORS, CSP, Error Handling, Shutdown, Schedulers)", () => {
    it("restricts localhost and *.run.app CORS origins out of standalone production", () => {
      expect(serverSource).toContain("const defaultAllowedOrigins: string[] = isProd");
      expect(serverSource).toContain("(!isProd || isAiStudioContainer)");
      expect(serverSource).toContain("ais-(dev|pre)-[a-z0-9-]+\\.run\\.app");
      expect(serverSource).not.toMatch(/parsed\.hostname\.endsWith\("\.run\.app"\)\s*\|\|\s*parsed\.hostname\.endsWith\("\.google\.com"\)/);
    });

    it("aligns server CSP with index.html (gstatic scripts, worker-src) and omits AI Studio preview origins in standalone production", () => {
      expect(serverSource).toContain("https://*.gstatic.com");
      expect(serverSource).toContain("worker-src 'self' blob:");
      expect(serverSource).toContain("const frameAncestorsDirective = (!isProd || isAiStudioContainer)");
      expect(serverSource).toContain(': "frame-ancestors \'self\'"');
    });

    it("installs terminal 4-arg Express error middleware returning sanitized JSON for invalid JSON and oversized payloads", () => {
      expect(serverSource).toContain('err?.type === "entity.parse.failed"');
      expect(serverSource).toContain('code: "INVALID_JSON"');
      expect(serverSource).toContain('code: "PAYLOAD_TOO_LARGE"');
      expect(serverSource).toContain("return sendHttpError(res, err, req);");
    });

    it("schedules cooling_off_reviews and lead_wave_expansion in startBackgroundSchedulers()", () => {
      const schedulerBlock = serverSource.split("const startBackgroundSchedulers = () => {")[1].split("const getFirebaseMessagingClient")[0];
      expect(schedulerBlock).toContain('runWithSchedulerLease("cooling_off_reviews"');
      expect(schedulerBlock).toContain("publishMatureCoolingOffReviewsCommand(db)");
      expect(schedulerBlock).toContain('runWithSchedulerLease("lead_wave_expansion"');
      expect(schedulerBlock).toContain("expandLowQuoteJobsWave2(");
    });

    it("registers SIGTERM and SIGINT graceful shutdown handlers stopping intelligenceTaskQueue and closing HTTP server", () => {
      expect(serverSource).toContain('process.once("SIGTERM"');
      expect(serverSource).toContain('process.once("SIGINT"');
      expect(serverSource).toContain("intelligenceTaskQueue.stopWorker()");
      expect(serverSource).toContain("serverInstance.close(");
    });

    it("uses AnyTrader UK branding in health and bootstrap logs", () => {
      expect(serverSource).toContain("AnyTrader UK API is running and ready");
      expect(serverSource).toContain("AnyTrader UK API running (client SPA mode active)");
      expect(serverSource).not.toContain("TradeQuote UK API");
      expect(serverSource).not.toContain("TradeQuote UK server running");
      expect(bootstrapSource).toContain("AnyTrader UK Enterprise Application READY.");
      expect(bootstrapSource).not.toContain("TradeQuote UK");
    });
  });

  describe("2. Firestore Composite Indexes & Firebase Storage Admin Write Tiering", () => {
    it("declares composite indexes for chat_user_blocks (blockedUid, active) and reviews (status, publishAt)", () => {
      const indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order?: string }> }> = indexesJson.indexes;

      const hasBlockedUidIndex = indexes.some(
        (idx) =>
          idx.collectionGroup === "chat_user_blocks" &&
          idx.fields.length === 2 &&
          idx.fields[0].fieldPath === "blockedUid" &&
          idx.fields[1].fieldPath === "active"
      );
      expect(hasBlockedUidIndex).toBe(true);

      const hasReviewCoolingOffIndex = indexes.some(
        (idx) =>
          idx.collectionGroup === "reviews" &&
          idx.fields.length === 2 &&
          idx.fields[0].fieldPath === "status" &&
          idx.fields[1].fieldPath === "publishAt"
      );
      expect(hasReviewCoolingOffIndex).toBe(true);
    });

    it("distinguishes support_readonly admins from mutating admins in storage.rules", () => {
      expect(storageRules).toContain("function isMutatingAdmin()");
      expect(storageRules).toContain("data.get('adminTier', 'super_admin') != 'support_readonly'");
      expect(storageRules).not.toMatch(/allow read, write: if isAdmin\(\);/);
      expect(storageRules).toContain("allow write: if isMutatingAdmin();");
    });
  });

  describe("3. Single Authoritative PWA Manifest & Deep-Link SW Scope", () => {
    it("disables duplicate VitePWA manifest injection and excludes /.well-known/ from Workbox fallback", () => {
      expect(viteConfig).toContain("manifest: false");
      expect(viteConfig).not.toContain("ordering a taxi");
      expect(viteConfig).toContain("/^\\/\\.well-known\\//");
    });

    it("links /manifest.json once in index.html and configures valid PWA manifest fields", () => {
      const manifestLinks = indexHtml.match(/rel="manifest"/g) || [];
      expect(manifestLinks).toHaveLength(1);
      expect(manifestJson.id).toBe("/");
      expect(manifestJson.scope).toBe("/");
      expect(manifestJson.start_url).toBe("/");
      expect(manifestJson.display).toBe("standalone");
      expect(manifestJson.theme_color).toBe("#002B5C");
      expect(manifestJson.short_name.length).toBeLessThanOrEqual(12);
      expect(manifestJson.icons.some((i: any) => i.sizes === "192x192")).toBe(true);
      expect(manifestJson.icons.some((i: any) => i.sizes === "512x512")).toBe(true);
      expect(manifestJson.icons.every((i: any) => i.purpose !== "any maskable")).toBe(true);
    });
  });

  describe("4. UI Production Hygiene & Environment Documentation", () => {
    it("removes fabricated rolling countdowns and window.open from dealUtils.tsx", () => {
      expect(dealUtils).not.toContain("window.open(");
      expect(dealUtils).not.toContain("8 * 3600 * 1000");
      expect(dealUtils).not.toContain("baseOffsetMs");
      expect(dealUtils).toContain("Limited Offer");
    });

    it("replaces window.open Google Maps directions in JobDetails.tsx with rel='noopener noreferrer' anchor", () => {
      expect(jobDetails).not.toContain("window.open(`https://www.google.com/maps/dir/");
      expect(jobDetails).toContain("https://www.google.com/maps/dir/?api=1&destination=");
      expect(jobDetails).toContain('rel="noopener noreferrer"');
    });

    it("masks raw error.message in production ErrorBoundary", () => {
      expect(errorBoundary).toContain("import.meta.env.PROD");
    });

    it("documents all server runtime environment variable placeholders in .env.example", () => {
      for (const key of [
        "PUBLIC_APP_URL=",
        "PHONE_FINGERPRINT_PEPPER=",
        "RESEND_API_KEY=",
        "SENDGRID_API_KEY=",
        "SMTP_PASS=",
        "TWILIO_WHATSAPP_NUMBER=",
      ]) {
        expect(envExample).toContain(key);
      }
    });
  });
});
