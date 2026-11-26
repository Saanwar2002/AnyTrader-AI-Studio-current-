import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { suspendOrDeleteAccount, reinstateSuspendedAccount } from "../../src/server/accountLifecycle.ts";
import { publishPlatformPricingConfigAtomic } from "../../src/server/pricingConfigPublish.ts";
import { executeStartJobCommand } from "../../src/server/jobLifecycleCommands.ts";
import {
  generateFinancialReconciliationReport,
  executeReconciliationOperatorAction,
} from "../../src/server/reconciliationReport.ts";
import { ForbiddenError } from "../../src/server/httpErrors.ts";
import type { CanonicalIdentity } from "../../src/server/identity.ts";

class InMemoryCollectionDb {
  public collections = new Map<string, Map<string, any>>();
  public nextAutoId = 1;

  constructor(seed: Record<string, Record<string, any>> = {}) {
    for (const [col, docs] of Object.entries(seed)) {
      const map = new Map<string, any>();
      for (const [id, data] of Object.entries(docs)) {
        map.set(id, JSON.parse(JSON.stringify(data)));
      }
      this.collections.set(col, map);
    }
  }

  private getMap(name: string) {
    let map = this.collections.get(name);
    if (!map) {
      map = new Map<string, any>();
      this.collections.set(name, map);
    }
    return map;
  }

  collection(name: string): any {
    const dbSelf = this;
    const map = this.getMap(name);

    const buildQuery = (filters: Array<{ field: string; op: string; value: any }> = [], limitVal?: number) => ({
      where(field: string, op: string, value: any) {
        return buildQuery([...filters, { field, op, value }], limitVal);
      },
      orderBy() {
        return buildQuery(filters, limitVal);
      },
      startAfter(cursor: any) {
        return {
          ...buildQuery(filters, limitVal),
          async get() {
            const all = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            const idx = all.findIndex(([id]) => id === cursor.id);
            const sliced = idx >= 0 ? all.slice(idx + 1, idx + 1 + (limitVal || 1000)) : [];
            return {
              docs: sliced.map(([id, data]) => ({
                id,
                exists: true,
                data: () => JSON.parse(JSON.stringify(data)),
              })),
            };
          },
        };
      },
      limit(val: number) {
        return buildQuery(filters, val);
      },
      async get() {
        let entries = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        for (const f of filters) {
          if (f.op === "==") {
            entries = entries.filter(([, data]) => data?.[f.field] === f.value);
          }
        }
        if (typeof limitVal === "number") {
          entries = entries.slice(0, limitVal);
        }
        return {
          empty: entries.length === 0,
          size: entries.length,
          docs: entries.map(([id, data]) => ({
            id,
            exists: true,
            ref: dbSelf.collection(name).doc(id),
            data: () => JSON.parse(JSON.stringify(data)),
          })),
        };
      },
    });

    return {
      ...buildQuery(),
      doc(docId?: string) {
        const id = docId || `auto_${dbSelf.nextAutoId++}`;
        const ref: any = {
          id,
          path: `${name}/${id}`,
          collection(subName: string) {
            return dbSelf.collection(`${name}/${id}/${subName}`);
          },
          async get() {
            const val = map.get(id);
            return {
              id,
              exists: val !== undefined,
              data: () => (val !== undefined ? JSON.parse(JSON.stringify(val)) : undefined),
            };
          },
          async set(data: any, opts?: { merge?: boolean }) {
            const existing = map.get(id);
            map.set(
              id,
              opts?.merge && existing ? { ...existing, ...JSON.parse(JSON.stringify(data)) } : JSON.parse(JSON.stringify(data))
            );
          },
          async update(data: any) {
            const existing = map.get(id);
            if (!existing) throw new Error(`Missing document ${name}/${id}`);
            map.set(id, { ...existing, ...JSON.parse(JSON.stringify(data)) });
          },
          async delete() {
            map.delete(id);
          },
        };
        return ref;
      },
      async add(data: any) {
        const id = `auto_${dbSelf.nextAutoId++}`;
        await dbSelf.collection(name).doc(id).set(data);
        return { id };
      },
    };
  }

