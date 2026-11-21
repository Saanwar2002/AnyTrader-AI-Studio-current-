import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  executeQuoteCommand,
  reconcileMilestonesToAmount,
} from "../../src/server/quoteCommands.ts";
import {
  executeCreateJobCommand,
  executeUpdateJobCommand,
} from "../../src/server/createJobCommand.ts";
import { executeJobLifecycleCommand } from "../../src/server/jobLifecycleCommands.ts";
import { confirmMediationStakePayment } from "../../src/server/mediationStake.ts";
import { PaymentLedgerEngine } from "../../src/server/paymentLedger.ts";
import { BusinessLogicDefense } from "../../src/server/businessLogicDefense.ts";
import { calculateInvoiceSummary } from "../../src/services/invoiceService.ts";
import { CanonicalIdentity } from "../../src/server/identity.ts";

function createMockFirestore(initialData: Record<string, any> = {}) {
  const store: Record<string, any> = JSON.parse(JSON.stringify(initialData));

  const db: any = {
    _store: store,
    collection(collectionPath: string) {
      return {
        path: collectionPath,
        doc(docId?: string) {
          const actualDocId =
            docId || `doc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          const fullPath = `${collectionPath}/${actualDocId}`;
          return {
            id: actualDocId,
            path: fullPath,
            collection(subCollection: string) {
              return db.collection(`${fullPath}/${subCollection}`);
            },
            async get() {
              const data = store[fullPath];
              return {
                id: actualDocId,
                exists: data !== undefined && data !== null,
                data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
              };
            },
            async set(data: any, options?: { merge?: boolean }) {
              if (options?.merge && store[fullPath]) {
                store[fullPath] = { ...store[fullPath], ...JSON.parse(JSON.stringify(data)) };
              } else {
                store[fullPath] = JSON.parse(JSON.stringify(data));
              }
            },
            async update(data: any) {
              if (!store[fullPath]) throw new Error(`Document not found: ${fullPath}`);
              store[fullPath] = { ...store[fullPath], ...JSON.parse(JSON.stringify(data)) };
            },
            async delete() {
              delete store[fullPath];
            },
          };
        },
        where(field: string, op: string, value: any) {
          return {
            async get() {
              const docs: any[] = [];
              const prefix = `${collectionPath}/`;
              for (const [k, v] of Object.entries(store)) {
                if (k.startsWith(prefix) && !k.substring(prefix.length).includes("/")) {
                  if (op === "==" && v && v[field] === value) {
                    docs.push({
                      id: k.substring(prefix.length),
                      exists: true,
                      data: () => JSON.parse(JSON.stringify(v)),
                    });
                  }
                }
              }
              return { docs, empty: docs.length === 0, size: docs.length };
            },
          };
        },
      };
    },
    async runTransaction(updateFunction: (transaction: any) => Promise<any>) {
      const transaction = {
        async get(docRef: any) {
          return docRef.get();
        },
        set(docRef: any, data: any, options?: { merge?: boolean }) {
          docRef.set(data, options);
        },
        update(docRef: any, data: any) {
          docRef.update(data);
        },
        delete(docRef: any) {
          docRef.delete();
        },
      };
      return updateFunction(transaction);
    },
  };

  return db;
}

const homeownerIdentity: CanonicalIdentity = {
  uid: "homeowner_1",
  accountType: "consumer",
  capabilities: ["homeowner"],
  email: "homeowner@example.com",
  verification: { status: "verified", verifiedAt: null, expiresAt: null },
  subscription: { tierId: "PAYG", status: "active", isFoundingMember: false, validUntil: null },
};

const traderIdentity: CanonicalIdentity = {
  uid: "trader_1",
  accountType: "service_provider",
  capabilities: ["tradesperson"],
  email: "trader@example.com",
  verification: { status: "verified", verifiedAt: null, expiresAt: null },
  subscription: { tierId: "PAYG", status: "active", isFoundingMember: false, validUntil: null },
};

describe("Batch 11: Marketplace Jobs, Quotes, Milestones, Reviews & Invoices", () => {
  it("AT-QUOTE-05: RejectQuote decrements quoteCount/quotesCount atomically and resets status to open when 0", async () => {
    const db = createMockFirestore({
      "jobs/job_1": {
        id: "job_1",
        homeownerId: "homeowner_1",
        status: "quoted",
        quoteCount: 1,
        quotesCount: 1,
        hasQuotes: true,
      },
      "jobs/job_1/quotes/q_1": {
        id: "q_1",
        jobId: "job_1",
        tradespersonId: "trader_1",
        status: "pending",
        amount: 250,
      },
    });

    await executeQuoteCommand({
      db,
      identity: homeownerIdentity,
      command: { type: "RejectQuote", payload: { jobId: "job_1", quoteId: "q_1", reason: "Too high" } },
      idempotencyKey: "reject-idem-123456",
    });

    expect(db._store["jobs/job_1/quotes/q_1"].status).toBe("rejected");
    expect(db._store["jobs/job_1"].quoteCount).toBe(0);
    expect(db._store["jobs/job_1"].quotesCount).toBe(0);
    expect(db._store["jobs/job_1"].hasQuotes).toBe(false);
    expect(db._store["jobs/job_1"].status).toBe("open");
  });

  it("AT-QUOTE-06: reconcileMilestonesToAmount and UpdateQuote proportionally keep milestone sums equal to contract total", async () => {
    const scaled = reconcileMilestonesToAmount(
      [
        { id: "m1", title: "Deposit", amount: 100, status: "pending" },
        { id: "m2", title: "Completion", amount: 200, status: "pending" },
      ],
      600
    );
    expect(scaled.reduce((s, m) => s + m.amount, 0)).toBe(600);
    expect(scaled[0].amount).toBe(200);
    expect(scaled[1].amount).toBe(400);

    const db = createMockFirestore({
      "jobs/job_2": {
        id: "job_2",
        homeownerId: "homeowner_1",
        status: "quoted",
        quoteCount: 1,
      },
      "jobs/job_2/quotes/q_2": {
        id: "q_2",
        jobId: "job_2",
        tradespersonId: "trader_1",
        status: "pending",
        amount: 300,
        milestones: [
          { id: "m1", title: "Deposit", amount: 100, status: "pending" },
          { id: "m2", title: "Completion", amount: 200, status: "pending" },
        ],
      },
    });

    await executeQuoteCommand({
      db,
      identity: traderIdentity,
      command: { type: "UpdateQuote", payload: { jobId: "job_2", quoteId: "q_2", amount: 450 } },
      idempotencyKey: "update-quote-123456",
    });

    const updatedMilestones = db._store["jobs/job_2/quotes/q_2"].milestones;
    const sum = updatedMilestones.reduce((s: number, m: any) => s + Number(m.amount), 0);
    expect(sum).toBe(450);
  });

  it("AT-CJ-QUOTE-UI-02: CreateQuote exempts explicit direct 1-to-1 invited trader past 5-quote cap while blocking uninvited trader", async () => {
    const db = createMockFirestore({
      "users/invited_trader": { uid: "invited_trader", primaryTrade: "Plumbing" },
      "users/stranger_trader": { uid: "stranger_trader", primaryTrade: "Plumbing" },
      "jobs/job_cap": {
        id: "job_cap",
        homeownerId: "homeowner_1",
        category: "Plumbing",
        status: "quoted",
        quoteCount: 5,
        directTraderId: "invited_trader",
      },
    });

    await expect(
      executeQuoteCommand({
        db,
        identity: {
          uid: "stranger_trader",
          accountType: "service_provider",
          capabilities: ["tradesperson"],
          verification: { status: "verified", verifiedAt: null, expiresAt: null },
          subscription: { tierId: "PAYG", status: "active", isFoundingMember: false, validUntil: null },
        },
        command: {
          type: "CreateQuote",
          payload: { jobId: "job_cap", amount: 200, message: "Uninvited bid" },
        },
        idempotencyKey: "stranger-quote-123456",
      })
    ).rejects.toThrow(/target|exclusive|limit|maximum/i);

    const invitedRes = await executeQuoteCommand({
      db,
      identity: {
        uid: "invited_trader",
        accountType: "service_provider",
        capabilities: ["tradesperson"],
        verification: { status: "verified", verifiedAt: null, expiresAt: null },
        subscription: { tierId: "PAYG", status: "active", isFoundingMember: false, validUntil: null },
      },
      command: {
        type: "CreateQuote",
        payload: { jobId: "job_cap", amount: 220, message: "Invited direct bid" },
      },
      idempotencyKey: "invited-quote-123456",
    });
    expect(invitedRes.quote.tradespersonId).toBe("invited_trader");
  });

  it("AT-CJ-JOB-07 & AT-CJ-REVIEW-05: CreateJob initializes normalized review flags and executeUpdateJobCommand atomically updates job & public_job_cards", async () => {
    const db = createMockFirestore({
      "users/homeowner_1": { uid: "homeowner_1", role: "homeowner", name: "Alice" },
    });

    const created = await executeCreateJobCommand({
      db,
      identity: homeownerIdentity,
      rawPayload: {
        title: "Fix kitchen sink leak",
        description: "Tap is dripping constantly underneath the cabinet.",
        category: "Plumbing",
        postcode: "SW1A 1AA",
        urgency: "standard",
      },
      idempotencyKey: "create-job-123456",
    });

    expect(created.job.hasReview).toBe(false);
    expect(created.job.hasHomeownerReview).toBe(false);
    expect(created.job.hasTradespersonReview).toBe(false);
    expect(db._store[`public_job_cards/${created.jobId}`]).toBeDefined();

    const updated = await executeUpdateJobCommand({
      db,
      identity: homeownerIdentity,
      jobId: created.jobId,
      rawPayload: {
        title: "Replace kitchen mixer tap completely",
        description: "Updated scope: full mixer tap swap needed.",
        status: "completed", // should be stripped (not in JOB_UPDATE_ALLOWED_FIELDS)
      },
    });

    expect(updated.publicCardSynced).toBe(true);
    expect(db._store[`jobs/${created.jobId}`].title).toBe("Replace kitchen mixer tap completely");
    expect(db._store[`jobs/${created.jobId}`].status).toBe("open");
    expect(db._store[`public_job_cards/${created.jobId}`].title).toBe("Replace kitchen mixer tap completely");
  });

  it("AT-CJ-COMPLETE-01 & AT-CJ-REVIEW-05: CompleteJob computes trader completion metrics server-side and preserves review flags", async () => {
    const db = createMockFirestore({
      "users/trader_1": {
        uid: "trader_1",
        totalJobsDone: 4,
        completedJobs: 4,
        completedJobsRevenue: 800,
        phantomFeesSaved: 96,
      },
      "public_profiles/trader_1": {
        uid: "trader_1",
        totalJobsDone: 4,
        completedJobs: 4,
      },
      "jobs/job_comp": {
        id: "job_comp",
        title: "Boiler check",
        homeownerId: "homeowner_1",
        acceptedTradespersonId: "trader_1",
        acceptedTraderId: "trader_1",
        acceptedQuoteId: "q_comp",
        status: "in_progress",
        amount: 300,
      },
      "jobs/job_comp/quotes/q_comp": {
        id: "q_comp",
        jobId: "job_comp",
        tradespersonId: "trader_1",
        status: "accepted",
        amount: 300,
      },
    });

    await executeJobLifecycleCommand({
      db,
      identity: homeownerIdentity,
      command: { type: "CompleteJob", payload: { jobId: "job_comp" } },
      idempotencyKey: "complete-job-123456",
    });

    expect(db._store["jobs/job_comp"].status).toBe("completed");
    expect(db._store["jobs/job_comp"].hasHomeownerReview).toBe(false);
    expect(db._store["users/trader_1"].totalJobsDone).toBe(5);
    expect(db._store["users/trader_1"].completedJobs).toBe(5);
    expect(db._store["users/trader_1"].completedJobsRevenue).toBe(1100);
    expect(db._store["public_profiles/trader_1"].completedJobs).toBe(5);
  });

  it("AT-CJ-NOTIF-04 & AT-CJ-DISPUTE-04: CancelJob, RaiseJobDispute, and confirmMediationStakePayment write atomic counterpart notifications", async () => {
    const db = createMockFirestore({
      "jobs/job_n1": {
        id: "job_n1",
        title: "Rewire hallway",
        homeownerId: "homeowner_1",
        acceptedTradespersonId: "trader_1",
        status: "accepted",
      },
      "jobs/job_n2": {
        id: "job_n2",
        title: "Fence repair",
        homeownerId: "homeowner_1",
        acceptedTradespersonId: "trader_1",
        status: "in_progress",
      },
      "jobs/job_n3": {
        id: "job_n3",
        title: "Roofing job",
        homeownerId: "homeowner_1",
        acceptedTradespersonId: "trader_1",
        status: "disputed",
        dispute: {
          raisedBy: "homeowner_1",
          stakePaymentAttemptId: "att_1",
          paymentIntentId: "pi_1",
        },
      },
    });

    await executeJobLifecycleCommand({
      db,
      identity: homeownerIdentity,
      command: { type: "CancelJob", payload: { jobId: "job_n1", reason: "Schedule clash" } },
      idempotencyKey: "cancel-notif-123456",
    });
    expect(db._store["notifications/job_cancel_job_n1_trader_1"]).toBeDefined();
    expect(db._store["notifications/job_cancel_job_n1_trader_1"].userId).toBe("trader_1");

    await executeJobLifecycleCommand({
      db,
      identity: traderIdentity,
      command: { type: "RaiseJobDispute", payload: { jobId: "job_n2", reason: "Access blocked" } },
      idempotencyKey: "dispute-notif-123456",
    });
    expect(db._store["notifications/job_dispute_job_n2_homeowner_1"]).toBeDefined();
    expect(db._store["notifications/job_dispute_job_n2_homeowner_1"].userId).toBe("homeowner_1");

    await confirmMediationStakePayment(db, {
      jobId: "job_n3",
      userId: "homeowner_1",
      attemptId: "att_1",
      paymentIntentId: "pi_1",
      serverTimestamp: () => "2026-11-20T00:00:00Z",
    });
    expect(db._store["notifications/med_stake_job_n3_pi_1_trader_1"]).toBeDefined();
    expect(db._store["notifications/med_stake_job_n3_pi_1_trader_1"].userId).toBe("trader_1");
  });

  it("AT-CJ-MILESTONE-01: End-to-end milestone work submission, revision/approval, and BusinessLogicDefense escrow release eligibility", async () => {
    const db = createMockFirestore({
      "jobs/job_ms": {
        id: "job_ms",
        title: "Bathroom tiling",
        homeownerId: "homeowner_1",
        acceptedTradespersonId: "trader_1",
        acceptedQuoteId: "q_ms",
        status: "in_progress",
      },
      "jobs/job_ms/quotes/q_ms": {
        id: "q_ms",
        jobId: "job_ms",
        tradespersonId: "trader_1",
        status: "accepted",
        amount: 500,
        milestones: [
          {
            id: "ms_1",
            title: "Wall tiling",
            amount: 500,
            status: "funded",
          },
        ],
      },
    });

    const submitted = await PaymentLedgerEngine.submitMilestoneWork(db, {
      jobId: "job_ms",
      quoteId: "q_ms",
      milestoneId: "ms_1",
      authUid: "trader_1",
      deliverableNotes: "Completed wall tiling and grouted seams.",
    });
    expect(submitted.status).toBe("submitted");
    expect(db._store["notifications/ms_submit_job_ms_ms_1_1"]?.userId).toBe("homeowner_1");

    const revision = await PaymentLedgerEngine.reviewMilestoneWork(db, {
      jobId: "job_ms",
      quoteId: "q_ms",
      milestoneId: "ms_1",
      authUid: "homeowner_1",
      decision: "request_revision",
      revisionReason: "Please re-seal corner edge",
    });
    expect(revision.status).toBe("in_progress");
    expect(db._store["notifications/ms_rev_job_ms_ms_1_1"]?.userId).toBe("trader_1");

    await PaymentLedgerEngine.submitMilestoneWork(db, {
      jobId: "job_ms",
      quoteId: "q_ms",
      milestoneId: "ms_1",
      authUid: "trader_1",
      deliverableNotes: "Re-sealed corner edge cleanly.",
    });

    const approved = await PaymentLedgerEngine.reviewMilestoneWork(db, {
      jobId: "job_ms",
      quoteId: "q_ms",
      milestoneId: "ms_1",
      authUid: "homeowner_1",
      decision: "approve",
    });
    expect(approved.status).toBe("approved");
    expect(approved.milestone.payoutUnlocked).toBe(true);
    expect(() =>
      BusinessLogicDefense.validateEscrowReleaseEligibility(
        db._store["jobs/job_ms"],
        approved.milestone
      )
    ).not.toThrow();
  });

  it("AT-CJ-INVOICE-08: calculateInvoiceSummary produces itemized lines that sum exactly to subtotal and grand total", () => {
    const math = calculateInvoiceSummary(
      { amount: 250.33 },
      { materialsCost: 49.67 },
      { tierId: "payg", isVatRegistered: true, vatNumber: "GB123456789" }
    );
    expect(Number((math.netLaborLine + math.materialsAmount + math.platformFee).toFixed(2))).toBe(
      math.subtotal
    );
    expect(Number((math.subtotal + math.vatAmount).toFixed(2))).toBe(math.totalAmount);
  });

  it("Static verification of Batch 11 UI & server contracts (AT-CJ-QUOTE-UI-01/03/04/05/06, AT-CJ-JOB-08/09, AT-CJ-TIMELINE-01, AT-CJ-REVIEW-04)", () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");

    const jobDetails = read("src/components/JobDetails.tsx");
    expect(jobDetails).not.toContain("48 * 60 * 60 * 1000"); // AT-CJ-QUOTE-UI-04
    expect(jobDetails).toContain("isJobOpenForQuotes"); // AT-CJ-QUOTE-UI-01/03
    expect(jobDetails).toContain("confirmReleaseMilestoneId"); // AT-CJ-MILESTONE-01 safe confirm
    expect(jobDetails).toContain('job.status === "in_progress"'); // AT-CJ-JOB-09
    expect(jobDetails).toContain("submitMilestoneWorkViaApi"); // AT-CJ-MILESTONE-01
    expect(jobDetails).toContain("reviewMilestoneWorkViaApi");

    const myQuotes = read("src/components/MyQuotes.tsx");
    expect(myQuotes).not.toContain("48 * 60 * 60 * 1000"); // AT-CJ-QUOTE-UI-04
    expect(myQuotes).toContain("onSnapshot"); // AT-CJ-QUOTE-UI-05
    expect(myQuotes).toContain("requote_requested"); // AT-CJ-QUOTE-UI-06

    const timeline = read("src/components/JobTimeline.tsx");
    expect(timeline).toContain("open"); // AT-CJ-TIMELINE-01
    expect(timeline).toContain("cancelled");

    const reviewReminder = read("src/components/ReviewReminder.tsx");
    expect(reviewReminder).toContain("jobData.hasHomeownerReview === true"); // AT-CJ-REVIEW-05

    const postWizard = read("src/components/PostJobWizard.tsx");
    expect(postWizard).toContain("updateJobViaCommand"); // AT-CJ-JOB-07

    const serverSrc = read("server.ts");
    expect(serverSrc).toContain("/api/jobs/:jobId/update"); // AT-CJ-JOB-07
    expect(serverSrc).toContain("/api/milestones/submit-work"); // AT-CJ-MILESTONE-01
    expect(serverSrc).toContain("/api/milestones/review-work");
    expect(serverSrc).toContain("hasHomeownerReview: true"); // AT-CJ-REVIEW-04
  });
});
