import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { ForbiddenError, ConflictError, BadRequestError } from "../../src/server/httpErrors.ts";
import { assertCanSubmitQuote } from "../../src/server/authorization.ts";
import { executeQuoteCommand, executeAcceptQuoteCommand } from "../../src/server/quoteCommands.ts";
import { executeJobLifecycleCommand } from "../../src/server/jobLifecycleCommands.ts";
import { PaymentLedgerEngine } from "../../src/server/paymentLedger.ts";
import { evaluateInstantMatchCandidate, respondToInstantMatchAttempt } from "../../src/server/instantMatchEligibility.ts";
import { selectNextInstantMatchCandidate } from "../../instantMatchWorker.ts";
import { evaluateLeadRecipient, filterEligibleLeadRecipients } from "../../src/server/leadDistribution.ts";
import { processStripeChargebackEvent } from "../../src/server/chargebackLifecycle.ts";
import { evaluateVatEligibility } from "../../src/lib/vatValidation.ts";
import { createManualInvoiceCommand } from "../../src/server/invoiceCreation.ts";
import { CanonicalIdentity } from "../../src/server/identity.ts";

function createInMemoryDb(seed: Record<string, Record<string, any>> = {}) {
  const store: Record<string, Record<string, any>> = {};
  for (const [k, v] of Object.entries(seed)) {
    store[k] = { ...v };
  }

  let autoIdCounter = 0;

  const buildCollection = (basePath: string): any => {
    const col: any = {
      doc: (docId?: string) => {
        const resolvedId = docId || `auto_${++autoIdCounter}`;
        const fullPath = `${basePath}/${resolvedId}`;
        const ref: any = {
          id: resolvedId,
          path: fullPath,
          get: async () => ({
            exists: !!store[fullPath],
            id: resolvedId,
            ref,
            data: () => (store[fullPath] ? { ...store[fullPath] } : undefined),
          }),
          set: async (data: any, opts?: { merge?: boolean }) => {
            if (opts?.merge && store[fullPath]) {
              store[fullPath] = { ...store[fullPath], ...data };
            } else {
              store[fullPath] = { ...data };
            }
          },
          update: async (data: any) => {
            if (!store[fullPath]) throw new Error(`Document ${fullPath} not found`);
            store[fullPath] = { ...store[fullPath], ...data };
          },
          delete: async () => {
            delete store[fullPath];
          },
          collection: (subCol: string) => buildCollection(`${fullPath}/${subCol}`),
        };
        return ref;
      },
      where: (field: string, op: string, value: any) => {
        const filters = [{ field, op, value }];
        const buildQuery = (currentFilters: Array<{ field: string; op: string; value: any }>): any => ({
          where: (f2: string, o2: string, v2: any) => buildQuery([...currentFilters, { field: f2, op: o2, value: v2 }]),
          limit: () => buildQuery(currentFilters),
          get: async () => {
            const prefix = `${basePath}/`;
            const docs = Object.entries(store)
              .filter(([k]) => {
                if (!k.startsWith(prefix)) return false;
                const rest = k.slice(prefix.length);
                return !rest.includes("/");
              })
              .filter(([, docData]) =>
                currentFilters.every((flt) => (flt.op === "==" ? docData[flt.field] === flt.value : true))
              )
              .map(([k, docData]) => {
                const id = k.slice(prefix.length);
                const ref = buildCollection(basePath).doc(id);
                return {
                  id,
                  ref,
                  data: () => ({ ...docData }),
                };
              });
            return { empty: docs.length === 0, size: docs.length, docs };
          },
        });
        return buildQuery(filters);
      },
      limit: () => col,
      get: async () => {
        const prefix = `${basePath}/`;
        const docs = Object.entries(store)
          .filter(([k]) => {
            if (!k.startsWith(prefix)) return false;
            return !k.slice(prefix.length).includes("/");
          })
          .map(([k, docData]) => {
            const id = k.slice(prefix.length);
            const ref = buildCollection(basePath).doc(id);
            return {
              id,
              ref,
              data: () => ({ ...docData }),
            };
          });
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    };
    return col;
  };

  return {
    _store: store,
    collection: (name: string) => buildCollection(name),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        set: (ref: any, data: any, opts?: any) => {
          ops.push(() => {
            if (opts?.merge && store[ref.path]) {
              store[ref.path] = { ...store[ref.path], ...data };
            } else {
              store[ref.path] = { ...data };
            }
          });
        },
        update: (ref: any, data: any) => {
          ops.push(() => {
            store[ref.path] = { ...(store[ref.path] || {}), ...data };
          });
        },
        delete: (ref: any) => {
          ops.push(() => {
            delete store[ref.path];
          });
        },
        commit: async () => {
          for (const op of ops) op();
        },
      };
    },
    runTransaction: async (fn: (tx: any) => Promise<any>) => {
      const tx = {
        get: async (target: any) => target.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        create: (ref: any, data: any) => {
          if (store[ref.path]) throw new Error(`Already exists: ${ref.path}`);
          store[ref.path] = { ...data };
        },
        update: (ref: any, data: any) => ref.update(data),
        delete: (ref: any) => ref.delete(),
      };
      return fn(tx);
    },
  };
}