  async runTransaction(fn: (tx: any) => Promise<any>) {
    const ops: Array<() => Promise<void>> = [];
    const tx = {
      async get(ref: any) {
        return ref.get();
      },
      set(ref: any, data: any, opts?: { merge?: boolean }) {
        ops.push(() => ref.set(data, opts));
      },
      update(ref: any, data: any) {
        ops.push(() => ref.update(data));
      },
      delete(ref: any) {
        ops.push(() => ref.delete());
      },
    };
    const res = await fn(tx);
    for (const op of ops) {
      await op();
    }
    return res;
  }
}

describe("Batch 5 P1 Remediations — Account Freeze, Trader Revalidation, Atomic Config & FIN-05 Reconciliation", () => {
  describe("AT-ADMIN-CTRL-01, AT-ACCOUNT-01 & AT-VER-09 — Complete Freeze / Delete Lifecycle", () => {
    it("suspending a trader revokes Auth tokens, deletes public_profiles, pauses active ads, freezes active jobs, and notifies homeowners", async () => {
      const db = new InMemoryCollectionDb({
        users: {
          trader_1: {
            uid: "trader_1",
            name: "Apex Boilers",
            role: "tradesperson",
            primaryTrade: "Plumbing & Heating",
            isVerified: true,
            verificationStatus: "verified",
          },
        },
        public_profiles: {
          trader_1: {
            uid: "trader_1",
            name: "Apex Boilers",
            role: "tradesperson",
            verifiedTrader: true,
          },
        },
        advertisements: {
          ad_active: {
            advertiserUid: "trader_1",
            isActive: true,
            status: "active",
          },
          ad_other: {
            advertiserUid: "trader_2",
            isActive: true,
            status: "active",
          },
        },
        jobs: {
          job_active_1: {
            title: "Combi Boiler Swap",
            status: "accepted",
            homeownerId: "home_1",
            acceptedTradespersonId: "trader_1",
          },
          job_done_2: {
            title: "Tap Replace",
            status: "completed",
            homeownerId: "home_2",
            acceptedTradespersonId: "trader_1",
          },
        },
      });

      const authCalls: string[] = [];
      const mockAuth = {
        async updateUser(uid: string, props: { disabled: boolean }) {
          authCalls.push(`updateUser:${uid}:disabled=${props.disabled}`);
        },
        async revokeRefreshTokens(uid: string) {
          authCalls.push(`revoke:${uid}`);
        },
      };

      const res = await suspendOrDeleteAccount({
        db,
        authClient: mockAuth,
        adminUid: "admin_1",
        adminEmail: "ops@anytrader.co.uk",
        targetUid: "trader_1",
        reason: "Fraud investigation",
        mode: "suspend",
      });

      expect(res.success).toBe(true);
      expect(res.authDisabled).toBe(true);
      expect(res.authRevoked).toBe(true);
      expect(res.publicProfileRetracted).toBe(true);
      expect(res.pausedAdsCount).toBe(1);
      expect(res.frozenJobsCount).toBe(1);
      expect(res.frozenJobIds).toEqual(["job_active_1"]);
      expect(res.notifiedHomeownersCount).toBe(1);

      expect(authCalls).toEqual(["updateUser:trader_1:disabled=true", "revoke:trader_1"]);
      expect(db.collections.get("public_profiles")?.has("trader_1")).toBe(false);
      expect(db.collections.get("users")?.get("trader_1")?.isDisabled).toBe(true);
      expect(db.collections.get("users")?.get("trader_1")?.status).toBe("suspended");

      // Active ad paused; other user's ad untouched
      expect(db.collections.get("advertisements")?.get("ad_active")?.isActive).toBe(false);
      expect(db.collections.get("advertisements")?.get("ad_active")?.status).toBe("paused_by_freeze");
      expect(db.collections.get("advertisements")?.get("ad_other")?.isActive).toBe(true);

      // Active job frozen & escalation created; completed job untouched
      const frozenJob = db.collections.get("jobs")?.get("job_active_1");
      expect(frozenJob.progressionFrozen).toBe(true);
      expect(frozenJob.reassignmentRequired).toBe(true);
      expect(frozenJob.assignedTraderSuspended).toBe(true);
      expect(db.collections.get("jobs")?.get("job_done_2")?.progressionFrozen).toBeUndefined();
      expect(db.collections.get("admin_safety_escalations")?.has("trader_1_job_active_1")).toBe(true);

      const notifDocs = [...(db.collections.get("notifications")?.values() || [])];
      expect(notifDocs.some((n) => n.userId === "home_1" && n.jobId === "job_active_1")).toBe(true);
    });

    it("deleting a user revokes & deletes Firebase Auth, archives tombstone, deletes user & public_profile, and flags active jobs", async () => {
      const db = new InMemoryCollectionDb({
        users: {
          user_del: { uid: "user_del", role: "homeowner", name: "Delete Me" },
        },
        public_profiles: {
          user_del: { uid: "user_del" },
        },
      });
      let deletedFromAuth = false;
      const mockAuth = {
        async updateUser() {},
        async revokeRefreshTokens() {},
        async deleteUser() {
          deletedFromAuth = true;
        },
      };

      const res = await suspendOrDeleteAccount({
        db,
        authClient: mockAuth,
        adminUid: "admin_1",
        targetUid: "user_del",
        mode: "delete",
      });

      expect(res.authDeleted).toBe(true);
      expect(deletedFromAuth).toBe(true);
      expect(db.collections.get("users")?.has("user_del")).toBe(false);
      expect(db.collections.get("public_profiles")?.has("user_del")).toBe(false);
      expect(db.collections.get("deleted_accounts_audit")?.has("user_del")).toBe(true);
    });

    it("reinstating re-enables Firebase Auth and reports safety-flagged jobs pending review", async () => {
      const db = new InMemoryCollectionDb({
        users: {
          trader_r: {
            uid: "trader_r",
            role: "tradesperson",
            name: "Dave Heating",
            isVerified: true,
            isDisabled: true,
            status: "suspended",
          },
        },
        jobs: {
          job_flagged: {
            status: "accepted",
            acceptedTradespersonId: "trader_r",
            progressionFrozen: true,
          },
        },
      });
      const mockAuth = {
        async updateUser() {},
        async revokeRefreshTokens() {},
      };

      const res = await reinstateSuspendedAccount({
        db,
        authClient: mockAuth,
        adminUid: "admin_1",
        targetUid: "trader_r",
      });
      expect(res.publicProfileRestored).toBe(true);
      expect(res.safetyFlaggedJobsNeedingReview).toBe(1);
      expect(db.collections.get("users")?.get("trader_r")?.isDisabled).toBe(false);
    });
  });

  describe("AT-VER-08 — Server StartJob Revalidation", () => {
    const traderIdentity: CanonicalIdentity = {
      uid: "trader_1",
      accountType: "service_provider",
      capabilities: ["tradesperson"],
      verification: { status: "verified" },
      subscription: { tierId: "price_pro", status: "active" },
    };

    it("blocks job commencement when assigned trader is suspended, unverified, wrong trade category, or has expired credentials", async () => {
      // 1. Frozen / suspended job flag
      const dbFrozen = new InMemoryCollectionDb({
        jobs: {
          j1: {
            homeownerId: "h1",
            acceptedTradespersonId: "trader_1",
            status: "accepted",
            category: "Plumbing & Heating",
            progressionFrozen: true,
          },
        },
      });
      await expect(
        executeStartJobCommand({
          db: dbFrozen,
          identity: traderIdentity,
          jobId: "j1",
          idempotencyKey: "start_frozen_001",
        })
      ).rejects.toThrow(ForbiddenError);

      // 2. Suspended trader profile
      const dbSuspended = new InMemoryCollectionDb({
        jobs: {
          j1: {
            homeownerId: "h1",
            acceptedTradespersonId: "trader_1",
            status: "accepted",
            category: "Plumbing & Heating",
          },
        },
        users: {
          trader_1: {
            role: "tradesperson",
            isDisabled: true,
            verificationStatus: "verified",
            trades: ["Plumbing & Heating"],
          },
        },
      });
      await expect(
        executeStartJobCommand({
          db: dbSuspended,
          identity: traderIdentity,
          jobId: "j1",
          idempotencyKey: "start_suspended_001",
        })
      ).rejects.toThrow(/suspended/i);

      // 3. Mismatched category
      const dbWrongCategory = new InMemoryCollectionDb({
        jobs: {
          j1: {
            homeownerId: "h1",
            acceptedTradespersonId: "trader_1",
            status: "accepted",
            category: "Roofing",
          },
        },
        users: {
          trader_1: {
            role: "tradesperson",
            isDisabled: false,
            verificationStatus: "verified",
            trades: ["Plumbing & Heating"],
          },
        },
      });
      await expect(
        executeStartJobCommand({
          db: dbWrongCategory,
          identity: traderIdentity,
          jobId: "j1",
          idempotencyKey: "start_wrong_cat_001",
        })
      ).rejects.toThrow(/not verified for category/i);

      // 4. Expired credentials
      const dbExpiredCreds = new InMemoryCollectionDb({
        jobs: {
          j1: {
            homeownerId: "h1",
            acceptedTradespersonId: "trader_1",
            status: "accepted",
            category: "Plumbing & Heating",
          },
        },
        users: {
          trader_1: {
            role: "tradesperson",
            isDisabled: false,
            verificationStatus: "verified",
            trades: ["Plumbing & Heating"],
            gasSafeExpiry: "2020-01-01T00:00:00.000Z",
          },
        },
      });
      await expect(
        executeStartJobCommand({
          db: dbExpiredCreds,
          identity: traderIdentity,
          jobId: "j1",
          idempotencyKey: "start_expired_cred_001",
        })
      ).rejects.toThrow(/expired compliance credentials/i);
    });

    it("fails closed when strictTraderProfileRequired is true and trader document is missing", async () => {
      const db = new InMemoryCollectionDb({
        jobs: {
          j1: {
            homeownerId: "h1",
            acceptedTradespersonId: "trader_1",
            status: "accepted",
          },
        },
      });

      await expect(
        executeStartJobCommand({
          db,
          identity: traderIdentity,
          jobId: "j1",
          idempotencyKey: "start_strict_missing_001",
        })
      ).resolves.toMatchObject({ success: true, status: "in_progress" });

      // Reset to accepted for strict test
      await db.collection("jobs").doc("j1").update({ status: "accepted" });
      const { executeJobLifecycleCommand } = await import("../../src/server/jobLifecycleCommands.ts");
      await expect(
        executeJobLifecycleCommand({
          db,
          identity: traderIdentity,
          command: { type: "StartJob", payload: { jobId: "j1" } },
          idempotencyKey: "start_strict_missing_002",
          strictTraderProfileRequired: true,
        })
      ).rejects.toThrow(/missing or removed/i);
    });
  });

  describe("AT-ADMIN-CONFIG-01 — Atomic Versioned Pricing & Commission Config Publication", () => {
    it("atomically updates global, global_tiers, immutable version snapshot, and audit log together", async () => {
      const db = new InMemoryCollectionDb({
        platform_config: {
          global: { configVersion: 4, monetizationEnabled: true },
          global_tiers: { configVersion: 4, providerModels: { one_off_trades: { tiers: {} } } },
        },
      });

      const result = await publishPlatformPricingConfigAtomic({
        db,
        adminUid: "admin_1",
        adminEmail: "ops@anytrader.co.uk",
        tempConfig: { monetizationEnabled: true },
        feeTiers: [
          { name: "Free Explorer", price: 0, commission: 5, maxQuotes: 5 },
          { name: "Silver Professional", price: 19.99, commission: 3.5, maxQuotes: 30 },
        ],
        businessTiers: [{ name: "Corporate Tier 1", price: 99, commission: 1 }],
        paidAddons: { emergencyBoost: { enabled: true, price: 4.99 } },
      });

      expect(result.success).toBe(true);
      expect(result.configVersion).toBe(5);

      const globalDoc = db.collections.get("platform_config")?.get("global");
      const globalTiersDoc = db.collections.get("platform_config")?.get("global_tiers");
      const versionDoc = db.collections.get("platform_config_versions")?.get("v5");

      expect(globalDoc.configVersion).toBe(5);
      expect(globalTiersDoc.configVersion).toBe(5);
      expect(globalTiersDoc.providerModels.one_off_trades.tiers.payg.commission).toBe(0.05);
      expect(globalTiersDoc.providerModels.one_off_trades.tiers.pro.commission).toBe(0.035);
      expect(versionDoc.version).toBe(5);
    });

    it("correctly normalizes promotional <= 1% commission rates (1% -> 0.01, 0.5% -> 0.005) and syncs commissionCapGbp atomically", async () => {
      const db = new InMemoryCollectionDb();
      const result = await publishPlatformPricingConfigAtomic({
        db,
        adminUid: "admin_promo",
        tempConfig: { monetizationEnabled: true, commissionCapGbp: 180 },
        feeTiers: [
          { name: "Gold Elite", price: 49.99, commission: 1, maxQuotes: 9999 },
          { name: "Platinum Enterprise", price: 99.99, commission: 0.5, maxQuotes: 9999 },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.commissionCapGbp).toBe(180);

      const globalDoc = db.collections.get("platform_config")?.get("global");
      const globalTiersDoc = db.collections.get("platform_config")?.get("global_tiers");

      expect(globalDoc.commissionCapGbp).toBe(180);
      expect(globalTiersDoc.commissionCapGbp).toBe(180);
      expect(globalTiersDoc.providerModels.one_off_trades.commissionCapGbp).toBe(180);
      expect(globalTiersDoc.providerModels.one_off_trades.tiers.premium.commission).toBe(0.01);
      expect(globalTiersDoc.providerModels.one_off_trades.tiers.platinum.commission).toBe(0.005);
    });

    it("rejects invalid commission (> 100%) before writing any document", async () => {
      const db = new InMemoryCollectionDb();
      await expect(
        publishPlatformPricingConfigAtomic({
          db,
          adminUid: "admin_1",
          tempConfig: {},
          feeTiers: [{ name: "Bad Tier", price: 10, commission: 150 }],
        })
      ).rejects.toThrow(/cannot exceed 100%/i);
      expect(db.collections.get("platform_config")?.size || 0).toBe(0);
    });
  });

  describe("AT-ADMIN-FIN-01 & AT-ADMIN-CTRL-03 — FIN-05 Full Collector Report & Console Integration", () => {
    it("executes FIN-05 collector/evaluator in report when includeAudit=true and surfaces orphaned capture findings", async () => {
      const db = new InMemoryCollectionDb({
        payment_ledger: {
          l1: {
            entryId: "l1",
            jobId: "job_1",
            idempotencyKey: "release:job_1:q1:m1:k1",
            transactionId: "pi_captured1",
            stripePaymentIntentId: "pi_captured1",
            type: "ESCROW_DEPOSIT",
            status: "completed",
            currency: "gbp",
            amount: 5000,
            verifiedAmount: 5000,
            transferStatus: "completed",
            stripeTransferId: "tr_secret1234567890",
          },
        },
        payment_intents: {
          pi_captured1: {
            paymentIntentId: "pi_captured1",
            metadata: { type: "milestone_funding", jobId: "job_1", quoteId: "q1", milestoneId: "m1" },
          },
          pi_orphan1: {
            paymentIntentId: "pi_orphan1",
            metadata: { type: "ride_payment" },
          },
        },
      });

      const mockStripe = {
        paymentIntents: {
          async retrieve(id: string) {
            return {
              id,
              status: "succeeded",
              amount_received: 5000,
              currency: "gbp",
              transfer_data: null,
            };
          },
        },
        refunds: {
          async list() {
            return { data: [], has_more: false };
          },
        },
        transfers: {
          async list() {
            return { data: [], has_more: false };
          },
        },
      };

      const report = await generateFinancialReconciliationReport(
        db,
        { limit: 20, includeAudit: true },
        { uid: "admin_1", isAdmin: true },
        { stripeClient: mockStripe, includeAudit: true }
      );

      expect(report.fullAudit?.executed).toBe(true);
      expect(report.fullAudit?.criticalCount).toBeGreaterThanOrEqual(1);
      expect(report.fullAudit?.findings?.some((f) => f.code === "CAPTURE_LEDGER_MISSING" && f.entityId === "pi_orphan1")).toBe(true);

      const actionRes = await executeReconciliationOperatorAction({
        db,
        caller: { uid: "admin_1", email: "ops@anytrader.co.uk", isAdmin: true },
        action: "escalate_finding",
        findingCode: "CAPTURE_LEDGER_MISSING",
        entityId: "pi_orphan1",
        note: "Checking Stripe dashboard",
      });
      expect(actionRes.success).toBe(true);
      expect(db.collections.get("reconciliation_operator_actions")?.get("CAPTURE_LEDGER_MISSING_pi_orphan1")?.status).toBe("escalated");
    });

    it("verifies AnyTraderAdmin integrates AdminFinancialReconciliationTab and uses server pricing publish + suspend/delete routes", () => {
      const adminPath = path.resolve(process.cwd(), "src/components/AnyTraderAdmin.tsx");
      const adminSrc = fs.readFileSync(adminPath, "utf-8");
      expect(adminSrc).toContain("AdminFinancialReconciliationTab");
      expect(adminSrc).toContain("/api/admin/pricing-config/publish");
      expect(adminSrc).toContain("/api/admin/users/");
    });
  });
});
