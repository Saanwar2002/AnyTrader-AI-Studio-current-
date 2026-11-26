import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sanitizeExternalUrl, openSafeExternalUrl } from "../../src/lib/safeExternalUrl";

const ROOT = path.resolve(__dirname, "../..");

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

describe("Pre-Production Security Audit Safeguards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("External URL Sanitization (XSS & Open-Scheme Defense)", () => {
    it("allows valid https external links", () => {
      expect(sanitizeExternalUrl("https://checkout.stripe.com/c/pay/cs_test_123")).toBe(
        "https://checkout.stripe.com/c/pay/cs_test_123"
      );
      expect(sanitizeExternalUrl("  https://play.google.com/store/apps/details?id=com.anytrader.app  ")).toBe(
        "https://play.google.com/store/apps/details?id=com.anytrader.app"
      );
    });

    it("rejects javascript:, data:, vbscript:, file:, and non-localhost http: URLs", () => {
      expect(sanitizeExternalUrl("javascript:alert(document.cookie)")).toBeNull();
      expect(sanitizeExternalUrl("JAVASCRIPT:alert(1)")).toBeNull();
      expect(sanitizeExternalUrl("  javascript:void(0)")).toBeNull();
      expect(sanitizeExternalUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
      expect(sanitizeExternalUrl("vbscript:msgbox(1)")).toBeNull();
      expect(sanitizeExternalUrl("file:///etc/passwd")).toBeNull();
      expect(sanitizeExternalUrl("http://evil.example.com/phish")).toBeNull();
      expect(sanitizeExternalUrl("https://example.com/\nLocation: evil")).toBeNull();
      expect(sanitizeExternalUrl("")).toBeNull();
      expect(sanitizeExternalUrl(null)).toBeNull();
      expect(sanitizeExternalUrl(undefined)).toBeNull();
    });

    it("permits localhost http only for local dev and rejects blob: unless explicitly opted in", () => {
      expect(sanitizeExternalUrl("http://localhost:3000/callback")).toBe(
        "http://localhost:3000/callback"
      );
      expect(sanitizeExternalUrl("http://localhost:3000/callback", { allowLocalhostHttp: false })).toBeNull();

      const blobUrl = "blob:https://anytrader.co.uk/1234-5678";
      expect(sanitizeExternalUrl(blobUrl)).toBeNull();
      expect(sanitizeExternalUrl(blobUrl, { allowBlob: true })).toBe(blobUrl);
    });

    it("openSafeExternalUrl blocks dangerous URLs and enforces noopener,noreferrer on safe URLs", () => {
      const openSpy = vi.fn();
      vi.stubGlobal("window", { open: openSpy });

      expect(openSafeExternalUrl("javascript:alert(1)")).toBe(false);
      expect(openSpy).not.toHaveBeenCalled();

      expect(openSafeExternalUrl("https://anytrader.co.uk/partner")).toBe(true);
      expect(openSpy).toHaveBeenCalledWith(
        "https://anytrader.co.uk/partner",
        "_blank",
        "noopener,noreferrer"
      );
    });

    it("routes dynamic external navigation sinks through safeExternalUrl", () => {
      const guardedFiles = [
        "src/components/passenger/PassengerBooking.tsx",
        "src/components/TraderDocumentViewerModal.tsx",
        "src/components/driver/InsuranceMarketplace.tsx",
        "src/components/PostJobWizard.tsx",
        "src/components/shared/PartnerAdvertisement.tsx",
        "src/lib/version.ts",
      ];

      for (const file of guardedFiles) {
        const content = readRepoFile(file);
        expect(content, `${file} should import safeExternalUrl`).toContain("safeExternalUrl");
      }
    });
  });

  describe("Firestore Rules Cross-Tenant Hijack Defense", () => {
    const rules = readRepoFile("firestore.rules");

    it("eliminates the vulnerable combined isConsultancyOwner() helper", () => {
      expect(rules).not.toMatch(/function\s+isConsultancyOwner\s*\(/);
      expect(rules).not.toContain("isConsultancyOwner()");
    });

    it("separates existing resource ownership from incoming request ownership", () => {
      expect(rules).toMatch(/function\s+isConsultancyResourceOwner\s*\(/);
      expect(rules).toMatch(/function\s+isConsultancyRequestOwner\s*\(/);

      const resourceHelperMatch = rules.match(
        /function\s+isConsultancyResourceOwner\s*\(\)\s*\{([\s\S]*?)\n\s*\}/
      );
      expect(resourceHelperMatch).not.toBeNull();
      expect(resourceHelperMatch![1]).not.toContain("request.resource");

      const requestHelperMatch = rules.match(
        /function\s+isConsultancyRequestOwner\s*\(\)\s*\{([\s\S]*?)\n\s*\}/
      );
      expect(requestHelperMatch).not.toBeNull();
      expect(requestHelperMatch![1]).toContain("request.resource.data");
      expect(requestHelperMatch![1]).not.toMatch(/(?<!request\.)resource\s*!=/);
      expect(requestHelperMatch![1]).not.toMatch(/(?<!request\.)resource\.data/);
    });

    it("enforces explicit create/update/delete ownership on consultancy collections", () => {
      const collections = [
        "projectRoles",
        "projectBids",
        "projectShortlists",
        "projects",
        "clients",
        "proposals",
        "proposalTemplates",
        "projectMilestones",
        "teamMembers",
        "projectAssignments",
        "projectVenues",
        "projectSuppliers",
        "supplierContacts",
        "projectTimelineItems",
        "sessionNotes",
        "calendarEvents",
        "matchScores",
        "enquiries",
      ];

      for (const col of collections) {
        const pattern = new RegExp(
          `match\\s+/${col}/\\{[^}]+\\}\\s*\\{[\\s\\S]*?allow\\s+create:[\\s\\S]*?allow\\s+update:[\\s\\S]*?allow\\s+delete:`
        );
        expect(rules, `${col} must split create/update/delete rules`).toMatch(pattern);
      }
    });

    it("locks consultant ownership on rateCards, availabilityWindows, calendarSyncs, and portfolioItems", () => {
      for (const col of ["rateCards", "availabilityWindows", "calendarSyncs", "portfolioItems"]) {
        const match = rules.match(
          new RegExp(`match\\s+/${col}/\\{[^}]+\\}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`)
        );
        expect(match, `${col} rule block should exist`).not.toBeNull();
        const block = match![1];
        expect(block).toContain("resource.data.consultantId == request.auth.uid");
        expect(block).toContain("request.resource.data.consultantId == request.auth.uid");
        expect(block).not.toContain("allow write:");
      }
    });

    it("prevents client reassignment of ownership fields on invoices and expenses", () => {
      for (const col of ["invoices", "expenses"]) {
        const match = rules.match(
          new RegExp(`match\\s+/${col}/\\{[^}]+\\}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`)
        );
        expect(match, `${col} rule block should exist`).not.toBeNull();
        const block = match![1];
        expect(block).toContain("isConsultancyResourceOwner()");
        expect(block).toContain("'traderId'");
        expect(block).toContain("'consultantId'");
        expect(block).toContain("'userId'");
      }
    });
  });

  describe("Firebase Storage SVG XSS & Admin Role Hardening", () => {
    const storageRules = readRepoFile("storage.rules");

    it("restricts image uploads strictly to safe raster MIME types (blocking image/svg+xml)", () => {
      expect(storageRules).toMatch(/function\s+isSafeImageMimeType\s*\(/);
      expect(storageRules).toContain("image/(jpeg|jpg|png|webp|gif|heic|heif|avif)");
      expect(storageRules).not.toMatch(/contentType\.matches\(['"]image\/\.\*['"]\)/);
    });

    it("does not trust client-mutable token.role claims for Storage admin access", () => {
      expect(storageRules).not.toContain("request.auth.token.role");
      expect(storageRules).toContain("request.auth.token.admin == true");
    });
  });

  describe("Server Rate Limiting & Remote Config Production Hardening", () => {
    it("applies rate limiting to /api/rides/demand-zones", () => {
      const serverCode = readRepoFile("server.ts");
      expect(serverCode).toMatch(
        /app\.get\(\s*["']\/api\/rides\/demand-zones["']\s*,\s*generalLimiter\s*,/
      );
    });

    it("gates remoteConfigService localStorage overrides to development mode only", () => {
      const remoteConfigCode = readRepoFile("src/services/remoteConfigService.ts");
      expect(remoteConfigCode).toContain("IS_DEV_RUNTIME");
      expect(remoteConfigCode).toContain('if (!IS_DEV_RUNTIME || typeof window === "undefined") return {};');
      expect(remoteConfigCode).toContain('if (!IS_DEV_RUNTIME || typeof window === "undefined") return;');
      expect(remoteConfigCode).toContain("sanitizeExternalUrl");
    });
  });

  describe("Role-Based User Journey & Payment Integrity Verification", () => {
    it("enforces RoleRoute access guards on privileged routes and keeps /ad-studio authenticated", () => {
      const appCode = readRepoFile("src/App.tsx");
      expect(appCode).toContain("function RoleRoute(");
      expect(appCode).toContain('<Route path="admin" element={<RoleRoute allowed="admin"><MasterAdminLayout /></RoleRoute>} />');
      expect(appCode).toContain('<Route path="ecosystem" element={<RoleRoute allowed="ecosystem"><EcosystemAdmin /></RoleRoute>} />');
      expect(appCode).toContain('<Route path="ad-studio" element={<RoleRoute allowed="trader"><TraderAdStudio /></RoleRoute>} />');
      expect(appCode).toContain('<Route path="driver-terminal" element={<RoleRoute allowed="driver"><DriverTerminal /></RoleRoute>} />');
      expect(appCode).toContain('<Route path="corporate" element={<RoleRoute allowed="corporate"><CorporatePortal /></RoleRoute>} />');
      expect(appCode).not.toContain('<Route path="/ad-studio" element={<TraderAdStudio />} />');
    });

    it("prevents stale cross-account role leakage in PortalContext", () => {
      const portalCode = readRepoFile("src/lib/PortalContext.tsx");
      expect(portalCode).toContain("!availableRoles.includes(activeRole)");
    });

    it("keeps Onboarding postcode checks unconditional and strips privileged fields from client fallback", () => {
      const onboardingCode = readRepoFile("src/components/Onboarding.tsx");
      expect(onboardingCode).not.toContain('where("deviceId", "==", deviceId)');
      expect(onboardingCode).not.toContain('where("ipAddress", "==", detectedIp)');
      expect(onboardingCode).toContain("clientFallbackProfile");
      expect(onboardingCode).toContain("safeClientRole");
    });

    it("removes developer debug banner from Login screen", () => {
      const loginCode = readRepoFile("src/components/Login.tsx");
      expect(loginCode).not.toContain("Look at your screenshot!");
    });

    it("sends Authorization Bearer token on /api/create-setup-session and removes simulated payment bypasses", () => {
      const billingCode = readRepoFile("src/components/BillingManager.tsx");
      expect(billingCode).toMatch(/create-setup-session[\s\S]{0,220}Authorization/);

      const profileCode = readRepoFile("src/components/Profile.tsx");
      expect(profileCode).toMatch(/create-setup-session[\s\S]{0,220}Authorization/);
      expect(profileCode).not.toContain("(Simulated)");
      expect(profileCode).toContain("delete finalData.badges;");

      const driverExpensesCode = readRepoFile("src/components/driver/DriverExpenses.tsx");
      expect(driverExpensesCode).not.toContain("proFeaturesEnabled: !isPro");
      expect(driverExpensesCode).toContain("/api/create-checkout-session");

      const passengerBookingCode = readRepoFile("src/components/passenger/PassengerBooking.tsx");
      expect(passengerBookingCode).not.toContain("pendingCharges: 0,");
      expect(passengerBookingCode).toContain("/api/create-customer-portal-session");
    });

    it("prevents client self-verification in TraderVideoVerificationCard", () => {
      const videoCardCode = readRepoFile("src/components/TraderVideoVerificationCard.tsx");
      expect(videoCardCode).toContain('videoVerificationStatus: "pending"');
      expect(videoCardCode).not.toContain('videoVerificationStatus: "verified"');
      expect(videoCardCode).not.toContain('isVideoProSubscriber ? "verified" : "none"');
    });

    it("hardens user self-updates and fleet_driver & consultancy manager ownership in firestore.rules", () => {
      const rules = readRepoFile("firestore.rules");
      expect(rules).toContain("'fleet_driver'");
      expect(rules).toContain("resource.data.get('hasExclusiveAddon', false) == true");
      expect(rules).toContain("request.resource.data.get('verificationStatus', '') == 'pending'");
      expect(rules).toContain("request.resource.data.get('videoVerificationStatus', '') in ['pending', 'none']");
      expect(rules).toContain("resource.data.get('managerId', '') == request.auth.uid");
      expect(rules).toContain("request.resource.data.get('managerId', '') == request.auth.uid");
    });

    it("mounts authenticated and rate-limited /api/chat-push endpoint", () => {
      const serverCode = readRepoFile("server.ts");
      expect(serverCode).toMatch(
        /app\.post\(\s*["']\/api\/chat-push["']\s*,\s*requireAuth\s*,\s*AbuseDefenseEngine\.createMiddleware\(["']NOTIFICATION_SEND["']\)/
      );
    });
  });
});

