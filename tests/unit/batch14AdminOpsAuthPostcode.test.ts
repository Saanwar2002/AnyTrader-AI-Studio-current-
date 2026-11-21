import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  resolveAdminCapabilityTier,
  assertAdminCapability,
  createDualControlApprovalRequest,
  reviewDualControlApprovalRequest,
  consumeDualControlApproval,
  enqueueAdminBroadcastCommand,
  upsertFeatureFlagCommand,
  listFeatureFlagsCommand,
  getOperationalHealthSnapshot,
} from "../../src/server/adminGovernance.ts";
import { FirestoreRateLimitStore } from "../../src/server/distributedRateLimit.ts";
import {
  processSmsQueueCommand,
  runConsultancyRecurringSessionCreatorCommand,
  runConsultancyScoreRecalculatorCommand,
  buildCronDispatchResponse,
  fetchPostcodeWithTimeout,
} from "../../src/server/cronWorkers.ts";
import {
  acquireSchedulerLock,
  renewSchedulerLeaseHeartbeat,
} from "../../src/server/schedulerLock.ts";
import { executeDriverPayoutOrchestrationCommand } from "../../src/server/driverPayoutOrchestration.ts";
import {
  executeAuthoritativeAccountLinking,
  evaluateAccountLinkingEligibility,
} from "../../src/server/ssoClaimIntegrity.ts";
import { runProductionChecks, EXPECTED_PRODUCTION_DATABASE_ID } from "../../src/server/productionChecks.ts";
import { ServiceUnavailableError, ForbiddenError } from "../../src/server/httpErrors.ts";

function createInMemoryFirestore(initial: Record<string, Record<string, any>> = {}) {
  const store: Record<string, Map<string, any>> = {};
  for (const [col, docs] of Object.entries(initial)) {
    store[col] = new Map(Object.entries(docs));
  }
  let autoId = 1;

  const ensureCol = (col: string) => {
    if (!store[col]) store[col] = new Map();
    return store[col];
  };

  const makeDocRef = (col: string, id: string) => ({
    id,
    get: async () => {
      const m = ensureCol(col);
      const exists = m.has(id);
      return {
        id,
        exists,
        data: () => (exists ? { ...m.get(id) } : undefined),
      };
    },
    set: async (data: any, opts?: { merge?: boolean }) => {
      const m = ensureCol(col);
      if (opts?.merge && m.has(id)) {
        m.set(id, { ...m.get(id), ...data });
      } else {
        m.set(id, { ...data });
      }
    },
    update: async (patch: any) => {
      const m = ensureCol(col);
      const existing = m.get(id) || {};
      m.set(id, { ...existing, ...patch });
    },
    delete: async () => {
      ensureCol(col).delete(id);
    },
  });

  const makeQuery = (
    col: string,
    filters: Array<{ field: string; op: string; value: any }> = [],
    lim?: number
  ) => ({
    where: (field: string, op: string, value: any) =>
      makeQuery(col, [...filters, { field, op, value }], lim),
    limit: (n: number) => makeQuery(col, filters, n),
    get: async () => {
      const m = ensureCol(col);
      let entries = Array.from(m.entries()).filter(([, data]) =>
        filters.every((f) => {
          if (f.op === "==") return data?.[f.field] === f.value;
          return true;
        })
      );
      if (typeof lim === "number") entries = entries.slice(0, lim);
      const docs = entries.map(([id, data]) => ({
        id,
        ref: makeDocRef(col, id),
        data: () => ({ ...data }),
      }));
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  });

  const db = {
    _store: store,
    collection: (col: string) => ({
      doc: (id?: string) => makeDocRef(col, id || `auto_${autoId++}`),
      add: async (data: any) => {
        const id = `auto_${autoId++}`;
        ensureCol(col).set(id, { ...data });
        return makeDocRef(col, id);
      },
      where: (field: string, op: string, value: any) =>
        makeQuery(col, [{ field, op, value }]),
      limit: (n: number) => makeQuery(col, [], n),
      get: async () => makeQuery(col).get(),
    }),
    runTransaction: async (fn: (tx: any) => Promise<any>) => {
      const tx = {
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, patch: any) => ref.update(patch),
      };
      return await fn(tx);
    },
  };

  return db;
}