const makeIdentity = (overrides: Partial<CanonicalIdentity> = {}): CanonicalIdentity => ({
  uid: "user_1",
  email: "test@example.com",
  accountType: "service_provider",
  capabilities: ["tradesperson"],
  verification: { status: "verified" },
  subscription: { tierId: "PAYG", status: "active" },
  ...overrides,
});

describe("Batch 6 — Marketplace Quoting, Matching, Escrow, Chargebacks & Invoicing P1 Suite", () => {
  describe("AT-QUOTE-04: Quote submission capability & non-self-ownership checks", () => {
    it("rejects consumer/homeowner callers without tradesperson capability in assertCanSubmitQuote", () => {
      const consumerIdentity = makeIdentity({
        uid: "homeowner_2",
        accountType: "consumer",
        capabilities: ["homeowner"],
      });

      expect(() =>
        assertCanSubmitQuote(consumerIdentity, { homeownerId: "homeowner_1" })
      ).toThrow(ForbiddenError);
    });

    it("rejects consumer and unverified/suspended traders in executeQuoteCommand CreateQuote", async () => {
      const db = createInMemoryDb({
        "jobs/job_q1": {
          id: "job_q1",
          homeownerId: "homeowner_1",
          status: "open",
          title: "Boiler Repair",
        },
        "users/homeowner_2": {
          uid: "homeowner_2",
          role: "consumer",
          isVerified: false,
        },
        "users/trader_suspended": {
          uid: "trader_suspended",
          role: "tradesperson",
          isVerified: true,
          isSuspended: true,
        },
      });

      const homeownerIdentity = makeIdentity({
        uid: "homeowner_2",
        accountType: "consumer",
        capabilities: ["homeowner"],
      });

      await expect(
        executeQuoteCommand({
          db,
          identity: homeownerIdentity,
          command: {
            type: "CreateQuote",
            payload: { jobId: "job_q1", amount: 250, message: "Test quote" },
          },
          idempotencyKey: "quote_cmd_consumer_1",
        })
      ).rejects.toThrow(ForbiddenError);

      const suspendedIdentity = makeIdentity({ uid: "trader_suspended" });
      await expect(
        executeQuoteCommand({
          db,
          identity: suspendedIdentity,
          command: {
            type: "CreateQuote",
            payload: { jobId: "job_q1", amount: 250, message: "Test quote" },
          },
          idempotencyKey: "quote_cmd_susp_1",
        })
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects tradesperson quoting on their own job", async () => {
      const db = createInMemoryDb({
        "jobs/job_self": { id: "job_self", homeownerId: "trader_self", status: "open" },
        "users/trader_self": { uid: "trader_self", role: "tradesperson", isVerified: true, status: "active" },
      });

      const selfIdentity = makeIdentity({ uid: "trader_self" });
      await expect(
        executeQuoteCommand({
          db,
          identity: selfIdentity,
          command: {
            type: "CreateQuote",
            payload: { jobId: "job_self", amount: 300, message: "Self quote" },
          },
          idempotencyKey: "quote_cmd_self_1",
        })
      ).rejects.toThrow(BadRequestError);
    });
  });

  describe("AT-MATCH-08: Server-authoritative Instant Match eligibility & deterministic scoring", () => {
    it("excludes suspended, unverified, expired, unavailable, or retracted-projection traders and scores deterministically", async () => {
      const db = createInMemoryDb({
        "jobs/job_im_1": {
          id: "job_im_1",
          category: "Plumbing",
          title: "Burst pipe emergency",
          description: "Leaking under sink",
          postcode: "SW1A 1AA",
        },
        "users/trader_suspended": {
          uid: "trader_suspended",
          role: "tradesperson",
          isVerified: true,
          isSuspended: true,
          isAvailableForEmergency: true,
          trades: ["Plumbing"],
          postcode: "SW1A 1AA",
        },
        "users/trader_expired": {
          uid: "trader_expired",
          role: "tradesperson",
          isVerified: true,
          insuranceExpiry: "2020-01-01T00:00:00.000Z",
          isAvailableForEmergency: true,
          trades: ["Plumbing"],
        },
        "users/trader_no_proj": {
          uid: "trader_no_proj",
          role: "tradesperson",
          isVerified: true,
          isAvailableForEmergency: true,
          trades: ["Plumbing"],
          postcode: "SW1A 1AA",
        },
        "users/trader_eligible": {
          uid: "trader_eligible",
          role: "tradesperson",
          isVerified: true,
          status: "active",
          acceptingNewWork: true,
          isAvailableForInstantMatch: true,
          isAvailableForEmergency: true,
          trades: ["Plumbing"],
          postcode: "SW1A 2BB",
          rating: 4.9,
        },
        "public_profiles/trader_suspended": { isSuspended: true },
        "public_profiles/trader_eligible": { acceptingNewWork: true, isAvailableForInstantMatch: true, rating: 4.9 },
      });

      const firstPick = await selectNextInstantMatchCandidate(
        db,
        { jobId: "job_im_1" },
        [],
        { imRequireEmergencyToggle: true, imRequireCategoryMatch: true }
      );
      const secondPick = await selectNextInstantMatchCandidate(
        db,
        { jobId: "job_im_1" },
        [],
        { imRequireEmergencyToggle: true, imRequireCategoryMatch: true }
      );

      expect(firstPick?.id).toBe("trader_eligible");
      expect(secondPick?.score).toBe(firstPick?.score);
    });

    it("stores arrival PIN off-job in job_arrival_pins via respondToInstantMatchAttempt", async () => {
      const db = createInMemoryDb({
        "users/trader_ok": { uid: "trader_ok", role: "tradesperson", isVerified: true, status: "active" },
        "instant_matches/im_1": { id: "im_1", jobId: "job_im_2", status: "searching" },
        "instant_match_attempts/im_1_1": {
          id: "im_1_1",
          instantMatchId: "im_1",
          traderId: "trader_ok",
          status: "pending",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
        "jobs/job_im_2": { id: "job_im_2", homeownerId: "homeowner_1", status: "open" },
      });

      const res = await respondToInstantMatchAttempt({
        db,
        uid: "trader_ok",
        attemptId: "im_1_1",
        action: "accept",
      });

      expect(res.status).toBe("accepted");
      expect(res.jobId).toBe("job_im_2");
      expect(db._store["jobs/job_im_2"].verificationPin).toBeUndefined();
      expect(db._store["jobs/job_im_2"].hasVerificationPin).toBe(true);
      expect(db._store["job_arrival_pins/job_im_2"].verificationPin).toMatch(/^\d{4}$/);
    });
  });

  describe("AT-LEAD-01: Strict category & geographic lead distribution (including emergencies)", () => {
    it("blocks wrong-trade and far-away traders even on emergency jobs", () => {
      const criteria = {
        jobId: "job_emerg_1",
        ownerId: "homeowner_1",
        callerUid: "homeowner_1",
        category: "Plumbing",
        postcode: "SW1A 1AA",
        lat: 51.5014,
        lng: -0.1419,
        isEmergency: true,
      };

      const candidates = [
        {
          id: "trader_electrician_close",
          data: { role: "tradesperson", isVerified: true, trades: ["Electrical"], lat: 51.502, lng: -0.141, coverageRadiusMiles: 15 },
        },
        {
          id: "trader_plumber_far_manchester",
          data: { role: "tradesperson", isVerified: true, trades: ["Plumbing"], lat: 53.4808, lng: -2.2426, coverageRadiusMiles: 20 },
        },
        {
          id: "trader_plumber_local",
          data: { role: "tradesperson", isVerified: true, trades: ["Plumbing"], lat: 51.515, lng: -0.13, coverageRadiusMiles: 15 },
        },
      ];

      const eligible = filterEligibleLeadRecipients(candidates, criteria, 20);
      expect(eligible.map((c) => c.id)).toEqual(["trader_plumber_local"]);
      expect(evaluateLeadRecipient("homeowner_1", { isVerified: true, trades: ["Plumbing"], postcode: "SW1A 1AA" }, criteria).reason).toBe("self_owner");
    });
  });

  describe("AT-CJ-SEC-START-01: Arrival PIN isolation from jobs/{jobId}", () => {
    it("accepts quote without leaking plaintext verificationPin on jobs/{jobId} and verifies via job_arrival_pins/{jobId}", async () => {
      const db = createInMemoryDb({
        "users/homeowner_alice": { uid: "homeowner_alice", role: "consumer" },
        "users/trader_dave": { uid: "trader_dave", role: "tradesperson", isVerified: true, status: "active", trades: ["Plumbing"] },
        "jobs/job_pin_1": {
          id: "job_pin_1",
          homeownerId: "homeowner_alice",
          status: "open",
          category: "Plumbing",
          title: "Fix Leak",
        },
        "jobs/job_pin_1/quotes/quote_pin_1": {
          id: "quote_pin_1",
          jobId: "job_pin_1",
          tradespersonId: "trader_dave",
          amount: 150,
          status: "pending",
        },
      });

      const homeownerId = makeIdentity({
        uid: "homeowner_alice",
        accountType: "consumer",
        capabilities: ["homeowner"],
      });

      const acceptRes = await executeAcceptQuoteCommand({
        db,
        identity: homeownerId,
        jobId: "job_pin_1",
        quoteId: "quote_pin_1",
        idempotencyKey: "accept_pin_sec_1",
      });

      expect(acceptRes.verificationPin).toMatch(/^\d{4}$/);
      expect(db._store["jobs/job_pin_1"].verificationPin).toBeUndefined();
      expect(db._store["jobs/job_pin_1"].hasVerificationPin).toBe(true);
      expect(db._store["job_arrival_pins/job_pin_1"].verificationPin).toBe(acceptRes.verificationPin);
      expect(db._store["job_arrival_pins/job_pin_1"].homeownerId).toBe("homeowner_alice");

      // Trader cannot start with wrong PIN
      const traderId = makeIdentity({ uid: "trader_dave" });
      await expect(
        executeJobLifecycleCommand({
          db,
          identity: traderId,
          command: { type: "StartJob", payload: { jobId: "job_pin_1", verificationPin: "0000" } },
          idempotencyKey: "start_pin_bad_1",
          strictTraderProfileRequired: true,
        })
      ).rejects.toThrow(BadRequestError);

      // Trader succeeds with homeowner-supplied PIN stored in job_arrival_pins
      const startRes = await executeJobLifecycleCommand({
        db,
        identity: traderId,
        command: { type: "StartJob", payload: { jobId: "job_pin_1", verificationPin: acceptRes.verificationPin } },
        idempotencyKey: "start_pin_good_1",
        strictTraderProfileRequired: true,
      });

      expect(startRes.status).toBe("in_progress");
      expect(db._store["job_arrival_pins/job_pin_1"].verifiedByUid).toBe("trader_dave");
    });

    it("verifies JobDetails.tsx no longer compares enteredPin === job.verificationPin client-side and firestore.rules locks job_arrival_pins", () => {
      const jobDetailsSrc = fs.readFileSync(path.resolve(process.cwd(), "src/components/JobDetails.tsx"), "utf8");
      expect(jobDetailsSrc).not.toMatch(/enteredPin\s*===\s*job\.verificationPin/);
      expect(jobDetailsSrc).toContain("job_arrival_pins");

      const rulesSrc = fs.readFileSync(path.resolve(process.cwd(), "firestore.rules"), "utf8");
      expect(rulesSrc).toContain("match /job_arrival_pins/{jobId}");
      expect(rulesSrc).toContain("'verificationPin'");
    });
  });

  describe("AT-PAY-14: Unconditional accepted quote & job binding on escrow release", () => {
    it("blocks release when acceptedQuoteId is missing or quote status is not accepted", async () => {
      const db = createInMemoryDb({
        "jobs/job_unbind": {
          id: "job_unbind",
          homeownerId: "homeowner_alice",
          acceptedTradespersonId: "trader_dave",
          // intentionally missing acceptedQuoteId
          status: "in_progress",
        },
        "jobs/job_unbind/quotes/quote_unacc": {
          id: "quote_unacc",
          jobId: "job_unbind",
          tradespersonId: "trader_dave",
          status: "pending",
          milestones: [{ id: "m1", amount: 200, status: "funded", verifiedAmount: 200, currency: "gbp", stripePaymentIntentId: "pi_123" }],
        },
      });

      await expect(
        PaymentLedgerEngine.releaseEscrowFunds(db, {
          jobId: "job_unbind",
          quoteId: "quote_unacc",
          milestoneId: "m1",
          authUid: "homeowner_alice",
          idempotencyKey: "rel_unbind_1",
        })
      ).rejects.toThrow(BadRequestError);

      // Even if acceptedQuoteId matches, non-'accepted' quote status must still fail
      db._store["jobs/job_unbind"].acceptedQuoteId = "quote_unacc";
      await expect(
        PaymentLedgerEngine.releaseEscrowFunds(db, {
          jobId: "job_unbind",
          quoteId: "quote_unacc",
          milestoneId: "m1",
          authUid: "homeowner_alice",
          idempotencyKey: "rel_unbind_2",
        })
      ).rejects.toThrow(/must be 'accepted'/);
    });
  });

  describe("AT-PAY-12: Cancellation coordination for funded milestones & mediation stakes", () => {
    it("freezes/refunds funded milestones and marks active mediation stake recovery upon job cancellation", async () => {
      const stripeRefundMock = vi.fn().mockResolvedValue({ id: "re_cancel_123", status: "succeeded" });
      const stripeMock: any = { refunds: { create: stripeRefundMock } };

      const db = createInMemoryDb({
        "users/homeowner_alice": { uid: "homeowner_alice", role: "consumer" },
        "jobs/job_cancel_fin": {
          id: "job_cancel_fin",
          homeownerId: "homeowner_alice",
          acceptedTradespersonId: "trader_dave",
          acceptedQuoteId: "quote_cancel_1",
          status: "accepted",
          dispute: {
            stakePaid: true,
            stakeStatus: "paid",
            stakePaymentIntentId: "pi_stake_999",
          },
        },
        "jobs/job_cancel_fin/quotes/quote_cancel_1": {
          id: "quote_cancel_1",
          jobId: "job_cancel_fin",
          tradespersonId: "trader_dave",
          status: "accepted",
          milestones: [
            { id: "m_funded", title: "Deposit", amount: 300, status: "funded", stripePaymentIntentId: "pi_milestone_300" },
            { id: "m_unfunded", title: "Final", amount: 500, status: "unfunded" },
          ],
        },
      });

      const homeownerIdentity = makeIdentity({
        uid: "homeowner_alice",
        accountType: "consumer",
        capabilities: ["homeowner"],
      });

      const cancelResult = await executeJobLifecycleCommand({
        db,
        identity: homeownerIdentity,
        command: { type: "CancelJob", payload: { jobId: "job_cancel_fin", reason: "Schedule conflict" } },
        idempotencyKey: "cancel_fin_1",
        stripe: stripeMock,
      });

      expect(cancelResult.status).toBe("cancelled");
      expect(stripeRefundMock).toHaveBeenCalledTimes(1);
      expect(db._store["jobs/job_cancel_fin"].escrowCancellationStatus).toBe("refunded");
      expect(db._store["jobs/job_cancel_fin"].mediationStakeRecoveryStatus).toBe("forfeited_review");
      expect(db._store["mediation_stake_recoveries/stake_cancel_job_cancel_fin"]).toBeTruthy();
      expect(db._store["jobs/job_cancel_fin/quotes/quote_cancel_1"].milestones[0].status).toBe("refunded");
    });
  });

  describe("AT-PAY-16: Stripe charge.dispute webhook handling & payout freezes", () => {
    it("freezes job & payee payouts on dispute.created, blocks escrow release, and unfreezes on dispute.closed won", async () => {
      const db = createInMemoryDb({
        "users/trader_dave": { uid: "trader_dave", role: "tradesperson", payoutsFrozenByChargeback: false },
        "jobs/job_cb_1": {
          id: "job_cb_1",
          homeownerId: "homeowner_alice",
          acceptedTradespersonId: "trader_dave",
          acceptedQuoteId: "quote_cb_1",
          status: "in_progress",
        },
        "jobs/job_cb_1/quotes/quote_cb_1": {
          id: "quote_cb_1",
          jobId: "job_cb_1",
          tradespersonId: "trader_dave",
          status: "accepted",
          milestones: [{ id: "m_cb", amount: 400, status: "funded", verifiedAmount: 400, currency: "gbp", stripePaymentIntentId: "pi_cb_400" }],
        },
        "payment_ledger/pay_cb_1": {
          id: "pay_cb_1",
          transactionId: "pi_cb_400",
          jobId: "job_cb_1",
          quoteId: "quote_cb_1",
          milestoneId: "m_cb",
          payerId: "homeowner_alice",
          payeeId: "trader_dave",
          status: "completed",
        },
      });

      const createdRes = await processStripeChargebackEvent(db, {
        id: "evt_cb_created_1",
        type: "charge.dispute.created",
        created: 1700000100,
        data: {
          object: {
            id: "dp_test_1",
            charge: "ch_cb_1",
            payment_intent: "pi_cb_400",
            amount: 40000,
            currency: "gbp",
            status: "needs_response",
            reason: "fraudulent",
          },
        },
      });

      expect(createdRes.action).toBe("frozen");
      expect(db._store["jobs/job_cb_1"].chargebackFreeze).toBe(true);
      expect(db._store["jobs/job_cb_1"].payoutFrozen).toBe(true);
      expect(db._store["users/trader_dave"].payoutsFrozenByChargeback).toBe(true);
      expect(db._store["chargeback_cases/dp_test_1"].stripeStatus).toBe("needs_response");
      expect(db._store["chargeback_cases/dp_test_1"].caseStatus).toBe("open_freeze");
      expect(db._store["payment_ledger/cb_hold_dp_test_1"].type).toBe("CHARGEBACK_HOLD");

      // Escrow release blocked while chargeback freeze active
      await expect(
        PaymentLedgerEngine.releaseEscrowFunds(db, {
          jobId: "job_cb_1",
          quoteId: "quote_cb_1",
          milestoneId: "m_cb",
          authUid: "homeowner_alice",
          idempotencyKey: "rel_blocked_cb",
        })
      ).rejects.toThrow(ConflictError);

      // Out-of-order stale event must be ignored
      const staleRes = await processStripeChargebackEvent(db, {
        id: "evt_cb_stale_1",
        type: "charge.dispute.updated",
        created: 1700000050,
        data: { object: { id: "dp_test_1", status: "warning_needs_response", payment_intent: "pi_cb_400" } },
      });
      expect(staleRes.action).toBe("stale_ignored");

      // Dispute won lifts freeze cleanly
      const wonRes = await processStripeChargebackEvent(db, {
        id: "evt_cb_won_1",
        type: "charge.dispute.closed",
        created: 1700000200,
        data: { object: { id: "dp_test_1", payment_intent: "pi_cb_400", amount: 40000, currency: "gbp", status: "won" } },
      });

      expect(wonRes.action).toBe("won_released");
      expect(db._store["jobs/job_cb_1"].chargebackFreeze).toBe(false);
      expect(db._store["users/trader_dave"].payoutsFrozenByChargeback).toBe(false);
      expect(db._store["payment_ledger/cb_won_dp_test_1"].type).toBe("CHARGEBACK_WON_RELEASE");
    });
  });

  describe("AT-CJ-INVOICE-06: HMRC UK VAT registration validation & generation guard", () => {
    it("rejects VAT-itemized manual invoices when trader lacks verified UK VAT registration", async () => {
      expect(evaluateVatEligibility({ uid: "t1" }).eligible).toBe(false);
      expect(evaluateVatEligibility({ vatRegistered: true, vatNumber: "INVALID" }).eligible).toBe(false);
      expect(evaluateVatEligibility({ vatRegistered: true, vatNumber: "GB 123 456 789" }).vatNumber).toBe("GB123456789");

      const db = createInMemoryDb({
        "users/trader_no_vat": { uid: "trader_no_vat", role: "tradesperson", businessName: "NoVAT Plumbing" },
        "users/trader_vat_ok": {
          uid: "trader_vat_ok",
          role: "tradesperson",
          businessName: "Pro Heat Ltd",
          vatRegistered: true,
          vatVerificationStatus: "verified",
          vatNumber: "GB123456789",
        },
      });

      const noVatIdentity = makeIdentity({ uid: "trader_no_vat" });
      await expect(
        createManualInvoiceCommand({
          db,
          identity: noVatIdentity,
          rawBody: {
            clientName: "Alice",
            title: "Tap fix",
            items: [{ description: "Labour", amount: 100 }],
            includeVat: true,
            vatRate: 20,
          },
        })
      ).rejects.toThrow(ForbiddenError);

      // Non-VAT invoice for non-registered trader succeeds cleanly
      const zeroVatRes = await createManualInvoiceCommand({
        db,
        identity: noVatIdentity,
        rawBody: {
          clientName: "Alice",
          title: "Tap fix",
          items: [{ description: "Labour", amount: 100 }],
          includeVat: false,
        },
      });
      expect(zeroVatRes.invoice.vatRate).toBe(0);
      expect(zeroVatRes.invoice.amount).toBe(100);

      // Verified VAT trader issues 20% VAT invoice cleanly
      const vatOkIdentity = makeIdentity({ uid: "trader_vat_ok" });
      const vatRes = await createManualInvoiceCommand({
        db,
        identity: vatOkIdentity,
        rawBody: {
          clientName: "Bob",
          title: "Boiler Install",
          items: [{ description: "Install", amount: 1000 }],
          includeVat: true,
          vatRate: 20,
        },
      });
      expect(vatRes.invoice.vatRate).toBe(20);
      expect(vatRes.invoice.vatAmount).toBe(200);
      expect(vatRes.invoice.amount).toBe(1200);
      expect(vatRes.invoice.tradespersonVatNumber).toBe("GB123456789");
    });
  });
});
