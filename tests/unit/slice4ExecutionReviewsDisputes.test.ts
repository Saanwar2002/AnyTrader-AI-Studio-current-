import { describe, it, expect, beforeEach } from "vitest";
import { executeJobLifecycleCommand } from "../../src/server/jobLifecycleCommands.ts";
import { confirmMediationStakePayment } from "../../src/server/mediationStake.ts";
import {
  executeAdminResolveDisputeCommand,
  executeAdminModerateReviewCommand,
} from "../../src/server/adminControlCommands.ts";
import { publishMatureCoolingOffReviewsCommand } from "../../src/server/cronWorkers.ts";
import { isPubliclyVisibleReview } from "../../src/firebase.ts";
import type { CanonicalIdentity } from "../../src/server/identity.ts";

/**
 * In-memory Firestore mock supporting top-level collections, nested subcollections,
 * transactions, dotted-path updates, and `.where(...).limit(...).get()`.
 */
function createSlice4MockFirestore(initialData: Record<string, Record<string, any>> = {}) {
  const store: Record<string, Record<string, any>> = {};
  for (const [col, docs] of Object.entries(initialData)) {
    store[col] = {};
    for (const [id, data] of Object.entries(docs)) {
      store[col][id] = JSON.parse(JSON.stringify(data));
    }
  }

  const ensureCol = (path: string) => {
    if (!store[path]) store[path] = {};
    return store[path];
  };

  const applyDottedPatch = (target: Record<string, any>, patch: Record<string, any>) => {
    const out = JSON.parse(JSON.stringify(target || {}));
    for (const [rawKey, rawVal] of Object.entries(patch || {})) {
      const val = rawVal === undefined ? undefined : JSON.parse(JSON.stringify(rawVal));
      if (rawKey.includes(".")) {
        const parts = rawKey.split(".");
        let cursor = out;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!cursor[parts[i]] || typeof cursor[parts[i]] !== "object") {
            cursor[parts[i]] = {};
          }
          cursor = cursor[parts[i]];
        }
        cursor[parts[parts.length - 1]] = val;
      } else {
        out[rawKey] = val;
      }
    }
    return out;
  };

  const makeQuery = (colPath: string, filters: Array<{ field: string; op: string; value: any }> = [], maxDocs?: number) => ({
    colPath,
    filters,
    where(field: string, op: string, value: any) {
      return makeQuery(colPath, [...filters, { field, op, value }], maxDocs);
    },
    limit(n: number) {
      return makeQuery(colPath, filters, n);
    },
    async get() {
      const col = ensureCol(colPath);
      let entries = Object.entries(col).filter(([, d]) =>
        filters.every(({ field, op, value }) => {
          if (op === "==") return d?.[field] === value;
          if (op === "in" && Array.isArray(value)) return value.includes(d?.[field]);
          return false;
        })
      );
      if (typeof maxDocs === "number") {
        entries = entries.slice(0, maxDocs);
      }
      const docs = entries.map(([id, d]) => ({
        id,
        exists: true,
        ref: makeDocRef(colPath, id),
        data: () => JSON.parse(JSON.stringify(d)),
      }));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });

  const makeDocRef = (colPath: string, docId: string): any => ({
    colPath,
    id: docId,
    path: `${colPath}/${docId}`,
    collection(subCol: string) {
      return makeCollection(`${colPath}/${docId}/${subCol}`);
    },
    async get() {
      const col = ensureCol(colPath);
      const val = col[docId];
      return {
        id: docId,
        exists: val !== undefined,
        ref: makeDocRef(colPath, docId),
        data: () => (val !== undefined ? JSON.parse(JSON.stringify(val)) : undefined),
      };
    },
    async set(data: any, opts?: { merge?: boolean }) {
      const col = ensureCol(colPath);
      if (opts?.merge && col[docId]) {
        col[docId] = { ...col[docId], ...JSON.parse(JSON.stringify(data)) };
      } else {
        col[docId] = JSON.parse(JSON.stringify(data));
      }
    },
    async update(patch: Record<string, any>) {
      const col = ensureCol(colPath);
      if (!col[docId]) throw new Error(`Document ${colPath}/${docId} does not exist`);
      col[docId] = applyDottedPatch(col[docId], patch);
    },
    async delete() {
      const col = ensureCol(colPath);
      delete col[docId];
    },
  });

  const makeCollection = (colPath: string) => ({
    colPath,
    doc(docId?: string) {
      const id = docId || `auto_${Math.random().toString(36).slice(2, 10)}`;
      return makeDocRef(colPath, id);
    },
    where(field: string, op: string, value: any) {
      return makeQuery(colPath, [{ field, op, value }]);
    },
    limit(n: number) {
      return makeQuery(colPath, [], n);
    },
    async get() {
      return makeQuery(colPath).get();
    },
  });

  return {
    store,
    collection: (colPath: string) => makeCollection(colPath),
    async runTransaction(fn: (tx: any) => Promise<any>) {
      const tx = {
        async get(refOrQuery: any) {
          return refOrQuery.get();
        },
        set(ref: any, data: any, opts?: { merge?: boolean }) {
          const col = ensureCol(ref.colPath);
          if (opts?.merge && col[ref.id]) {
            col[ref.id] = { ...col[ref.id], ...JSON.parse(JSON.stringify(data)) };
          } else {
            col[ref.id] = JSON.parse(JSON.stringify(data));
          }
        },
        update(ref: any, patch: Record<string, any>) {
          const col = ensureCol(ref.colPath);
          if (!col[ref.id]) throw new Error(`Document ${ref.colPath}/${ref.id} does not exist`);
          col[ref.id] = applyDottedPatch(col[ref.id], patch);
        },
        delete(ref: any) {
          const col = ensureCol(ref.colPath);
          delete col[ref.id];
        },
      };
      return fn(tx);
    },
  };
}

