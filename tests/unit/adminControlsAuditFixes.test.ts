import { describe, it, expect, beforeEach } from "vitest";
import {
  executeAdminResolveDisputeCommand,
  executeAdminVideoVerificationCommand,
  executeAdminProvisionalOverrideCommand,
  executeAdminModerateReviewCommand,
} from "../../src/server/adminControlCommands.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../src/server/httpErrors.ts";

/**
 * Minimal in-memory Firestore mock supporting collections, docs, transactions, and simple equality queries.
 */
function createMockFirestore(initialData: Record<string, Record<string, any>> = {}) {
  const store: Record<string, Record<string, any>> = {};
  for (const [col, docs] of Object.entries(initialData)) {
    store[col] = {};
    for (const [id, data] of Object.entries(docs)) {
      store[col][id] = JSON.parse(JSON.stringify(data));
    }
  }

  const ensureCol = (name: string) => {
    if (!store[name]) store[name] = {};
    return store[name];
  };

  const makeDocRef = (colName: string, docId: string) => ({
    colName,
    id: docId,
    async get() {
      const col = ensureCol(colName);
      const val = col[docId];
      return {
        id: docId,
        exists: val !== undefined,
        data: () => (val !== undefined ? JSON.parse(JSON.stringify(val)) : undefined),
      };
    },
    async set(data: any, opts?: { merge?: boolean }) {
      const col = ensureCol(colName);
      if (opts?.merge && col[docId]) {
        col[docId] = { ...col[docId], ...JSON.parse(JSON.stringify(data)) };
      } else {
        col[docId] = JSON.parse(JSON.stringify(data));
      }
    },
    async delete() {
      const col = ensureCol(colName);
      delete col[docId];
    },
  });

  const db = {
    store,
    collection(colName: string) {
      return {
        doc(docId: string) {
          return makeDocRef(colName, docId);
        },
        where(field: string, op: string, value: any) {
          return {
            async get() {
              const col = ensureCol(colName);
              const docs = Object.entries(col)
                .filter(([, d]) => (op === "==" ? d[field] === value : false))
                .map(([id, d]) => ({
                  id,
                  exists: true,
                  data: () => JSON.parse(JSON.stringify(d)),
                }));
              return { docs };
            },
          };
        },
      };
    },
    async runTransaction(fn: (tx: any) => Promise<any>) {
      const tx = {
        async get(ref: ReturnType<typeof makeDocRef>) {
          return ref.get();
        },
        set(ref: ReturnType<typeof makeDocRef>, data: any, opts?: { merge?: boolean }) {
          const col = ensureCol(ref.colName);
          if (opts?.merge && col[ref.id]) {
            col[ref.id] = { ...col[ref.id], ...JSON.parse(JSON.stringify(data)) };
          } else {
            col[ref.id] = JSON.parse(JSON.stringify(data));
          }
        },
        delete(ref: ReturnType<typeof makeDocRef>) {
          const col = ensureCol(ref.colName);
          delete col[ref.id];
        },
      };
      return fn(tx);
    },
  };

  return db;
}

const ADMIN_ACTOR = { uid: "admin-1", email: "saanwar2002@gmail.com" };

