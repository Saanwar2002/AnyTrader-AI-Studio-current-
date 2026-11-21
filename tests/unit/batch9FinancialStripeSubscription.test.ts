import fs from "fs";
import path from "path";
import crypto from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  reconcilePaymentRefundAggregates,
} from "../../src/server/refundReconciliation.ts";
import {
  evaluateFinancialReconciliation,
} from "../../src/server/financialReconciliation.ts";
import {
  collectFinancialReconciliationSnapshot,
} from "../../src/server/financialReconciliationCollector.ts";
import {
  assertPayoutEligibleRole,
  ensureStripeAccountForProvider,
  ensureStripeCustomerIdForUser,
  reconcileStripeAccountUpdatedWebhook,
} from "../../src/server/stripeConnectHelpers.ts";
import {
  transitionCheckoutIntentState,
  sweepStaleCheckoutIntents,
} from "../../src/server/checkoutIntentIntegrity.ts";
import {
  resolveVerifiedSubscriptionTarget,
} from "../../src/server/stripeSubscriptionGuards.ts";
import { ConflictError, ForbiddenError } from "../../src/server/httpErrors.ts";

function createInMemoryDb(initial: Record<string, Record<string, any>> = {}) {
  const store: Record<string, Map<string, any>> = {};
  for (const [col, docs] of Object.entries(initial)) {
    store[col] = new Map(Object.entries(docs).map(([k, v]) => [k, structuredClone(v)]));
  }
  const ensureCol = (name: string) => {
    if (!store[name]) store[name] = new Map();
    return store[name];
  };

  let autoCounter = 0;
  const makeDocRef = (col: string, id: string): any => ({
    id,
    path: `${col}/${id}`,
    get: async () => {
      const data = ensureCol(col).get(id);
      return {
        id,
        ref: makeDocRef(col, id),
        exists: data !== undefined,
        data: () => (data !== undefined ? structuredClone(data) : undefined),
      };
    },
    set: async (data: any, opts?: { merge?: boolean }) => {
      const prev = ensureCol(col).get(id);
      if (opts?.merge && prev) {
        ensureCol(col).set(id, { ...prev, ...structuredClone(data) });
      } else {
        ensureCol(col).set(id, structuredClone(data));
      }
    },
    update: async (patch: any) => {
      const prev = ensureCol(col).get(id);
      if (!prev) throw new Error(`Doc ${col}/${id} does not exist`);
      ensureCol(col).set(id, { ...prev, ...structuredClone(patch) });
    },
  });

  const makeQuery = (col: string, filters: Array<[string, string, any]> = [], limitN?: number): any => ({
    where: (f: string, op: string, v: any) => makeQuery(col, [...filters, [f, op, v]], limitN),
    orderBy: () => makeQuery(col, filters, limitN),
    limit: (n: number) => makeQuery(col, filters, n),
    startAfter: (cursorDoc: any) => makeQuery(col, [...filters, ["__startAfter__", ">", cursorDoc.id]], limitN),
    get: async () => {
      let entries = [...ensureCol(col).entries()].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [f, op, v] of filters) {
        if (f === "__startAfter__") {
          const idx = entries.findIndex(([id]) => id === v);
          if (idx >= 0) entries = entries.slice(idx + 1);
          continue;
        }
        if (op === "==") {
          entries = entries.filter(([, d]) => d?.[f] === v);
        }
      }
      if (typeof limitN === "number") entries = entries.slice(0, limitN);
      return {
        empty: entries.length === 0,
        size: entries.length,
        docs: entries.map(([id, d]) => ({
          id,
          ref: makeDocRef(col, id),
          exists: true,
          data: () => structuredClone(d),
        })),
      };
    },
  });

  const db: any = {
    _store: store,
    collection: (name: string) => ({
      ...makeQuery(name),
      doc: (id?: string) => {
        const docId = id || `auto_${++autoCounter}`;
        return makeDocRef(name, docId);
      },
      add: async (data: any) => {
        const docId = `auto_${++autoCounter}`;
        ensureCol(name).set(docId, structuredClone(data));
        return makeDocRef(name, docId);
      },
    }),
    runTransaction: async (fn: (tx: any) => Promise<any>) => {
      const tx = {
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        create: (ref: any, data: any) => ref.set(data),
        update: (ref: any, patch: any) => ref.update(patch),
      };
      return fn(tx);
    },
  };
  return db;
}