function makeIdentity(uid: string, role: "homeowner" | "tradesperson" | "admin"): CanonicalIdentity {
  return {
    uid,
    email: `${uid}@example.com`,
    role,
    roles: [role],
    accountType: role === "tradesperson" ? "tradesperson" : "homeowner",
    isAdmin: role === "admin",
    isSuperAdmin: role === "admin",
    capabilities: new Set(),
    verification: {
      isVerified: true,
      idVerified: true,
      videoVerified: false,
      status: "verified",
    },
    subscription: {
      tier: "free",
      status: "active",
    },
    source: "firestore",
  } as unknown as CanonicalIdentity;
}

describe("Slice 4 — Job Execution, Completion, Reviews & Disputes Hardening", () => {
  let db: ReturnType<typeof createSlice4MockFirestore>;

  beforeEach(() => {
    db = createSlice4MockFirestore({
      jobs: {
        job_exec_1: {
          title: "Bathroom Tile Replacement",
          category: "Tiling",
          status: "accepted",
          homeownerId: "owner_1",
          acceptedTradespersonId: "trader_1",
          acceptedTradespersonName: "Alex Tiler",
        },
        job_in_prog_1: {
          title: "Kitchen Lighting Upgrade",
          category: "Electrical",
          status: "in_progress",
          homeownerId: "owner_1",
          acceptedTradespersonId: "trader_1",
          acceptedTradespersonName: "Alex Spark",
          dispute: {
            photos: ["https://cdn.example.com/photo1.jpg"],
            isPropertyDamage: true,
            mediationStakePaid: true,
            mediationStakeAmount: 25,
          },
        },
        job_stake_1: {
          title: "Roof Flashing Repair",
          status: "in_progress",
          homeownerId: "owner_1",
          acceptedTradespersonId: "trader_1",
          dispute: {
            raisedBy: "owner_1",
            reason: "Leak persists after rain",
            stakePaymentAttemptId: "attempt_1",
            paymentIntentId: "pi_stake_1",
            mediationStakePaid: false,
            mediationStakeAmount: 25,
            status: "awaiting_payment",
          },
        },
        job_disputed_mediated: {
          title: "Boiler Install",
          status: "disputed",
          homeownerId: "owner_1",
          acceptedTradespersonId: "trader_1",
          mediationStakePaid: true,
          dispute: {
            raisedBy: "owner_1",
            reason: "Boiler not commissioned",
            mediationStakePaid: true,
            mediationStakeAmount: 25,
            paymentIntentId: "pi_med_99",
            status: "pending_arbitration",
          },
        },
      },
      "jobs/job_disputed_mediated/quotes": {
        q_med_1: {
          tradespersonId: "trader_1",
          status: "accepted",
          milestones: [
            {
              id: "ms_1",
              title: "Deposit & First Fix",
              amount: 450,
              status: "funded",
              escrowFunded: true,
              stripePaymentIntentId: "pi_ms_1",
            },
          ],
        },
      },
      public_job_cards: {
        job_exec_1: { title: "Bathroom Tile Replacement", status: "accepted" },
        job_in_prog_1: { title: "Kitchen Lighting Upgrade", status: "in_progress" },
        job_stake_1: { title: "Roof Flashing Repair", status: "in_progress" },
        job_disputed_mediated: { title: "Boiler Install", status: "disputed" },
      },
      users: {
        owner_1: { name: "Pat Owner", role: "homeowner" },
        trader_1: {
          name: "Alex Trader",
          role: "tradesperson",
          primaryTrade: "Tiling",
          trades: ["Tiling", "Electrical"],
          rating: 5,
          totalReviews: 1,
          totalRecommendations: 1,
        },
      },
      public_profiles: {
        owner_1: { name: "Pat Owner", role: "homeowner" },
        trader_1: {
          name: "Alex Trader",
          role: "tradesperson",
          rating: 5,
          totalReviews: 1,
          totalRecommendations: 1,
        },
      },
    });
  });

  it("StartJob writes an atomic homeowner notification and transitions status to in_progress", async () => {
    const res = await executeJobLifecycleCommand({
      db,
      identity: makeIdentity("trader_1", "tradesperson"),
      command: { type: "StartJob", payload: { jobId: "job_exec_1" } },
      idempotencyKey: "start-key-1",
    });

    expect(res.success).toBe(true);
    expect(res.status).toBe("in_progress");
    expect(db.store.jobs.job_exec_1.status).toBe("in_progress");
    expect(db.store.public_job_cards.job_exec_1.status).toBe("in_progress");

    const notif = db.store.notifications?.["job_start_job_exec_1_owner_1"];
    expect(notif).toBeDefined();
    expect(notif.userId).toBe("owner_1");
    expect(notif.jobId).toBe("job_exec_1");
    expect(notif.link).toBe("/job/job_exec_1");
    expect(notif.title).toMatch(/Started/i);
  });

  it("CompleteJob writes an atomic counterparty notification when trader completes the job", async () => {
    const res = await executeJobLifecycleCommand({
      db,
      identity: makeIdentity("trader_1", "tradesperson"),
      command: {
        type: "CompleteJob",
        payload: { jobId: "job_in_prog_1", completionNotes: "All lights tested." },
      },
      idempotencyKey: "complete-key-1",
    });

    expect(res.success).toBe(true);
    expect(res.status).toBe("completed");
    expect(db.store.jobs.job_in_prog_1.status).toBe("completed");
    expect(db.store.public_job_cards.job_in_prog_1.status).toBe("completed");

    const notif = db.store.notifications?.["job_complete_job_in_prog_1_owner_1"];
    expect(notif).toBeDefined();
    expect(notif.userId).toBe("owner_1");
    expect(notif.jobId).toBe("job_in_prog_1");
    expect(notif.title).toMatch(/Completed/i);
  });

  it("RaiseJobDispute preserves existing dispute photos, damage flag, and stake metadata while saving technicalFaultReport", async () => {
    const res = await executeJobLifecycleCommand({
      db,
      identity: makeIdentity("owner_1", "homeowner"),
      command: {
        type: "RaiseJobDispute",
        payload: {
          jobId: "job_in_prog_1",
          reason: "Circuit breaker keeps tripping",
          technicalFaultReport: "RCD trips under 10A load on kitchen ring.",
        },
      },
      idempotencyKey: "dispute-key-1",
    });

    expect(res.success).toBe(true);
    expect(res.status).toBe("disputed");
    const dispute = db.store.jobs.job_in_prog_1.dispute;
    expect(dispute.reason).toBe("Circuit breaker keeps tripping");
    expect(dispute.technicalFaultReport).toBe("RCD trips under 10A load on kitchen ring.");
    expect(dispute.photos).toEqual(["https://cdn.example.com/photo1.jpg"]);
    expect(dispute.isPropertyDamage).toBe(true);
    expect(dispute.mediationStakePaid).toBe(true);
    expect(db.store.public_job_cards.job_in_prog_1.status).toBe("disputed");
  });

  it("confirmMediationStakePayment updates public_job_cards status to disputed alongside jobs and notifies counterparty", async () => {
    await confirmMediationStakePayment(db, {
      jobId: "job_stake_1",
      userId: "owner_1",
      attemptId: "attempt_1",
      paymentIntentId: "pi_stake_1",
      amountPence: 2500,
      serverTimestamp: () => "2026-11-25T10:00:00.000Z",
    });

    expect(db.store.jobs.job_stake_1.status).toBe("disputed");
    expect(db.store.jobs.job_stake_1.mediationStakePaid).toBe(true);
    expect(db.store.jobs.job_stake_1.dispute.status).toBe("pending_arbitration");
    expect(db.store.public_job_cards.job_stake_1.status).toBe("disputed");
    expect(db.store.notifications["med_stake_job_stake_1_pi_stake_1_trader_1"]).toBeDefined();
  });

  it("executeAdminResolveDisputeCommand (mediated) coordinates funded escrow cancellation & mediation stake recovery", async () => {
    const res = await executeAdminResolveDisputeCommand({
      db,
      admin: { uid: "admin_1", email: "saanwar2002@gmail.com" },
      jobId: "job_disputed_mediated",
      resolution: "mediated",
      notes: "Mutual cancellation agreed with partial remediation.",
    });

    expect(res.success).toBe(true);
    expect(res.nextStatus).toBe("cancelled");
    expect(db.store.jobs.job_disputed_mediated.status).toBe("cancelled");
    expect(db.store.public_job_cards.job_disputed_mediated.status).toBe("cancelled");
    expect(res.cancellationCoordination).toBeDefined();
    expect(res.cancellationCoordination?.frozenMilestonesCount).toBe(1);
    expect(res.cancellationCoordination?.escrowCancellationStatus).not.toBe("none");
    expect(res.cancellationCoordination?.mediationStakeRecoveryStatus).toBe("pending_review");
    expect(db.store.mediation_stake_recoveries?.["stake_cancel_job_disputed_mediated"]).toBeDefined();
    expect(db.store.jobs.job_disputed_mediated.escrowStatus).toBe("frozen_on_cancel");
  });

  it("executeAdminModerateReviewCommand resolves revieweeId, ignores cooling_off/hidden/other-type reviews, and syncs users + public_profiles", async () => {
    db.store.reviews = {
      rev_pub_5: {
        revieweeId: "trader_1",
        reviewerId: "owner_1",
        type: "tradesperson_review",
        status: "published",
        rating: 5,
        recommended: true,
        isHidden: false,
      },
      rev_pub_1: {
        revieweeId: "trader_1",
        reviewerId: "owner_2",
        type: "tradesperson_review",
        status: "published",
        rating: 1,
        recommended: false,
        isHidden: false,
      },
      rev_cooling_2: {
        revieweeId: "trader_1",
        reviewerId: "owner_3",
        type: "tradesperson_review",
        status: "cooling_off",
        rating: 2,
        recommended: false,
        isHidden: false,
      },
      rev_other_type: {
        revieweeId: "trader_1",
        reviewerId: "trader_2",
        type: "homeowner_review",
        status: "published",
        rating: 3,
        isHidden: false,
      },
    };

    const res = await executeAdminModerateReviewCommand({
      db,
      admin: { uid: "admin_1", email: "saanwar2002@gmail.com" },
      reviewId: "rev_pub_1",
      action: "hide",
      reason: "Abusive language",
    });

    expect(res.success).toBe(true);
    expect(db.store.reviews.rev_pub_1.isHidden).toBe(true);
    expect(db.store.reviews.rev_pub_1.status).toBe("hidden");
    expect(db.store.users.trader_1.rating).toBe(5);
    expect(db.store.users.trader_1.totalReviews).toBe(1);
    expect(db.store.users.trader_1.totalRecommendations).toBe(1);
    expect(db.store.public_profiles.trader_1.rating).toBe(5);
    expect(db.store.public_profiles.trader_1.totalReviews).toBe(1);
    expect(db.store.public_profiles.trader_1.totalRecommendations).toBe(1);
  });

  it("publishMatureCoolingOffReviewsCommand promotes only mature non-hidden reviews and syncs users + public_profiles + notification", async () => {
    const nowMs = Date.parse("2026-11-25T12:00:00.000Z");
    db.store.reviews = {
      rev_mature: {
        revieweeId: "trader_1",
        reviewerId: "owner_2",
        jobId: "job_exec_1",
        type: "tradesperson_review",
        status: "cooling_off",
        rating: 1,
        recommended: false,
        isHidden: false,
        publishAt: "2026-11-24T12:00:00.000Z",
      },
      rev_immature: {
        revieweeId: "trader_1",
        reviewerId: "owner_3",
        jobId: "job_exec_2",
        type: "tradesperson_review",
        status: "cooling_off",
        rating: 2,
        recommended: false,
        isHidden: false,
        publishAt: "2026-12-02T12:00:00.000Z",
      },
      rev_hidden_mature: {
        revieweeId: "trader_1",
        reviewerId: "owner_4",
        jobId: "job_exec_3",
        type: "tradesperson_review",
        status: "cooling_off",
        rating: 1,
        recommended: false,
        isHidden: true,
        publishAt: "2026-11-20T12:00:00.000Z",
      },
    };

    const summary = await publishMatureCoolingOffReviewsCommand(db, { nowMs });

    expect(summary.worker).toBe("cooling_off_reviews");
    expect(summary.status).toBe("executed");
    expect(summary.executedCount).toBe(1);
    expect(summary.skippedCount).toBe(2);

    expect(db.store.reviews.rev_mature.status).toBe("published");
    expect(db.store.reviews.rev_immature.status).toBe("cooling_off");
    expect(db.store.reviews.rev_hidden_mature.status).toBe("cooling_off");

    // Existing trader_1 had 1 review @ 5.0; adding 1 review @ 1.0 => avg 3.0, totalReviews 2
    expect(db.store.users.trader_1.rating).toBe(3);
    expect(db.store.users.trader_1.totalReviews).toBe(2);
    expect(db.store.public_profiles.trader_1.rating).toBe(3);
    expect(db.store.public_profiles.trader_1.totalReviews).toBe(2);

    const notif = db.store.notifications?.["review_pub_rev_mature_trader_1"];
    expect(notif).toBeDefined();
    expect(notif.userId).toBe("trader_1");
    expect(notif.title).toBe("Review Published");
  });

  it("isPubliclyVisibleReview excludes hidden, cooling_off, rejected, and isHidden=true reviews while allowing published/legacy reviews", () => {
    expect(isPubliclyVisibleReview({ status: "published", isHidden: false })).toBe(true);
    expect(isPubliclyVisibleReview({ rating: 5 })).toBe(true);
    expect(isPubliclyVisibleReview({ status: "cooling_off" })).toBe(false);
    expect(isPubliclyVisibleReview({ status: "hidden" })).toBe(false);
    expect(isPubliclyVisibleReview({ status: "rejected" })).toBe(false);
    expect(isPubliclyVisibleReview({ status: "published", isHidden: true })).toBe(false);
    expect(isPubliclyVisibleReview(null)).toBe(false);
  });
});