describe("Batch 14 — Admin Governance, Schedulers, Rate Limits, Email/SMS & Preflight", () => {
  it("AT-ADMIN-AUDIT-02: persists initiating admin UID, email, timestamp, and reason on driver payout batches and audit logs", async () => {
    const db = createInMemoryFirestore();
    const res = await executeDriverPayoutOrchestrationCommand({
      db,
      initiatedBy: {
        uid: "admin_fin_1",
        email: "finance@anytrader.uk",
        triggerSource: "manual_admin",
        reason: "End-of-week manual driver reconciliation run",
        approvalRequestId: "apr_42",
      },
    });

    expect(res.success).toBe(true);
    expect(res.batchId).toBeTruthy();

    const batchDoc = db._store["driver_payout_batches"]?.get(res.batchId!);
    expect(batchDoc).toBeDefined();
    expect(batchDoc.initiatedByUid).toBe("admin_fin_1");
    expect(batchDoc.initiatedByEmail).toBe("finance@anytrader.uk");
    expect(batchDoc.reason).toBe("End-of-week manual driver reconciliation run");
    expect(batchDoc.approvalRequestId).toBe("apr_42");
    expect(batchDoc.initiatedAt).toBeTruthy();

    const auditEntries = Array.from(db._store["admin_audit_logs"]?.values() || []);
    expect(auditEntries.some((a) => a.action === "MANUAL_DRIVER_PAYOUT_BATCH" && a.adminUid === "admin_fin_1")).toBe(true);
  });

  it("AT-ADMIN-AUTH-01: enforces admin capability tiers and four-eyes dual-control approval workflow", async () => {
    expect(resolveAdminCapabilityTier({ adminTier: "support_readonly" }, null)).toBe("support_readonly");
    expect(resolveAdminCapabilityTier({ adminTier: "financial_operator" }, null)).toBe("financial_operator");
    expect(resolveAdminCapabilityTier({ isSuperAdmin: true }, null)).toBe("super_admin");

    expect(() =>
      assertAdminCapability({ uid: "s1", tier: "support_readonly" }, "financial_operator", "payout")
    ).toThrow(ForbiddenError);

    const db = createInMemoryFirestore();
    const op1 = { uid: "op_1", email: "op1@anytrader.uk", tier: "financial_operator" as const };
    const op2 = { uid: "op_2", email: "op2@anytrader.uk", tier: "super_admin" as const };

    const created = await createDualControlApprovalRequest(db, op1, {
      actionType: "manual_driver_payout_batch",
      reason: "High-value £1200 weekend payout batch",
      amountGbp: 1200,
    });
    expect(created.status).toBe("pending_second_approval");

    // Self-approval MUST fail closed
    await expect(
      reviewDualControlApprovalRequest(db, op1, created.requestId, "approved", "self approving")
    ).rejects.toThrow(ForbiddenError);

    // Independent second operator can approve
    const reviewed = await reviewDualControlApprovalRequest(db, op2, created.requestId, "approved", "verified ledger");
    expect(reviewed.status).toBe("approved");

    // Consuming approved request succeeds once and cannot be replayed
    const consumed = await consumeDualControlApproval(db, created.requestId, "manual_driver_payout_batch", op1);
    expect(consumed.reviewedByUid).toBe("op_2");

    await expect(
      consumeDualControlApproval(db, created.requestId, "manual_driver_payout_batch", op1)
    ).rejects.toThrow(ForbiddenError);
  });

  it("AT-ADMIN-CTRL-04: dispatches admin broadcasts through a bounded server fan-out queue with honest channel receipts", async () => {
    const db = createInMemoryFirestore({
      users: {
        u1: { role: "homeowner", email: "h1@example.com" },
        u2: { role: "tradesperson", trades: ["Plumbing"], phone: "+447700900001" },
        u3: { role: "tradesperson", trades: ["Electrical"], phone: "+447700900002" },
      },
    });

    const result = await enqueueAdminBroadcastCommand(
      db,
      { uid: "admin_1", email: "ops@anytrader.uk", tier: "super_admin" },
      {
        title: "Scheduled System Upgrade",
        content: "Brief maintenance window tonight at 02:00 GMT.",
        targetSegments: ["homeowners", "tradespeople"],
        targetTrades: ["Plumbing"],
        channels: { inApp: true, email: true, sms: true },
      },
      {} // No Twilio / Resend configured
    );

    expect(result.totalMatched).toBe(2); // u1 (homeowner) + u2 (Plumbing trader)
    expect(result.sentCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.channelStatuses.inApp).toBe("sent");
    expect(result.channelStatuses.email).toBe("skipped_no_provider");
    expect(result.channelStatuses.sms).toBe("skipped_no_provider");
    expect(db._store["broadcast_fanout_jobs"]?.get(result.broadcastId)?.totalMatched).toBe(2);
  });

  it("AT-ADMIN-CTRL-05: admin views use bounded/paginated Firestore queries with no unbounded users/jobs/rides listeners", () => {
    const adminFiles = [
      "src/components/AnyTraderAdmin.tsx",
      "src/components/MasterAdminLayout.tsx",
      "src/components/AnyRollerAdmin.tsx",
      "src/components/anyroller/RidersList.tsx",
      "src/components/anyroller/DriversList.tsx",
      "src/components/anyroller/VehicleManagement.tsx",
      "src/components/anyroller/ZonesGeofences.tsx",
    ];
    for (const rel of adminFiles) {
      const content = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(content).not.toMatch(/onSnapshot\(\s*collection\(\s*db\s*,\s*"(users|jobs|ride_requests|invitations)"\s*\)/);
    }
  });

  it("AT-ADMIN-CTRL-06: aggregates failed webhooks, stuck payout leases, queue backlogs, and kill switches into unified health snapshot", async () => {
    const now = Date.now();
    const db = createInMemoryFirestore({
      stripe_webhook_events: {
        evt_1: { status: "failed", type: "payment_intent.succeeded", lastError: "timeout" },
      },
      ride_requests: {
        ride_stuck: { payoutStatus: "processing", assignedDriverId: "drv_1", payoutLockedAt: now - 600_000 },
        ride_fresh: { payoutStatus: "processing", assignedDriverId: "drv_2", payoutLockedAt: now - 30_000 },
      },
      sms_queue: {
        sms_1: { status: "failed_unconfigured" },
      },
      platform_config: {
        global: { maintenanceMode: true, paywallEnabled: true },
        rides: { autoDispatchEnabled: true, surgeEnabled: false },
      },
    });

    const health = await getOperationalHealthSnapshot(db, now);
    expect(health.overallSeverity).toBe("critical");
    expect(health.failedWebhooks.count).toBe(1);
    expect(health.stuckPayoutLeases.count).toBe(1);
    expect(health.stuckPayoutLeases.items[0].rideId).toBe("ride_stuck");
    expect(health.queueBacklogs.smsUnconfigured).toBe(1);
    expect(health.killSwitches.maintenanceMode).toBe(true);
    expect(health.incidents.some((i) => i.category === "webhook")).toBe(true);
    expect(health.incidents.some((i) => i.category === "payout_lease")).toBe(true);
  });

  it("AT-ADMIN-CONFIG-02: creates versioned platform_feature_flags with immutable history and environment rollout toggles", async () => {
    const db = createInMemoryFirestore();
    const superAdmin = { uid: "sa_1", email: "root@anytrader.uk", tier: "super_admin" as const };

    const v1 = await upsertFeatureFlagCommand(db, superAdmin, "instant_dispatch_v2", {
      enabled: true,
      description: "Enable instant dispatch v2",
      environments: { development: true, staging: true, production: false },
      rolloutPercentage: 25,
      reason: "Initial staging rollout",
    });
    expect(v1.version).toBe(1);
    expect(v1.environments.production).toBe(false);

    const v2 = await upsertFeatureFlagCommand(db, superAdmin, "instant_dispatch_v2", {
      enabled: true,
      environments: { development: true, staging: true, production: true },
      rolloutPercentage: 100,
      reason: "Promote to production",
    });
    expect(v2.version).toBe(2);
    expect(v2.environments.production).toBe(true);

    const listed = await listFeatureFlagsCommand(db);
    expect(listed.flags.length).toBe(1);
    expect(listed.recentHistory.length).toBe(2);
  });

  it("AT-ADMIN-OPS-02: scheduler lock acquisition and heartbeat fail closed on storage/transaction errors", async () => {
    const brokenDb = {
      collection: () => ({ doc: () => ({}) }),
      runTransaction: async () => {
        throw new Error("Firestore DEADLINE_EXCEEDED");
      },
    };

    const acq = await acquireSchedulerLock(brokenDb, "driver_payouts", 60_000);
    expect(acq.acquired).toBe(false);
    expect(acq.reason).toBe("lock_acquisition_error");
    expect(acq.error).toContain("DEADLINE_EXCEEDED");

    const hb = await renewSchedulerLeaseHeartbeat(brokenDb, "driver_payouts", "lease_tok_1", 60_000);
    expect(hb.renewed).toBe(false);
    expect(hb.fencedOut).toBe(true);
  });

  it("AT-ADMIN-OPS-03: SMS queue marks unconfigured items failed_unconfigured/skipped_no_provider and sends real Twilio when configured", async () => {
    const dbUnconfigured = createInMemoryFirestore({
      sms_queue: {
        msg1: { status: "pending", to: "+447700900111", body: "Hello trader" },
      },
    });
    const unconfRes = await processSmsQueueCommand({ db: dbUnconfigured, env: {} });
    expect(unconfRes.status).toBe("skipped");
    expect(unconfRes.skippedCount).toBe(1);
    expect(dbUnconfigured._store["sms_queue"].get("msg1").status).toBe("failed_unconfigured");
    expect(dbUnconfigured._store["sms_queue"].get("msg1").providerStatus).toBe("skipped_no_provider");

    const dbConfigured = createInMemoryFirestore({
      sms_queue: {
        msg2: { status: "pending", to: "+447700900222", body: "Job booked" },
      },
    });
    const createMock = vi.fn(async () => ({ sid: "SM_REAL_123", status: "queued" }));
    const confRes = await processSmsQueueCommand({
      db: dbConfigured,
      env: {
        TWILIO_ACCOUNT_SID: "AC1234567890abcdef",
        TWILIO_AUTH_TOKEN: "auth_token_1234567890",
        TWILIO_PHONE_NUMBER: "+441234567890",
      },
      twilioFactory: () => ({ messages: { create: createMock } }),
    });
    expect(confRes.status).toBe("executed");
    expect(confRes.executedCount).toBe(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(dbConfigured._store["sms_queue"].get("msg2").twilioSid).toBe("SM_REAL_123");
  });

  it("AT-ADMIN-OPS-05: cron dispatcher reports real worker counts and never reports skipped/failed workers as executed successfully", () => {
    const skippedLock = buildCronDispatchResponse("sms_queue", {
      acquired: false,
      fencedOut: false,
      reason: "lock_held",
    });
    expect(skippedLock.body.success).toBe(false);
    expect(skippedLock.body.executed).toBe(false);
    expect(skippedLock.body.status).toBe("skipped");

    const failedWorker = buildCronDispatchResponse("match_scores", {
      acquired: true,
      fencedOut: false,
      result: {
        worker: "match_scores",
        status: "failed",
        executedCount: 0,
        skippedCount: 0,
        failedCount: 2,
        errors: ["write error 1", "write error 2"],
      },
    });
    expect(failedWorker.httpStatus).toBe(500);
    expect(failedWorker.body.success).toBe(false);
    expect(failedWorker.body.executed).toBe(false);
    expect(failedWorker.body.failedCount).toBe(2);
    expect(failedWorker.body.errors.length).toBe(2);
  });

  it("AT-ADMIN-OPS-06: FirestoreRateLimitStore shares distributed counter state across multiple store instances", async () => {
    const db = createInMemoryFirestore();
    const instanceA = new FirestoreRateLimitStore({ prefix: "ai", windowMs: 60_000, getDb: () => db });
    const instanceB = new FirestoreRateLimitStore({ prefix: "ai", windowMs: 60_000, getDb: () => db });

    const r1 = await instanceA.increment("user_42");
    const r2 = await instanceB.increment("user_42");
    const r3 = await instanceA.increment("user_42");

    expect(r1.totalHits).toBe(1);
    expect(r2.totalHits).toBe(2);
    expect(r3.totalHits).toBe(3);
  });

  it("AT-ADMIN-OPS-07: requireAuth and aiLimiter execute BEFORE the 10MB JSON body parser on /api/gemini/call", () => {
    const serverSrc = fs.readFileSync(path.join(process.cwd(), "server.ts"), "utf8");
    expect(serverSrc).not.toContain('app.use("/api/gemini/call", express.json({ limit: "10mb" }))');
    expect(serverSrc).toContain('app.post("/api/gemini/call", requireAuth, aiLimiter, geminiJsonParser');
  });

  it("AT-ADMIN-PROD-AUDIT-01: runProductionChecks enforces CRON_SECRET, JWT_SECRET, STRIPE_WEBHOOK_SECRET format, and named DB ID", () => {
    const reportMissing = runProductionChecks(
      {
        NODE_ENV: "production",
        STRIPE_SECRET_KEY: "sk_live_1234567890abcdef",
        STRIPE_WEBHOOK_SECRET: "not_a_whsec_secret_123",
        GEMINI_API_KEY: "AIzaSy_1234567890abcdef",
        APP_URL: "https://anytrader.uk",
        ALLOWED_ORIGINS: "https://anytrader.uk",
        FIRESTORE_DATABASE_ID: "(default)",
      } as any,
      { collection: () => {} }
    );
    expect(reportMissing.overallStatus).toBe("NO_GO");
    expect(reportMissing.checks.some((c) => c.name === "Env Check: CRON_SECRET" && c.status === "FAIL")).toBe(true);
    expect(reportMissing.checks.some((c) => c.name === "Env Check: JWT_SECRET" && c.status === "FAIL")).toBe(true);
    expect(reportMissing.checks.some((c) => c.name === "Stripe Webhook Secret Format" && c.status === "FAIL")).toBe(true);
    expect(reportMissing.checks.some((c) => c.name === "Named Firestore Database Configuration" && c.status === "FAIL")).toBe(true);

    const reportHealthy = runProductionChecks(
      {
        NODE_ENV: "production",
        STRIPE_SECRET_KEY: "sk_live_1234567890abcdef",
        STRIPE_WEBHOOK_SECRET: "whsec_1234567890abcdef",
        GEMINI_API_KEY: "AIzaSy_1234567890abcdef",
        JWT_SECRET: "super_secure_sso_jwt_secret_12345",
        CRON_SECRET: "super_secure_cron_secret_12345",
        APP_URL: "https://anytrader.uk",
        ALLOWED_ORIGINS: "https://anytrader.uk",
        FIRESTORE_DATABASE_ID: EXPECTED_PRODUCTION_DATABASE_ID,
      } as any,
      { collection: () => {} }
    );
    expect(reportHealthy.overallStatus).toBe("GO");
  });

  it("AT-CONS-SCHED-01: consultancy schedulers materialize recurring events, recalculate consultant scores, and propagate errors visibly", async () => {
    const now = Date.now();
    const db = createInMemoryFirestore({
      calendarEvents: {
        ev_1: {
          isRecurring: true,
          consultantId: "cons_1",
          title: "Weekly Compliance Check",
          nextOccurrenceAt: new Date(now + 2 * 86_400_000).toISOString(),
          recurrenceIntervalDays: 7,
        },
      },
      users: {
        cons_1: { role: "consultant", rating: 4.8, reviewCount: 10, verified: true, responseRate: 95 },
      },
    });

    const recSummary = await runConsultancyRecurringSessionCreatorCommand(db, { nowMs: now });
    expect(recSummary.status).toBe("executed");
    expect(recSummary.executedCount).toBe(1);

    const scoreSummary = await runConsultancyScoreRecalculatorCommand(db, { nowMs: now });
    expect(scoreSummary.status).toBe("executed");
    expect(scoreSummary.executedCount).toBe(1);
    expect(db._store["users"].get("cons_1").consultancyMatchScore).toBeGreaterThan(80);

    // Propagates errors visibly instead of returning stubbed success
    const failingDb = {
      collection: () => ({
        where: () => ({
          limit: () => ({
            get: async () => {
              throw new Error("Firestore unavailable");
            },
          }),
        }),
      }),
    };
    const failSummary = await runConsultancyScoreRecalculatorCommand(failingDb);
    expect(failSummary.status).toBe("failed");
    expect(failSummary.errors[0]).toContain("Firestore unavailable");
  });

  it("AT-AUTH-LINK-01: returns 503 ServiceUnavailableError when Firestore is unavailable during OAuth provider linking", async () => {
    await expect(
      executeAuthoritativeAccountLinking({
        db: null,
        caller: { uid: "u_link_1", email: "user@example.com" },
        providerCredential: "signed_token",
        verifierFn: async () => ({
          providerId: "google",
          sub: "sub_google_123",
          email: "user@example.com",
          email_verified: true,
        }),
      })
    ).rejects.toThrow(ServiceUnavailableError);

    await expect(
      evaluateAccountLinkingEligibility(
        null,
        { uid: "u_link_1", email: "user@example.com" },
        {},
        { providerId: "google", sub: "sub_google_123", email: "user@example.com", email_verified: true }
      )
    ).rejects.toThrow(ServiceUnavailableError);
  });

  it("AT-POSTCODE-01: AbortController timeout covers both fetch AND response.json() body consumption", async () => {
    const stallingFetch = (async (_url: any, _init: any) => ({
      status: 200,
      ok: true,
      json: () => new Promise(() => {}), // Stalls indefinitely after headers arrive
    })) as unknown as typeof fetch;

    await expect(fetchPostcodeWithTimeout("SW1A1AA", stallingFetch, 40)).rejects.toMatchObject({
      name: "AbortError",
    });

    const fastFetch = (async () => ({
      status: 200,
      ok: true,
      json: async () => ({ status: 200, result: { postcode: "SW1A 1AA" } }),
    })) as unknown as typeof fetch;

    const okRes = await fetchPostcodeWithTimeout("SW1A1AA", fastFetch, 1000);
    expect(okRes.status).toBe(200);
    expect(okRes.data.result.postcode).toBe("SW1A 1AA");
  });
});