describe("AnyTrader Admin Controls Audit Remediation Commands", () => {
  let db: ReturnType<typeof createMockFirestore>;

  beforeEach(() => {
    db = createMockFirestore({
      jobs: {
        job_disputed_1: {
          title: "Kitchen Tap Leak",
          status: "disputed",
          homeownerId: "homeowner_1",
          acceptedTradespersonId: "trader_1",
          dispute: {
            reason: "Pipe still dripping after repair",
            status: "open",
            createdAt: "2026-10-01T10:00:00.000Z",
          },
        },
        job_open_1: {
          title: "Garden Fencing",
          status: "posted",
          homeownerId: "homeowner_1",
        },
      },
      public_job_cards: {
        job_disputed_1: {
          title: "Kitchen Tap Leak",
          status: "disputed",
        },
      },
      users: {
        trader_video_ok: {
          name: "Sam Painter",
          role: "tradesperson",
          trades: ["Painting & Decorating"],
          videoVerificationStatus: "pending",
          videoVerificationUrl: "https://storage.googleapis.com/anytrader/videos/sam.mp4",
        },
        trader_video_missing: {
          name: "No Video Trader",
          role: "tradesperson",
          trades: ["Gardening"],
          videoVerificationStatus: "pending",
          videoVerificationUrl: "javascript:alert(1)",
        },
        trader_non_regulated: {
          name: "Alex Decorator",
          role: "tradesperson",
          trades: ["Painting & Decorating"],
          verificationStatus: "provisional",
          duplicatePhoneFingerprintDetected: true,
        },
        trader_regulated_gas: {
          name: "Eddie Electrician",
          role: "tradesperson",
          trades: ["Electrical"],
          verificationStatus: "pending",
          duplicatePhoneFingerprintDetected: true,
        },
        trader_reviewed: {
          name: "Rated Plumber",
          role: "tradesperson",
          rating: 3.0,
          totalReviews: 2,
        },
      },
      public_profiles: {
        trader_video_ok: {
          name: "Sam Painter",
          isVideoVerified: false,
        },
        trader_reviewed: {
          name: "Rated Plumber",
          rating: 3.0,
          totalReviews: 2,
        },
      },
      reviews: {
        rev_good: {
          targetId: "trader_reviewed",
          rating: 5,
          comment: "Excellent work",
          status: "published",
          isHidden: false,
        },
        rev_spam: {
          targetId: "trader_reviewed",
          rating: 1,
          comment: "Spam abusive review",
          status: "published",
          isHidden: false,
        },
      },
    });
  });

  describe("1. executeAdminResolveDisputeCommand", () => {
    it("resolves a disputed job to completed, syncs public_job_cards, notifies both parties, and logs audit records", async () => {
      const result = await executeAdminResolveDisputeCommand({
        db,
        admin: ADMIN_ACTOR,
        jobId: "job_disputed_1",
        resolution: "resolved",
        notes: "Verified completion photos; releasing escrow.",
      });

      expect(result.success).toBe(true);
      expect(result.nextStatus).toBe("completed");
      expect(result.notifiedUserIds).toEqual(["homeowner_1", "trader_1"]);

      expect(db.store.jobs.job_disputed_1.status).toBe("completed");
      expect(db.store.jobs.job_disputed_1.dispute.status).toBe("resolved");
      expect(db.store.jobs.job_disputed_1.dispute.adminNotes).toContain("Verified completion photos");
      expect(db.store.public_job_cards.job_disputed_1.status).toBe("completed");

      const notifs = Object.values(db.store.notifications || {});
      expect(notifs).toHaveLength(2);
      expect(notifs.map((n: any) => n.userId).sort()).toEqual(["homeowner_1", "trader_1"]);
      expect(Object.keys(db.store.admin_audit_logs || {}).length).toBeGreaterThanOrEqual(1);
      expect(Object.keys(db.store.audit_logs || {}).length).toBeGreaterThanOrEqual(1);
    });

    it("mediates a disputed job to cancelled with projection sync", async () => {
      const result = await executeAdminResolveDisputeCommand({
        db,
        admin: ADMIN_ACTOR,
        jobId: "job_disputed_1",
        resolution: "mediated",
        notes: "Mutual cancellation agreed.",
      });

      expect(result.nextStatus).toBe("cancelled");
      expect(db.store.jobs.job_disputed_1.status).toBe("cancelled");
      expect(db.store.public_job_cards.job_disputed_1.status).toBe("cancelled");
    });

    it("rejects resolving a non-disputed job", async () => {
      await expect(
        executeAdminResolveDisputeCommand({
          db,
          admin: ADMIN_ACTOR,
          jobId: "job_open_1",
          resolution: "resolved",
        })
      ).rejects.toThrow(BadRequestError);
    });

    it("throws NotFoundError for nonexistent job", async () => {
      await expect(
        executeAdminResolveDisputeCommand({
          db,
          admin: ADMIN_ACTOR,
          jobId: "missing_job",
          resolution: "resolved",
        })
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe("2. executeAdminVideoVerificationCommand", () => {
    it("approves valid video verification and syncs users + public_profiles + notification", async () => {
      const result = await executeAdminVideoVerificationCommand({
        db,
        admin: ADMIN_ACTOR,
        targetUid: "trader_video_ok",
        decision: "verified",
      });

      expect(result.success).toBe(true);
      expect(result.videoVerificationStatus).toBe("verified");
      expect(db.store.users.trader_video_ok.isVideoVerified).toBe(true);
      expect(db.store.users.trader_video_ok.videoVerificationStatus).toBe("verified");
      expect(db.store.public_profiles.trader_video_ok.isVideoVerified).toBe(true);
      expect(Object.values(db.store.notifications || {})).toHaveLength(1);
    });

    it("blocks approving video verification when URL is missing or unsafe (javascript: scheme)", async () => {
      await expect(
        executeAdminVideoVerificationCommand({
          db,
          admin: ADMIN_ACTOR,
          targetUid: "trader_video_missing",
          decision: "verified",
        })
      ).rejects.toThrow(BadRequestError);
    });

    it("rejects video verification cleanly with reason", async () => {
      const result = await executeAdminVideoVerificationCommand({
        db,
        admin: ADMIN_ACTOR,
        targetUid: "trader_video_missing",
        decision: "rejected",
        reason: "Video unreadable",
      });

      expect(result.videoVerificationStatus).toBe("rejected");
      expect(db.store.users.trader_video_missing.isVideoVerified).toBe(false);
      expect(db.store.users.trader_video_missing.videoVerificationRejectionReason).toBe("Video unreadable");
    });
  });

  describe("3. executeAdminProvisionalOverrideCommand", () => {
    it("extends document grace period for non-regulated trader", async () => {
      const result = await executeAdminProvisionalOverrideCommand({
        db,
        admin: ADMIN_ACTOR,
        targetUid: "trader_non_regulated",
        action: "extend_grace",
        extendDays: 14,
      });

      expect(result.success).toBe(true);
      expect(result.verificationStatus).toBe("provisional");
      expect(result.documentGraceDeadlineAt).toBeTruthy();
      expect(db.store.users.trader_non_regulated.documentGraceDeadlineAt).toBe(result.documentGraceDeadlineAt);
    });

    it("strictly forbids extending provisional grace period for regulated trades (Gas & Heating)", async () => {
      await expect(
        executeAdminProvisionalOverrideCommand({
          db,
          admin: ADMIN_ACTOR,
          targetUid: "trader_regulated_gas",
          action: "extend_grace",
          extendDays: 14,
        })
      ).rejects.toThrow(ForbiddenError);
    });

    it("clears duplicate phone flag and activates provisional only for non-regulated trader", async () => {
      const nonReg = await executeAdminProvisionalOverrideCommand({
        db,
        admin: ADMIN_ACTOR,
        targetUid: "trader_non_regulated",
        action: "clear_duplicate_phone",
      });
      expect(nonReg.duplicatePhoneFingerprintDetected).toBe(false);
      expect(nonReg.verificationStatus).toBe("provisional");

      const reg = await executeAdminProvisionalOverrideCommand({
        db,
        admin: ADMIN_ACTOR,
        targetUid: "trader_regulated_gas",
        action: "clear_duplicate_phone",
      });
      expect(reg.duplicatePhoneFingerprintDetected).toBe(false);
      expect(reg.verificationStatus).toBe("pending");
      expect(db.store.users.trader_regulated_gas.requiresAdminVerification).toBe(true);
    });
  });

  describe("4. executeAdminModerateReviewCommand", () => {
    it("hides a spam review and atomically recalculates trader rating on users and public_profiles", async () => {
      const hidden = await executeAdminModerateReviewCommand({
        db,
        admin: ADMIN_ACTOR,
        reviewId: "rev_spam",
        action: "hide",
        reason: "Abusive content",
      });

      expect(hidden.success).toBe(true);
      expect(hidden.recalculatedRating).toBe(5);
      expect(hidden.recalculatedTotalReviews).toBe(1);
      expect(db.store.reviews.rev_spam.isHidden).toBe(true);
      expect(db.store.users.trader_reviewed.rating).toBe(5);
      expect(db.store.users.trader_reviewed.totalReviews).toBe(1);
      expect(db.store.public_profiles.trader_reviewed.rating).toBe(5);

      const restored = await executeAdminModerateReviewCommand({
        db,
        admin: ADMIN_ACTOR,
        reviewId: "rev_spam",
        action: "restore",
      });
      expect(restored.recalculatedRating).toBe(3);
      expect(restored.recalculatedTotalReviews).toBe(2);
    });

    it("deletes a review permanently and updates trader rating accurately", async () => {
      const deleted = await executeAdminModerateReviewCommand({
        db,
        admin: ADMIN_ACTOR,
        reviewId: "rev_spam",
        action: "delete",
        reason: "Confirmed fake review",
      });

      expect(deleted.recalculatedRating).toBe(5);
      expect(deleted.recalculatedTotalReviews).toBe(1);
      expect(db.store.reviews.rev_spam).toBeUndefined();
      expect(db.store.users.trader_reviewed.rating).toBe(5);
    });
  });
});
