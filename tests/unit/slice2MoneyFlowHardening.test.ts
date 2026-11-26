import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  isJobEligibleForMediationStake,
  resolveInstantMatchPaymentIntentId,
  canReplaceLinkedSubscription,
  resolveSubscriptionPeriodEndIso,
  sanitizeOfficialBankDetails,
} from "../../src/server/slice2MoneyFlowHelpers.ts";
import { reserveMediationStakeAttempt, confirmMediationStakePayment } from "../../src/server/mediationStake.ts";
import { resolveAuthoritativeLineItem } from "../../src/server/pricingCatalog.ts";
import { buildSubscriptionLifecyclePatch } from "../../src/server/subscriptionLifecycle.ts";
import { createStripeWebhookHandler } from "../../src/server/stripeWebhookHandler.ts";
import { createOrGetJobInvoiceCommand } from "../../src/server/invoiceCreation.ts";
import { PaymentLedgerEngine } from "../../src/server/paymentLedger.ts";

function createInMemoryDb(seed: Record<string, any> = {}) {
  const store: Record<string, any> = structuredClone(seed);
  const makeDocRef = (docPath: string): any => {
    const parts = docPath.split("/");
    const id = parts[parts.length - 1];
    return {
      id,
      path: docPath,
      get: async () => ({
        id,
        exists: store[docPath] !== undefined,
        data: () => (store[docPath] !== undefined ? structuredClone(store[docPath]) : undefined),
      }),
      set: async (data: any, options?: { merge?: boolean }) => {
        store[docPath] = options?.merge
          ? { ...(store[docPath] || {}), ...structuredClone(data) }
          : structuredClone(data);
      },
      update: async (patch: any) => {
        if (store[docPath] === undefined) throw new Error(`Missing doc ${docPath}`);
        store[docPath] = { ...store[docPath], ...structuredClone(patch) };
      },
      delete: async () => {
        delete store[docPath];
      },
      collection: (sub: string) => makeCollectionRef(`${docPath}/${sub}`),
    };
  };

  const makeCollectionRef = (colPath: string): any => ({
    doc: (id?: string) => makeDocRef(`${colPath}/${id || `auto_${Math.random().toString(36).slice(2, 8)}`}`),
    where: (field: string, op: string, value: any) => ({
      get: async () => {
        const prefix = `${colPath}/`;
        const docs = Object.entries(store)
          .filter(([k, v]) => {
            if (!k.startsWith(prefix)) return false;
            const remainder = k.slice(prefix.length);
            if (remainder.includes("/")) return false;
            return op === "==" ? v?.[field] === value : false;
          })
          .map(([k, v]) => ({
            id: k.slice(prefix.length),
            exists: true,
            data: () => structuredClone(v),
          }));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    }),
  });

  return {
    _store: store,
    collection: (name: string) => makeCollectionRef(name),
    runTransaction: async (handler: (tx: any) => Promise<any>) => {
      const writes: Array<() => void> = [];
      const tx = {
        get: async (ref: any) => ({
          id: ref.id,
          exists: store[ref.path] !== undefined,
          data: () => (store[ref.path] !== undefined ? structuredClone(store[ref.path]) : undefined),
        }),
        set: (ref: any, data: any, options?: { merge?: boolean }) => {
          writes.push(() => {
            store[ref.path] = options?.merge
              ? { ...(store[ref.path] || {}), ...structuredClone(data) }
              : structuredClone(data);
          });
        },
        update: (ref: any, patch: any) => {
          writes.push(() => {
            store[ref.path] = { ...(store[ref.path] || {}), ...structuredClone(patch) };
          });
        },
        delete: (ref: any) => {
          writes.push(() => {
            delete store[ref.path];
          });
        },
      };
      const result = await handler(tx);
      writes.forEach((w) => w());
      return result;
    },
  };
}

describe("Slice 2 Money Flow Hardening (AnyTrader)", () => {
  it("Fix #1: resolveInstantMatchPaymentIntentId prefers session.payment_intent over null intent.paymentIntentId", () => {
    expect(
      resolveInstantMatchPaymentIntentId(
        { payment_intent: "pi_3RealInstantMatch123" },
        { paymentIntentId: null }
      )
    ).toBe("pi_3RealInstantMatch123");

    expect(
      resolveInstantMatchPaymentIntentId(
        { payment_intent: { id: "pi_3ExpandedObj456" } },
        { paymentIntentId: "" }
      )
    ).toBe("pi_3ExpandedObj456");

    expect(
      resolveInstantMatchPaymentIntentId(
        { payment_intent: null },
        { paymentIntentId: "pi_3FallbackIntent789" }
      )
    ).toBe("pi_3FallbackIntent789");

    expect(
      resolveInstantMatchPaymentIntentId(
        { payment_intent: "cs_test_not_a_pi" },
        { paymentIntentId: null }
      )
    ).toBeNull();
  });

  it("Fix #2: Dispute mediation stake allows disputable job statuses, rejects open/draft/cancelled, and respects dynamic admin price", async () => {
    expect(isJobEligibleForMediationStake("accepted")).toBe(true);
    expect(isJobEligibleForMediationStake("in_progress")).toBe(true);
    expect(isJobEligibleForMediationStake("completed")).toBe(true);
    expect(isJobEligibleForMediationStake("disputed")).toBe(true);
    expect(isJobEligibleForMediationStake("open")).toBe(false);
    expect(isJobEligibleForMediationStake("draft")).toBe(false);
    expect(isJobEligibleForMediationStake("cancelled")).toBe(false);

    const db = createInMemoryDb({
      "jobs/job-in-progress": {
        status: "in_progress",
        homeownerId: "home-1",
        acceptedTradespersonId: "trader-1",
      },
      "jobs/job-open": {
        status: "open",
        homeownerId: "home-1",
      },
      "platform_config/global": {
        paidAddons: {
          milestoneEscrow: {
            homeownerMediationStake: 35,
          },
        },
      },
    });

    // Authoritative checkout resolution works for in_progress job with dynamic £35 admin stake
    const resolved = await resolveAuthoritativeLineItem(
      {
        userId: "home-1",
        mode: "payment",
        priceId: "price_mediation_stake",
        metadata: { type: "mediation_stake", jobId: "job-in-progress" },
      },
      "home-1",
      db as any
    );
    expect(resolved.authoritativeAmountPence).toBe(3500);

    // Rejects open unaccepted job
    await expect(
      resolveAuthoritativeLineItem(
        {
          userId: "home-1",
          mode: "payment",
          priceId: "price_mediation_stake",
          metadata: { type: "mediation_stake", jobId: "job-open" },
        },
        "home-1",
        db as any
      )
    ).rejects.toThrow(/accepted, in-progress, completed, or disputed/i);

    // Transaction reservation & confirmation set both nested and top-level mediationStakePaid
    const reservation = await reserveMediationStakeAttempt(db as any, {
      jobId: "job-in-progress",
      userId: "home-1",
      candidateAttemptId: "att-1",
      stakeAmountPence: 3500,
      serverTimestamp: () => "ts",
    });
    expect(reservation.attemptId).toBe("att-1");
    expect(reservation.stakeAmountPence).toBe(3500);
    expect(db._store["jobs/job-in-progress"].dispute.mediationStakeAmount).toBe(35);

    await confirmMediationStakePayment(db as any, {
      jobId: "job-in-progress",
      userId: "home-1",
      paymentIntentId: "pi_stake_confirm_1",
      attemptId: "att-1",
      amountPence: 3500,
      serverTimestamp: () => "ts",
    });
    expect(db._store["jobs/job-in-progress"].mediationStakePaid).toBe(true);
    expect(db._store["jobs/job-in-progress"].dispute.mediationStakePaid).toBe(true);
  });

  it("Fix #4: PaymentLedgerEngine.reconcileJobPaymentStatus distinguishes partial vs full milestone release and syncs invoice", async () => {
    const db = createInMemoryDb({
      "jobs/job-1": {
        homeownerId: "home-1",
        acceptedQuoteId: "q-1",
        status: "in_progress",
        paymentStatus: "funded",
        isPaid: false,
      },
      "jobs/job-1/quotes/q-1": {
        tradespersonId: "trader-1",
        status: "accepted",
        milestones: [
          { id: "m1", status: "released", releaseStatus: "completed", amount: 100 },
          { id: "m2", status: "funded", amount: 150 },
        ],
      },
      "invoices/INV_job-1": {
        jobId: "job-1",
        status: "unpaid",
        paid: false,
        isPaid: false,
      },
    });

    // Partial release: must NOT mark job isPaid=true
    const partial = await PaymentLedgerEngine.reconcileJobPaymentStatus(db as any, {
      jobId: "job-1",
      quoteId: "q-1",
      isQrHandshake: false,
    });
    expect(partial.allMilestonesReleased).toBe(false);
    expect(partial.paymentStatus).toBe("partially_released");
    expect(db._store["jobs/job-1"].isPaid).toBe(false);
    expect(db._store["jobs/job-1"].paymentStatus).toBe("partially_released");
    expect(db._store["invoices/INV_job-1"].status).toBe("unpaid");

    // Release final milestone and reconcile with QR handshake
    db._store["jobs/job-1/quotes/q-1"].milestones[1] = {
      id: "m2",
      status: "released",
      releaseStatus: "completed",
      amount: 150,
    };

    const full = await PaymentLedgerEngine.reconcileJobPaymentStatus(db as any, {
      jobId: "job-1",
      quoteId: "q-1",
      isQrHandshake: true,
    });
    expect(full.allMilestonesReleased).toBe(true);
    expect(full.paymentStatus).toBe("handshake_complete");
    expect(db._store["jobs/job-1"].isPaid).toBe(true);
    expect(db._store["jobs/job-1"].paymentStatus).toBe("handshake_complete");
    expect(db._store["invoices/INV_job-1"].status).toBe("paid");
    expect(db._store["invoices/INV_job-1"].isPaid).toBe(true);
  });

  it("Fix #10: releaseFailedPreflightIdempotencyLock clears definite preflight failure lock but preserves reconciliation_required", async () => {
    const db = createInMemoryDb({
      "payment_idempotency/rel_preflight_fail": {
        operationName: "ESCROW_RELEASE",
        status: "completed",
        releaseStatus: "failed",
      },
      "payment_idempotency/rel_ambiguous": {
        operationName: "ESCROW_RELEASE",
        status: "reconciliation_required",
        releaseStatus: "reconciliation_required",
      },
    });

    const cleared = await PaymentLedgerEngine.releaseFailedPreflightIdempotencyLock(db as any, "rel_preflight_fail");
    expect(cleared.released).toBe(true);
    expect(db._store["payment_idempotency/rel_preflight_fail"]).toBeUndefined();

    const preserved = await PaymentLedgerEngine.releaseFailedPreflightIdempotencyLock(db as any, "rel_ambiguous");
    expect(preserved.released).toBe(false);
    expect(db._store["payment_idempotency/rel_ambiguous"]).toBeDefined();
  });

  it("Fix #5: createOrGetJobInvoiceCommand enforces auth, writes both traderId/tradespersonId, upgrades paid status, and omits fake Barclays details", async () => {
    const db = createInMemoryDb({
      "jobs/job-inv-1": {
        title: "Boiler Service",
        category: "Gas & Heating",
        postcode: "SW1A 1AA",
        homeownerId: "home-1",
        acceptedQuoteId: "q-1",
        acceptedTradespersonId: "trader-1",
        status: "completed",
        isPaid: false,
        paymentStatus: "funded",
      },
      "jobs/job-inv-1/quotes/q-1": {
        tradespersonId: "trader-1",
        status: "accepted",
        amount: 200,
        platformFee: 20,
      },
      "users/trader-1": {
        name: "Alex Gas",
        tier: "pro",
        hasVerifiedVideoProSubscription: true,
        // Intentionally NO bank details saved
      },
      "users/home-1": {
        name: "Sam Homeowner",
        email: "sam@example.com",
      },
    });

    // Rejects unauthorized third party
    await expect(
      createOrGetJobInvoiceCommand({
        db,
        identity: { uid: "outsider-99", email: "x@y.com", isAdmin: false } as any,
        jobId: "job-inv-1",
      })
    ).rejects.toThrow(/Only the job homeowner/i);

    // Homeowner generates official invoice
    const first = await createOrGetJobInvoiceCommand({
      db,
      identity: { uid: "home-1", email: "sam@example.com", isAdmin: false } as any,
      jobId: "job-inv-1",
    });
    expect(first.created).toBe(true);
    expect(first.invoice.traderId).toBe("trader-1");
    expect(first.invoice.tradespersonId).toBe("trader-1");
    expect(first.invoice.homeownerId).toBe("home-1");
    expect(first.invoice.status).toBe("unpaid");
    expect(first.invoice.tradespersonBankDetails).toBeUndefined();

    // Job becomes paid -> subsequent call upgrades unpaid invoice to paid
    db._store["jobs/job-inv-1"].isPaid = true;
    db._store["jobs/job-inv-1"].paymentStatus = "paid";
    const second = await createOrGetJobInvoiceCommand({
      db,
      identity: { uid: "trader-1", email: "alex@example.com", isAdmin: false } as any,
      jobId: "job-inv-1",
    });
    expect(second.created).toBe(false);
    expect(second.invoice.status).toBe("paid");
    expect(second.invoice.isPaid).toBe(true);

    // Bank sanitizer only returns details when all 3 fields are non-empty
    expect(sanitizeOfficialBankDetails({ bankName: "Monzo", sortCode: "04-00-04" })).toBeUndefined();
    expect(
      sanitizeOfficialBankDetails({ bankName: "Monzo", sortCode: "04-00-04", accountNumber: "87654321" })
    ).toEqual({ bankName: "Monzo", sortCode: "04-00-04", accountNumber: "87654321" });
  });

  it("Fix #6 & #11: Re-subscription guards allow replacing terminal subscriptions, Gotham cancellation clears subscriptionType, and period end hydrates", async () => {
    expect(
      canReplaceLinkedSubscription({
        existingSubscriptionId: "sub_old",
        incomingSubscriptionId: "sub_new",
        existingStatus: "active",
        isCurrentlyActive: true,
      })
    ).toBe(false);

    expect(
      canReplaceLinkedSubscription({
        existingSubscriptionId: "sub_old",
        incomingSubscriptionId: "sub_new",
        existingStatus: "canceled",
        isCurrentlyActive: false,
      })
    ).toBe(true);

    const gothamPatch = buildSubscriptionLifecyclePatch("gotham_saas", {
      id: "sub_gotham_1",
      status: "canceled",
      cancel_at_period_end: false,
      current_period_end: 1760000000,
    });
    expect(gothamPatch.isGothamSubscriber).toBe(false);
    expect(gothamPatch.subscriptionType).toBe("standard");

    const periodEndIso = await resolveSubscriptionPeriodEndIso(
      {
        subscriptions: {
          retrieve: vi.fn().mockResolvedValue({ current_period_end: 1760000000 }),
        },
      },
      "sub_123"
    );
    expect(periodEndIso).toBe(new Date(1760000000 * 1000).toISOString());
  });

  it("Fix #9: Stripe webhook handler returns 503 when Firestore is unavailable so Stripe retries", async () => {
    const handler = createStripeWebhookHandler({
      getStripe: () => ({
        webhooks: {
          constructEvent: () => ({ id: "evt_1", type: "checkout.session.completed", data: { object: {} as any } } as any),
        },
      } as any),
      getDb: () => null,
      getWebhookSecret: () => "whsec_test",
      processEvent: vi.fn(),
    });

    const req: any = {
      headers: { "stripe-signature": "sig_test" },
      body: Buffer.from("{}"),
    };
    let statusCode = 200;
    let payload: any = null;
    const res: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: any) {
        payload = body;
        return this;
      },
      send(body: any) {
        payload = body;
        return this;
      },
    };

    await handler(req, res, vi.fn());
    expect(statusCode).toBe(503);
    expect(payload?.error).toMatch(/unavailable/i);
  });

  it("Fixes #3, #5, #7, #8, #12, #13: Static integrity checks across server, client UI, and Firestore rules", () => {
    const root = process.cwd();
    const serverSrc = fs.readFileSync(path.join(root, "server.ts"), "utf8");
    const invoiceSvcSrc = fs.readFileSync(path.join(root, "src/services/invoiceService.ts"), "utf8");
    const jobDetailsSrc = fs.readFileSync(path.join(root, "src/components/JobDetails.tsx"), "utf8");
    const bannerAdSrc = fs.readFileSync(path.join(root, "src/components/TradesBannerAdStudio.tsx"), "utf8");
    const videoCardSrc = fs.readFileSync(path.join(root, "src/components/TraderVideoVerificationCard.tsx"), "utf8");
    const billingSrc = fs.readFileSync(path.join(root, "src/components/BillingManager.tsx"), "utf8");
    const rulesSrc = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");

    // Fix #5: Zero hardcoded Barclays placeholder bank details in invoiceService.ts
    expect(invoiceSvcSrc).not.toContain("Barclays Bank UK");
    expect(invoiceSvcSrc).not.toContain("20-00-00");
    expect(invoiceSvcSrc).not.toContain("12345678");
    expect(invoiceSvcSrc).toContain("/api/invoices/job/");

    // Fix #7: Video Pro checkout must not auto-verify video KYC
    const videoProFulfillmentBlock = serverSrc.slice(
      serverSrc.indexOf("isVideoPro"),
      serverSrc.indexOf("isVideoPro") + 2500
    );
    expect(videoProFulfillmentBlock).not.toContain('videoVerificationStatus: "verified"');

    // Fix #3: QR handshake sends Idempotency-Key and surfaces toast errors
    const qrHandlerBlock = jobDetailsSrc.slice(
      jobDetailsSrc.indexOf("const handleSimulateScan"),
      jobDetailsSrc.indexOf("const handleAcceptReschedule")
    );
    expect(qrHandlerBlock).toContain('"Idempotency-Key": idempotencyKey');
    expect(qrHandlerBlock).toContain("toast.error");

    // Fix #12: No fake wallet credit or fake Video Pro activation fallback in client UI
    expect(bannerAdSrc).not.toContain("Successfully added £${val.toFixed(2)} to your Ad Wallet!");
    expect(videoCardSrc).not.toContain("⚡ Verified Video Pro Active!");

    // Fix #13: BillingManager sends canonical free tier key & Video card uses dynamic price
    expect(billingSrc).toContain('tierName: canonicalTier || "payg"');
    expect(videoCardSrc).not.toContain("£15.00 / month");
    expect(videoCardSrc).not.toContain("Upgrade for £15/mo");

    // Fix #8 & #5: Firestore rules lock instant_matches & instant_match_attempts writes and allow tradespersonId invoice reads
    const instantMatchBlock = rulesSrc.slice(
      rulesSrc.indexOf("match /instant_matches/{matchId}"),
      rulesSrc.indexOf("match /instant_matches/{matchId}") + 700
    );
    expect(instantMatchBlock).toContain("allow create, update, delete: if false;");

    const instantAttemptBlock = rulesSrc.slice(
      rulesSrc.indexOf("match /instant_match_attempts/{attemptId}"),
      rulesSrc.indexOf("match /instant_match_attempts/{attemptId}") + 700
    );
    expect(instantAttemptBlock).toContain("allow create, update, delete: if false;");

    const invoiceRulesBlock = rulesSrc.slice(
      rulesSrc.indexOf("match /invoices/{id}"),
      rulesSrc.indexOf("match /invoices/{id}") + 600
    );
    expect(invoiceRulesBlock).toContain("tradespersonId");
  });
});
