import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  deriveAdminTierFromPermissions,
  acceptStaffInvitationToken,
  hashInvitationToken,
} from "../../src/server/staffInvitations";
import {
  resolveAdminCapabilityTier,
  enqueueAdminBroadcastCommand,
} from "../../src/server/adminGovernance";
import { publishPlatformPricingConfigAtomic } from "../../src/server/pricingConfigPublish";

function createInMemoryFirestore(initial: Record<string, Record<string, any>> = {}) {
  const store: Record<string, Record<string, any>> = {};
  for (const [col, docs] of Object.entries(initial)) {
    store[col] = {};
    for (const [id, data] of Object.entries(docs)) {
      store[col][id] = structuredClone(data);
    }
  }

  let autoIdCounter = 0;

  const makeDocRef = (col: string, id: string) => ({
    id,
    path: `${col}/${id}`,
    _col: col,
    async get() {
      const data = store[col]?.[id];
      return {
        id,
        exists: data !== undefined,
        data: () => (data !== undefined ? structuredClone(data) : undefined),
      };
    },
    async set(data: any, opts?: { merge?: boolean }) {
      if (!store[col]) store[col] = {};
      if (opts?.merge && store[col][id]) {
        store[col][id] = { ...store[col][id], ...structuredClone(data) };
      } else {
        store[col][id] = structuredClone(data);
      }
    },
    async delete() {
      if (store[col]) delete store[col][id];
    },
  });

  const db: any = {
    _store: store,
    collection(col: string) {
      return {
        doc(id?: string) {
          const docId = id || `auto_${++autoIdCounter}`;
          return makeDocRef(col, docId);
        },
        async add(data: any) {
          const docId = `auto_${++autoIdCounter}`;
          const ref = makeDocRef(col, docId);
          await ref.set(data);
          return ref;
        },
        limit(n: number) {
          return {
            async get() {
              const entries = Object.entries(store[col] || {}).slice(0, n);
              return {
                docs: entries.map(([id, data]) => ({
                  id,
                  exists: true,
                  data: () => structuredClone(data),
                })),
              };
            },
          };
        },
      };
    },
    async runTransaction(fn: (tx: any) => Promise<any>) {
      const tx = {
        async get(ref: any) {
          return ref.get();
        },
        set(ref: any, data: any, opts?: { merge?: boolean }) {
          return ref.set(data, opts);
        },
        delete(ref: any) {
          return ref.delete();
        },
      };
      return fn(tx);
    },
  };

  return db;
}