describe("Batch 9: Financial Reconciliation, Stripe Connect & Subscriptions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("AT-PAY-07: reconciles payment_refund_totals against Stripe refunds and repairs missing records/drift", async () => {
    const pi = "pi_abc123456";
    const hash = crypto.createHash("sha256").update(pi).digest("hex").slice(0, 32);
    const db = createInMemoryDb({
      payment_ledger: {
        ledg_orig_1: {
          entryId: "ledg_orig_1",
          transactionId: pi,
          amount: 10000,
          currency: "gbp",
          type: "ESCROW_DEPOSIT",
          status: "completed",
          payerId: "cust_1",
          payeeId: "trader_1",
        },
      },
      payment_refund_totals: {
        [hash]: {
          paymentIntentId: pi,
          originalLedgerEntryId: "ledg_orig_1",
          originalAmountPence: 10000,
          refundedAmountPence: 2000, // Stale drifted total
          remainingAmountPence: 8000,
          currency: "gbp",
        },
      },
    });

    const stripeClient = {
      refunds: {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: "re_1", amount: 2000, currency: "gbp", status: "succeeded", charge: "ch_1" },
            { id: "re_2", amount: 3000, currency: "gbp", status: "succeeded", charge: "ch_1" },
          ],
          has_more: false,
        }),
      },
    };

    const report = await reconcilePaymentRefundAggregates(db, stripeClient);
    expect(report.scanned).toBe(1);
    expect(report.newlyRecordedRefunds).toBe(2);
    expect(report.driftDetectedCount).toBe(1);
    expect(report.repairedCount).toBe(1);
    const totalDoc = db._store.payment_refund_totals.get(hash);
    expect(totalDoc.refundedAmountPence).toBe(5000);
    expect(totalDoc.remainingAmountPence).toBe(5000);
    expect(db._store.refund_records.has("re_1")).toBe(true);
    expect(db._store.refund_records.has("re_2")).toBe(true);
    expect(db._store.refund_reconciliation_audits.size).toBe(1);

    // Now simulate out-of-band drift in aggregate without missing record -> direct repair + second audit
    await db.collection("payment_refund_totals").doc(hash).update({ refundedAmountPence: 1000, remainingAmountPence: 9000 });
    const repairReport = await reconcilePaymentRefundAggregates(db, stripeClient);
    expect(repairReport.driftDetectedCount).toBe(1);
    expect(repairReport.repairedCount).toBe(1);
    expect(db._store.payment_refund_totals.get(hash).refundedAmountPence).toBe(5000);
    expect(db._store.refund_reconciliation_audits.size).toBe(2);
  });

  it("AT-PAY-08: surfaces TRANSFER_REVERSED and CONNECT_PAYOUT_FAILED in evaluator & collector", async () => {
    const evalReport = evaluateFinancialReconciliation({
      ledger: [
        {
          entryId: "ledg_rel_1",
          stripeTransferId: "tr_rev_1",
          jobId: "job_1",
          quoteId: "quote_1",
          milestoneId: "m1",
          amount: 5000,
          currency: "gbp",
          type: "ESCROW_RELEASE",
          status: "completed",
        },
      ],
      transfers: [
        {
          transferId: "tr_rev_1",
          amount: 5000,
          currency: "gbp",
          destination: "acct_tr1",
          reversed: true,
          amountReversed: 5000,
          reversalIds: ["trr_1"],
        },
      ],
      connectPayouts: [
        {
          payoutId: "po_fail_1",
          stripeAccountId: "acct_tr1",
          amount: 5000,
          currency: "gbp",
          status: "failed",
          failureCode: "account_closed",
        },
      ],
    });

    const codes = evalReport.findings.map((f) => f.code);
    expect(codes).toContain("TRANSFER_REVERSED");
    expect(codes).toContain("CONNECT_PAYOUT_FAILED");

    // Collector integration check with stripe.payouts.list
    const collectorDb: any = {
      collection: (col: string) => {
        const makeQ = (docs: any[]): any => ({
          orderBy: () => makeQ(docs),
          limit: () => makeQ(docs),
          startAfter: () => makeQ([]),
          get: async () => ({ docs }),
        });
        if (col === "driver_payout_operations") {
          return {
            ...makeQ([
              {
                id: "op_1",
                data: () => ({
                  operationId: "op_1",
                  stripeTransferId: "tr_1",
                  stripeAccountId: "acct_123456",
                  amountPence: 4400,
                  currency: "gbp",
                  status: "completed",
                }),
              },
            ]),
            doc: () => ({ collection: () => makeQ([]) }),
          };
        }
        return { ...makeQ([]), doc: () => ({ collection: () => makeQ([]) }) };
      },
    };
    const collectorStripe: any = {
      paymentIntents: { retrieve: vi.fn() },
      refunds: { list: vi.fn() },
      transfers: {
        list: vi.fn().mockResolvedValue({
          data: [
            {
              id: "tr_1",
              amount: 4400,
              currency: "gbp",
              destination: "acct_123456",
              reversed: true,
              amount_reversed: 4400,
              reversals: { data: [{ id: "trr_99" }] },
              metadata: { type: "orchestrated_driver_payout" },
            },
          ],
          has_more: false,
        }),
      },
      payouts: {
        list: vi.fn().mockResolvedValue({
          data: [
            {
              id: "po_bank_fail",
              amount: 4400,
              currency: "gbp",
              status: "canceled",
              failure_code: "insufficient_funds",
            },
          ],
          has_more: false,
        }),
      },
    };

    const collected = await collectFinancialReconciliationSnapshot(collectorDb, collectorStripe);
    expect(collected.snapshot.transfers?.[0].reversed).toBe(true);
    expect(collected.snapshot.transfers?.[0].reversalIds).toEqual(["trr_99"]);
    expect(collected.snapshot.connectPayouts?.[0].status).toBe("canceled");
    expect(collected.coverage.stripeConnectPayoutPages).toBe(1);
  });

  it("AT-PAY-10: syncs Stripe Connect account.updated capabilities into users & driver_profiles and blocks out-of-order events", async () => {
    const db = createInMemoryDb({
      users: {
        drv_1: {
          uid: "drv_1",
          role: "driver",
          isDriver: true,
          stripeAccountId: "acct_drv_1",
          payoutsEnabled: false,
          stripeAccountLastEventCreated: 2000,
        },
      },
      driver_profiles: {
        drv_1: {
          uid: "drv_1",
          stripeAccountId: "acct_drv_1",
          payoutsEnabled: false,
        },
      },
    });

    // Stale event should be ignored
    const stale = await reconcileStripeAccountUpdatedWebhook({
      db,
      eventId: "evt_stale",
      eventCreated: 1500,
      account: { id: "acct_drv_1", payouts_enabled: true, charges_enabled: true, details_submitted: true },
    });
    expect(stale.synced).toBe(false);
    expect(stale.reason).toBe("stale_out_of_order_event");

    // Newer event should update both collections atomically
    const fresh = await reconcileStripeAccountUpdatedWebhook({
      db,
      eventId: "evt_fresh",
      eventCreated: 2500,
      account: {
        id: "acct_drv_1",
        payouts_enabled: true,
        charges_enabled: true,
        details_submitted: true,
        capabilities: { transfers: "active", card_payments: "active" },
        requirements: { disabled_reason: null, currently_due: ["external_account"] },
      },
    });
    expect(fresh.synced).toBe(true);
    expect(db._store.users.get("drv_1").payoutsEnabled).toBe(true);
    expect(db._store.users.get("drv_1").stripeCapabilities.transfers).toBe("active");
    expect(db._store.driver_profiles.get("drv_1").payoutsEnabled).toBe(true);
  });

  it("AT-PAY-15: transitions checkout payment_intents to terminal states cleanly & sweeps stale intents", async () => {
    const oldDate = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const freshDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const db = createInMemoryDb({
      payment_intents: {
        intent_expired: { status: "session_created", checkoutSessionId: "cs_exp", createdAt: oldDate },
        intent_paid_missed: { status: "session_created", checkoutSessionId: "cs_paid", createdAt: oldDate },
        intent_pi_failed: { status: "pending", paymentIntentId: "pi_fail", createdAt: oldDate },
        intent_fresh: { status: "session_created", checkoutSessionId: "cs_fresh", createdAt: freshDate },
        intent_done: { status: "completed", createdAt: oldDate },
      },
    });

    // Terminal state must never regress
    const noRegress = await transitionCheckoutIntentState({
      db,
      intentId: "intent_done",
      nextStatus: "failed",
    });
    expect(noRegress.transitioned).toBe(false);
    expect(noRegress.reason).toBe("already_terminal");

    const stripeClient = {
      checkout: {
        sessions: {
          retrieve: vi.fn(async (id: string) => {
            if (id === "cs_exp") return { id, status: "expired", payment_status: "unpaid" };
            if (id === "cs_paid") return { id, status: "complete", payment_status: "paid" };
            return { id, status: "open", payment_status: "unpaid" };
          }),
          expire: vi.fn(),
        },
      },
      paymentIntents: {
        retrieve: vi.fn(async (id: string) => ({
          id,
          status: "canceled",
          last_payment_error: { message: "Authentication failed" },
        })),
      },
    };

    const sweep = await sweepStaleCheckoutIntents({ db, stripeClient });
    expect(sweep.expired).toBe(1);
    expect(sweep.flaggedForReconciliation).toBe(1);
    expect(sweep.failed).toBe(1);
    expect(db._store.payment_intents.get("intent_expired").status).toBe("expired");
    expect(db._store.payment_intents.get("intent_paid_missed").status).toBe("requires_reconciliation");
    expect(db._store.payment_intents.get("intent_pi_failed").status).toBe("failed");
    expect(db._store.payment_intents.get("intent_fresh").status).toBe("session_created");
  });

  it("AT-PAY-18: binds generic subscription cancel/reactivate strictly to caller active product & sub ID", () => {
    const landlordUser = {
      subscriptionType: "landlord",
      subscriptionId: "sub_landlord_1",
      homeownerSubscriptionStatus: "active",
    };

    expect(() =>
      resolveVerifiedSubscriptionTarget({
        userData: landlordUser,
        requestedType: "tier", // Must NOT reuse landlord subscriptionId for trader tier
        action: "cancel",
      })
    ).toThrow(ConflictError);

    expect(() =>
      resolveVerifiedSubscriptionTarget({
        userData: landlordUser,
        requestedType: "landlord",
        requestedSubscriptionId: "sub_someone_else",
        action: "cancel",
      })
    ).toThrow(ForbiddenError);

    const target = resolveVerifiedSubscriptionTarget({
      userData: landlordUser,
      requestedType: "landlord",
      action: "reactivate",
    });
    expect(target.subscriptionType).toBe("landlord");
    expect(target.subscriptionId).toBe("sub_landlord_1");

    expect(() =>
      resolveVerifiedSubscriptionTarget({
        userData: { ...landlordUser, homeownerSubscriptionStatus: "canceled" },
        requestedType: "landlord",
        action: "reactivate",
      })
    ).toThrow(ConflictError);
  });

  it("AT-PAY-19, AT-PAY-20, AT-PAY-24 & AT-STRIPE-CONNECT-01: role-gates Connect, locks account/customer creation, and recovers orphan IDs", async () => {
    // Role restriction check (AT-PAY-20)
    expect(() => assertPayoutEligibleRole({ role: "homeowner" })).toThrow(ForbiddenError);
    expect(() => assertPayoutEligibleRole({ role: "customer" })).toThrow(ForbiddenError);
    expect(() => assertPayoutEligibleRole({ role: "tradesperson" })).not.toThrow();
    expect(() => assertPayoutEligibleRole({ role: "user", isDriver: true })).not.toThrow();

    // Connect orphan ID recovery + idempotency key persistence (AT-PAY-19 + AT-STRIPE-CONNECT-01)
    const db = createInMemoryDb({
      users: {
        tr_1: { uid: "tr_1", role: "tradesperson", email: "tr1@example.com" },
        cust_1: { uid: "cust_1", role: "homeowner", email: "c1@example.com" },
      },
      stripe_connect_locks: {
        tr_orphan: { pendingStripeAccountId: "acct_orphan_999" },
        tr_locked: { status: "creating", leaseExpiresAtMs: Date.now() + 30_000 },
      },
      stripe_customer_locks: {
        cust_orphan: { pendingStripeCustomerId: "cus_orphan_888" },
      },
    });
    await db.collection("users").doc("tr_orphan").set({ uid: "tr_orphan", role: "driver" });
    await db.collection("users").doc("tr_locked").set({ uid: "tr_locked", role: "tradesperson" });
    await db.collection("users").doc("cust_orphan").set({ uid: "cust_orphan", role: "homeowner" });

    const stripe = {
      accounts: { create: vi.fn().mockResolvedValue({ id: "acct_new_123" }) },
      customers: { create: vi.fn().mockResolvedValue({ id: "cus_new_456" }) },
    };

    // Orphan recovery without calling Stripe
    const recovered = await ensureStripeAccountForProvider({
      db,
      stripe,
      authUid: "tr_orphan",
      userData: { uid: "tr_orphan", role: "driver" },
    });
    expect(recovered).toEqual({ accountId: "acct_orphan_999", created: false, recovered: true });
    expect(db._store.users.get("tr_orphan").stripeAccountId).toBe("acct_orphan_999");

    // Active lock conflict
    await expect(
      ensureStripeAccountForProvider({
        db,
        stripe,
        authUid: "tr_locked",
        userData: { uid: "tr_locked", role: "tradesperson" },
      })
    ).rejects.toThrow(ConflictError);

    // Normal Connect creation passes Stripe idempotencyKey
    const createdAcct = await ensureStripeAccountForProvider({
      db,
      stripe,
      authUid: "tr_1",
      userData: { uid: "tr_1", role: "tradesperson", email: "tr1@example.com" },
    });
    expect(createdAcct.accountId).toBe("acct_new_123");
    expect(stripe.accounts.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "express", country: "GB" }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^connect_acct_tr_1_/) })
    );

    // Customer creation recovers orphan and uses idempotency key on new
    const recoveredCus = await ensureStripeCustomerIdForUser({ db, stripe, userId: "cust_orphan" });
    expect(recoveredCus).toBe("cus_orphan_888");

    const createdCus = await ensureStripeCustomerIdForUser({ db, stripe, userId: "cust_1" });
    expect(createdCus).toBe("cus_new_456");
    expect(stripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: "c1@example.com" }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^cust_create_cust_1_/) })
    );
  });

  it("AT-PAY-21: client stripeIntegrationService fails closed instead of returning mock onboarding URL", async () => {
    const mod = await import("../../src/services/stripeIntegrationService.ts");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "Stripe unconfigured" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(mod.getStripeOnboardingLink("trader_1")).rejects.toThrow(/Stripe unconfigured|Failed to create/);
    await expect(mod.completeStripeOnboarding("trader_1", "acct_1")).rejects.toThrow(/disabled/i);

    vi.unstubAllGlobals();
  });

  it("AT-PAY-17, AT-PAY-22, AT-PAY-23: verifies server.ts enforces portal fail-closed errors and PAYMENT_ATTEMPT / paymentLimiter guards", () => {
    const serverSrc = fs.readFileSync(path.resolve(process.cwd(), "server.ts"), "utf8");

    // AT-PAY-17: No fake returnUrl fallback on portal session route
    const portalStart = serverSrc.indexOf('"/api/create-customer-portal-session"');
    const portalSlice = serverSrc.slice(portalStart, portalStart + 1800);
    expect(portalSlice).toContain("paymentAttemptAbuseLimiter");
    expect(portalSlice).toContain("503");
    expect(portalSlice).toContain("502");
    expect(portalSlice).not.toContain("{ url: finalReturnUrl }");

    // AT-PAY-22 & AT-PAY-23: Verify login-link and payment endpoints carry paymentAttemptAbuseLimiter + paymentLimiter
    const routesRequiringAbuseLimiter = [
      '"/api/create-checkout-session"',
      '"/api/create-setup-session"',
      '"/api/create-customer-portal-session"',
      '"/api/cancel-subscription"',
      '"/api/reactivate-subscription"',
      '"/api/disputes/create-stake-intent"',
      '"/api/ads/:id/topup"',
      '"/api/rides/create-trip-payment"',
      '"/api/driver/stripe-payout/:driverId"',
      '"/api/stripe/create-connect-account"',
      '"/api/stripe/create-login-link"',
      '"/api/stripe/request-payout"',
      '"/api/driver/settle-fees"',
    ];
    for (const routeLiteral of routesRequiringAbuseLimiter) {
      const idx = serverSrc.indexOf(routeLiteral);
      expect(idx).toBeGreaterThan(-1);
      const header = serverSrc.slice(idx, idx + 160);
      expect(header).toContain("paymentAttemptAbuseLimiter");
    }
    const loginLinkHeader = serverSrc.slice(
      serverSrc.indexOf('"/api/stripe/create-login-link"'),
      serverSrc.indexOf('"/api/stripe/create-login-link"') + 160
    );
    expect(loginLinkHeader).toContain("paymentLimiter");
  });
});