describe("Slice 6: Admin Controls, Pricing Overrides & Operations Hardening", () => {
  describe("1. Staff Invitation Least-Privilege Tier Derivation & Resolution", () => {
    it("maps view-only permissions strictly to support_readonly", () => {
      expect(deriveAdminTierFromPermissions(["view_logs"])).toBe("support_readonly");
      expect(deriveAdminTierFromPermissions(["view_dashboard", "read_reports"])).toBe("support_readonly");
      expect(deriveAdminTierFromPermissions([])).toBe("support_readonly");
    });

    it("maps operational moderation permissions to financial_operator and governance permissions to super_admin", () => {
      expect(deriveAdminTierFromPermissions(["manage_jobs"])).toBe("financial_operator");
      expect(deriveAdminTierFromPermissions(["manage_users", "manage_disputes"])).toBe("financial_operator");
      expect(deriveAdminTierFromPermissions(["manage_team"])).toBe("super_admin");
      expect(deriveAdminTierFromPermissions(["manage_settings"])).toBe("super_admin");
    });

    it("persists adminTier, permissions, and adminPermissions on both admins/{uid} and users/{uid} when accepting an invite", async () => {
      const rawToken = "secret-invite-token-123456";
      const db = createInMemoryFirestore({
        invitations: {
          inv_readonly_1: {
            id: "inv_readonly_1",
            email: "auditor@anytrader.co.uk",
            role: "admin",
            permissions: ["view_logs"],
            status: "pending",
            tokenHash: hashInvitationToken(rawToken),
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            invitedBy: "super_admin_1",
          },
        },
      });

      const result = await acceptStaffInvitationToken({
        db,
        invitationId: "inv_readonly_1",
        token: rawToken,
        callerUid: "staff_uid_1",
        callerEmail: "auditor@anytrader.co.uk",
        emailVerified: true,
      });

      expect(result.adminTier).toBe("support_readonly");
      expect(db._store.admins.staff_uid_1.adminTier).toBe("support_readonly");
      expect(db._store.admins.staff_uid_1.permissions).toEqual(["view_logs"]);
      expect(db._store.users.staff_uid_1.adminTier).toBe("support_readonly");
      expect(db._store.users.staff_uid_1.permissions).toEqual(["view_logs"]);
      expect(db._store.users.staff_uid_1.adminPermissions).toEqual(["view_logs"]);
    });

    it("NEVER elevates view-only invited staff to super_admin even when decodedToken.admin === true", () => {
      const tierFromExplicit = resolveAdminCapabilityTier(
        { admin: true },
        { role: "admin", adminTier: "support_readonly", permissions: ["view_logs"] },
        { role: "admin", adminTier: "support_readonly", permissions: ["view_logs"] }
      );
      expect(tierFromExplicit).toBe("support_readonly");

      const tierFromPermissionsOnly = resolveAdminCapabilityTier(
        { admin: true },
        { role: "admin", adminPermissions: ["view_logs"] },
        { role: "admin", permissions: ["view_logs"] }
      );
      expect(tierFromPermissionsOnly).toBe("support_readonly");

      const tierOperatorFromPermissions = resolveAdminCapabilityTier(
        { admin: true },
        { role: "admin" },
        { role: "admin", permissions: ["manage_jobs", "view_logs"] }
      );
      expect(tierOperatorFromPermissions).toBe("financial_operator");

      // Legacy primary admin with no restricted permissions still resolves to super_admin
      const primaryAdminTier = resolveAdminCapabilityTier(
        { admin: true },
        { role: "admin" },
        null
      );
      expect(primaryAdminTier).toBe("super_admin");
    });
  });

  describe("2. Atomic Pricing Config Partial Publish Preservation & Provider Model Validation", () => {
    it("preserves existing maintenanceMode, feeTiers, businessTiers, and paidAddons on partial Launch Controls publish", async () => {
      const db = createInMemoryFirestore({
        platform_config: {
          global: {
            configVersion: 3,
            maintenanceMode: true,
            paywallEnabled: true,
            taxiPortalMode: "live",
            commissionCapGbp: 225,
            feeTiers: [{ name: "Free (PAYG)", price: 0, commission: 5 }],
            businessTiers: [{ name: "Business Pro", price: 99, commission: 2 }],
            paidAddons: {
              emergencyBoost: { price: 9.99 },
            },
          },
          global_tiers: {
            configVersion: 3,
            commissionCapGbp: 225,
            providerModels: {
              one_off_trades: {
                commissionCapGbp: 225,
                tiers: { payg: { price: 0, commission: 0.05 } },
              },
              on_demand_transport: {
                tiers: { standard: { price: 0, commission: 0.12 } },
              },
            },
          },
        },
      });

      const res = await publishPlatformPricingConfigAtomic({
        db,
        adminUid: "super_admin_1",
        adminEmail: "ops@anytrader.co.uk",
        tempConfig: {
          taxiPortalMode: "coming_soon",
        },
      });

      expect(res.success).toBe(true);
      expect(res.configVersion).toBe(4);

      const savedGlobal = db._store.platform_config.global;
      expect(savedGlobal.taxiPortalMode).toBe("coming_soon");
      expect(savedGlobal.maintenanceMode).toBe(true);
      expect(savedGlobal.feeTiers).toEqual([{ name: "Free (PAYG)", price: 0, commission: 5 }]);
      expect(savedGlobal.businessTiers).toEqual([{ name: "Business Pro", price: 99, commission: 2 }]);
      expect(savedGlobal.paidAddons).toEqual({ emergencyBoost: { price: 9.99 } });
      expect(savedGlobal.commissionCapGbp).toBe(225);

      const savedTiers = db._store.platform_config.global_tiers;
      expect(savedTiers.providerModels.on_demand_transport.tiers.standard.commission).toBe(0.12);
    });

    it("validates globalTiersProviderModels decimal commissions and preserves unrelated provider models", async () => {
      const db = createInMemoryFirestore({
        platform_config: {
          global: { configVersion: 1 },
          global_tiers: {
            configVersion: 1,
            providerModels: {
              on_demand_transport: {
                tiers: { standard: { price: 0, commission: 0.12 } },
              },
            },
          },
        },
      });

      await expect(
        publishPlatformPricingConfigAtomic({
          db,
          adminUid: "super_admin_1",
          tempConfig: {},
          globalTiersProviderModels: {
            one_off_trades: {
              tiers: { payg: { price: 0, commission: 5 } }, // Invalid > 1 decimal
            },
          },
        })
      ).rejects.toThrow(/decimal commission rate/i);

      const validRes = await publishPlatformPricingConfigAtomic({
        db,
        adminUid: "super_admin_1",
        tempConfig: {},
        commissionCapGbp: 200,
        globalTiersProviderModels: {
          one_off_trades: {
            commissionCapGbp: 200,
            tiers: {
              payg: { price: 0, commission: 0.05 },
              pro: { price: 29, commission: 0.03 },
            },
          },
        },
      });

      expect(validRes.configVersion).toBe(2);
      expect(db._store.platform_config.global_tiers.providerModels.one_off_trades.tiers.pro.price).toBe(29);
      expect(db._store.platform_config.global_tiers.providerModels.on_demand_transport.tiers.standard.commission).toBe(0.12);
    });
  });

  describe("3. Real Email Queue Broadcast Fan-Out & Honest Receipts", () => {
    it("writes real email_queue documents when email channel is enabled and provider is configured", async () => {
      const db = createInMemoryFirestore({
        users: {
          u_ho_1: { role: "homeowner", email: "alice@example.com" },
          u_ho_2: { role: "homeowner", email: "bob@example.com" },
          u_tr_1: { role: "tradesperson", email: "dave@example.com" },
        },
      });

      const res = await enqueueAdminBroadcastCommand(
        db,
        { uid: "admin_1", email: "ops@anytrader.co.uk", tier: "financial_operator" },
        {
          title: "Platform Update",
          content: "Scheduled maintenance tonight at 02:00 UTC.",
          targetSegments: ["homeowners"],
          channels: { inApp: true, email: true, sms: false },
        },
        { RESEND_API_KEY: "re_test_valid_key_123456" }
      );

      expect(res.status).toBe("completed");
      expect(res.sentCount).toBe(2);
      expect(res.emailQueuedCount).toBe(2);
      expect(res.channelStatuses.email).toBe("queued");
      const queuedEmails = Object.values(db._store.email_queue || {});
      expect(queuedEmails).toHaveLength(2);
      expect(queuedEmails.map((q: any) => q.to).sort()).toEqual([
        "alice@example.com",
        "bob@example.com",
      ]);
    });

    it("reports skipped_no_recipients instead of fake queued when matched users have no email", async () => {
      const db = createInMemoryFirestore({
        users: {
          u_ho_1: { role: "homeowner" }, // No email address
        },
      });

      const res = await enqueueAdminBroadcastCommand(
        db,
        { uid: "admin_1", email: "ops@anytrader.co.uk", tier: "financial_operator" },
        {
          title: "Platform Update",
          content: "Heads up!",
          targetSegments: ["homeowners"],
          channels: { inApp: true, email: true, sms: false },
        },
        { RESEND_API_KEY: "re_test_valid_key_123456" }
      );

      expect(res.emailQueuedCount).toBe(0);
      expect(res.channelStatuses.email).toBe("skipped_no_recipients");
      expect(Object.values(db._store.email_queue || {})).toHaveLength(0);
    });
  });

  describe("4. Static Security & Operational Hardening Regressions", () => {
    const read = (relPath: string) =>
      fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");

    it("enforces requireAdminTier on mutating admin routes and removes fabricated AI agent execution responses in server.ts", () => {
      const serverCode = read("server.ts");

      const requiredRoutes = [
        'app.post("/api/ads/:id/moderate", requireAdmin, requireAdminTier("financial_operator",',
        'app.post("/api/admin/sync-public-ads", requireAdmin, requireAdminTier("financial_operator",',
        'app.post("/api/admin/traders/:uid/verify", requireAdmin, requireAdminTier("financial_operator",',
        'app.post("/api/admin/reviews/:reviewId/moderate", requireAdmin, requireAdminTier("financial_operator",',
        'app.post("/api/admin/users/:userId/suspend", requireAdmin, requireAdminTier("financial_operator",',
        'app.post("/api/admin/users/:userId/reinstate", requireAdmin, requireAdminTier("financial_operator",',
        'app.post("/api/admin/users/:userId/attributes", requireAdmin, requireAdminTier("financial_operator",',
        'app.delete("/api/admin/users/:userId", requireAdmin, requireAdminTier("super_admin",',
        'app.post("/api/admin/users/:userId/delete", requireAdmin, requireAdminTier("super_admin",',
        'app.post("/api/admin/invitations", requireAdmin, requireAdminTier("super_admin",',
        'app.delete("/api/admin/invitations/:invitationId", requireAdmin, requireAdminTier("super_admin",',
        'app.delete("/api/admin/jobs/:jobId", requireAdmin, requireAdminTier("financial_operator",',
        'app.post("/api/admin/agents/execute-action", requireAdmin, requireAdminTier("financial_operator",',
      ];

      for (const snippet of requiredRoutes) {
        expect(serverCode).toContain(snippet);
      }

      // Honest 501 response — zero fake closed-loop execution claims
      expect(serverCode).toContain("res.status(501).json({");
      expect(serverCode).not.toContain("38 active verified tradespeople");
      expect(serverCode).not.toContain("via Stripe Escrow. Both parties notified.");
    });

    it("enforces tiered admin write helpers in firestore.rules", () => {
      const rules = read("firestore.rules");
      expect(rules).toContain("function isReadOnlyAdminDoc()");
      expect(rules).toContain("function isMutatingAdmin()");
      expect(rules).toContain("function isSuperAdmin()");
      expect(rules).toMatch(/match \/admins\/\{adminId\}[\s\S]*?allow write: if isSuperAdmin\(\);/);
      expect(rules).toMatch(/match \/platform_config\/\{doc\}[\s\S]*?allow write: if isSuperAdmin\(\);/);
      expect(rules).toMatch(/match \/invitations\/\{invitationId\}[\s\S]*?allow create: if isRegistered\(\) && \(\s*isSuperAdmin\(\)/);
    });

    it("removes localStorage admin trust and local fallbacks from MasterAdminLayout and routes AdminTierManager through atomic publish", () => {
      const masterLayout = read("src/components/MasterAdminLayout.tsx");
      expect(masterLayout).not.toContain("master_admin_auth_config");
      expect(masterLayout).not.toContain("Admin settings updated locally!");
      expect(masterLayout).not.toContain("admin@tradequote.uk");
      expect(masterLayout).not.toContain("feeTiers: []");

      const tierManager = read("src/components/AdminTierManager.tsx");
      expect(tierManager).toContain("/api/admin/pricing-config/publish");
      expect(tierManager).toContain("globalTiersProviderModels");

      const anyTraderAdmin = read("src/components/AnyTraderAdmin.tsx");
      expect(anyTraderAdmin).toContain("/api/admin/invitations/");
      expect(anyTraderAdmin).toContain("/api/admin/users/");
      expect(anyTraderAdmin).toContain("/api/gemini/sync-categories");
    });

    it("eliminates browser alert/confirm/window.open, hardcoded dev URLs, legacy branding, and broken routes across admin tabs", () => {
      const advertsTab = read("src/components/AdminAdvertsTab.tsx");
      expect(advertsTab).not.toMatch(/\b(alert|confirm)\s*\(/);
      expect(advertsTab).toContain("/api/admin/sync-public-ads");
      expect(advertsTab).toContain("/profile/${ad.advertiserId}");

      const guestJobs = read("src/components/GuestJobs.tsx");
      expect(guestJobs).not.toContain("window.open(");
      expect(guestJobs).toContain("/api/admin/jobs/");

      const searchTab = read("src/components/AdminSearchDemandTab.tsx");
      expect(searchTab).not.toMatch(/\bconfirm\s*\(/);

      const ecosystem = read("src/components/EcosystemAdmin.tsx");
      expect(ecosystem).not.toMatch(/\bconfirm\s*\(/);

      const alertService = read("src/services/adminAlertThresholdService.ts");
      expect(alertService).not.toContain("ais-dev-");
      expect(alertService).not.toContain("tradequote.uk");
      expect(alertService).not.toContain("TradeQuote Admin");

      const authSecurity = read("src/services/adminAuthSecurityService.ts");
      expect(authSecurity).not.toContain("2FA Master PIN");
      expect(authSecurity).not.toContain("admin_broadcast");

      const gdprTab = read("src/components/admin/AdminGdprRequestsTab.tsx");
      expect(gdprTab).toContain("unsubFallback");

      const systemTools = read("src/components/admin/AdminSystemToolsTab.tsx");
      expect(systemTools).not.toContain("public_advertisements");
      expect(systemTools).toContain("public_ads");
    });
  });
});
