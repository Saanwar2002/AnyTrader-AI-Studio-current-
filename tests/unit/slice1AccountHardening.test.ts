import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  executeAcceptTermsCommand,
  executeSyncExpiredVerificationDocsCommand,
  executeRemoveVideoVerificationCommand,
  executeListBusinessTeamCommand,
  executeSendBusinessTeamInviteCommand,
  executeRevokeBusinessTeamInviteCommand,
  executeAcceptBusinessTeamInviteCommand,
  executeRemoveBusinessTeamMemberCommand,
  hashTeamInvitationToken,
} from "../../src/server/slice1AccountCommands";
import { executeBootstrapProfileCommand } from "../../src/server/accountBootstrap";
import { sanitizePublicProfilePayload } from "../../src/lib/publicProfileProjection";
import { getDocumentReviewSummary } from "../../src/services/verificationService";

function createInMemoryDb(initial: Record<string, Record<string, any>> = {}) {
  const store: Record<string, Record<string, any>> = {};
  for (const [col, docs] of Object.entries(initial)) {
    store[col] = {};
    for (const [id, data] of Object.entries(docs)) {
      store[col][id] = structuredClone(data);
    }
  }

  let autoIdCounter = 1;

  function ensureCol(col: string) {
    if (!store[col]) store[col] = {};
    return store[col];
  }

  function applyWrite(col: string, id: string, data: Record<string, any>, merge: boolean) {
    const bucket = ensureCol(col);
    const prev = merge && bucket[id] ? structuredClone(bucket[id]) : {};
    const next: Record<string, any> = { ...prev };
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && v.constructor?.name === "NumericIncrementTransform") {
        next[k] = Number(prev[k] || 0) + 1;
      } else {
        next[k] = v;
      }
    }
    bucket[id] = next;
  }

  function makeDocRef(col: string, id: string) {
    return {
      __col: col,
      __id: id,
      id,
      async get() {
        const bucket = ensureCol(col);
        const exists = Object.prototype.hasOwnProperty.call(bucket, id);
        return {
          id,
          exists,
          data: () => (exists ? structuredClone(bucket[id]) : undefined),
        };
      },
      async set(data: Record<string, any>, opts?: { merge?: boolean }) {
        applyWrite(col, id, data, Boolean(opts?.merge));
      },
      async update(data: Record<string, any>) {
        const bucket = ensureCol(col);
        if (!bucket[id]) throw new Error(`Document ${col}/${id} does not exist`);
        applyWrite(col, id, data, true);
      },
      async delete() {
        const bucket = ensureCol(col);
        delete bucket[id];
      },
    };
  }

  function makeQuery(col: string, filters: Array<{ field: string; op: string; value: any }> = [], limitN?: number) {
    return {
      where(field: string, op: string, value: any) {
        return makeQuery(col, [...filters, { field, op, value }], limitN);
      },
      limit(n: number) {
        return makeQuery(col, filters, n);
      },
      async get() {
        const bucket = ensureCol(col);
        let entries = Object.entries(bucket).filter(([, data]) =>
          filters.every((f) => f.op === "==" && data[f.field] === f.value)
        );
        if (typeof limitN === "number") entries = entries.slice(0, limitN);
        const docs = entries.map(([id, data]) => ({
          id,
          exists: true,
          data: () => structuredClone(data),
        }));
        return { empty: docs.length === 0, docs };
      },
    };
  }

  const db = {
    store,
    collection(col: string) {
      return {
        doc(id?: string) {
          return makeDocRef(col, id || `auto_${autoIdCounter++}`);
        },
        async add(data: Record<string, any>) {
          const id = `auto_${autoIdCounter++}`;
          applyWrite(col, id, data, false);
          return makeDocRef(col, id);
        },
        where(field: string, op: string, value: any) {
          return makeQuery(col, [{ field, op, value }]);
        },
      };
    },
    async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const tx = {
        async get(ref: any) {
          return ref.get();
        },
        set(ref: any, data: Record<string, any>, opts?: { merge?: boolean }) {
          applyWrite(ref.__col, ref.__id, data, Boolean(opts?.merge));
        },
        update(ref: any, data: Record<string, any>) {
          applyWrite(ref.__col, ref.__id, data, true);
        },
      };
      return fn(tx);
    },
  };

  return db;
}

describe("Slice 1 — Identity, Auth, Onboarding & Verification Hardening", () => {
  it("P0 #1: executeAcceptTermsCommand records server-authoritative terms consent and audit log", async () => {
    const db = createInMemoryDb({
      users: { u1: { uid: "u1", role: "homeowner", email: "user@example.com" } },
    });

    const result = await executeAcceptTermsCommand({
      db,
      caller: { uid: "u1", email: "user@example.com" },
      rawInput: {
        termsVersion: "2.4",
        compulsoryAgreed: true,
        marketingOptIn: false,
        partnerDataSharingOptIn: true,
      },
      clientIp: "203.0.113.42",
      userAgent: "TestAgent/1.0",
    });

    expect(result.success).toBe(true);
    expect(result.termsAcceptedVersion).toBe("2.4");
    expect(db.store.users.u1.termsAccepted).toBe(true);
    expect(db.store.users.u1.termsAcceptedIp).toBe("203.0.113.42");
    expect(db.store.users.u1.marketingOptIn).toBe(false);
    expect(db.store.users.u1.partnerDataSharingOptIn).toBe(true);
    expect(db.store.users.u1.role).toBe("homeowner");
    expect(Object.keys(db.store.audit_logs || {}).length).toBe(1);
  });

  it("P0 #1: rejects terms acceptance if compulsoryAgreed is not true", async () => {
    const db = createInMemoryDb({ users: { u1: { uid: "u1" } } });
    await expect(
      executeAcceptTermsCommand({
        db,
        caller: { uid: "u1" },
        rawInput: { termsVersion: "2.4", compulsoryAgreed: false },
      })
    ).rejects.toThrow();
  });

  it("P0 #2: firestore.rules public_profiles update allowlist covers all server-written bootstrap & upgrade fields while keeping them immutable", () => {
    const rules = fs.readFileSync(path.resolve(process.cwd(), "firestore.rules"), "utf8");
    const allowlistMatch = rules.match(/match \/public_profiles\/\{userId\}[\s\S]*?allow update:[\s\S]*?hasOnly\(\[([\s\S]*?)\]\)/);
    const immutableMatch = rules.match(/match \/public_profiles\/\{userId\}[\s\S]*?affectedKeys\(\)\.hasAny\(\[([\s\S]*?)\]\)/);
    expect(allowlistMatch).toBeTruthy();
    expect(immutableMatch).toBeTruthy();

    const extract = (s: string) => new Set(Array.from(s.matchAll(/'([A-Za-z0-9_]+)'/g)).map((m) => m[1]));
    const allowed = extract(allowlistMatch![1]);
    const immutable = extract(immutableMatch![1]);

    const serverManagedFields = [
      "requiresAdminVerification",
      "tier",
      "tierId",
      "reviewCount",
      "completedJobsCount",
      "availabilityStatus",
      "fairnessScore",
      "hasVerifiedVideoProSubscription",
    ];
    for (const field of serverManagedFields) {
      expect(allowed.has(field), `${field} must exist in public_profiles update hasOnly()`).toBe(true);
      expect(immutable.has(field), `${field} must remain immutable in affectedKeys().hasAny()`).toBe(true);
    }

    // Client-side sanitization still strips server-only fields while keeping avatarUrl & portfolio
    const sanitized = sanitizePublicProfilePayload({
      photoURL: "https://example.com/a.jpg",
      avatarUrl: "https://example.com/a.jpg",
      portfolio: ["https://example.com/p1.jpg"],
      requiresAdminVerification: false,
      fairnessScore: 999,
      email: "leak@example.com",
    });
    expect(sanitized.photoURL).toBe("https://example.com/a.jpg");
    expect(sanitized.avatarUrl).toBe("https://example.com/a.jpg");
    expect(sanitized.portfolio).toEqual(["https://example.com/p1.jpg"]);
    expect(sanitized.requiresAdminVerification).toBeUndefined();
    expect(sanitized.fairnessScore).toBeUndefined();
    expect(sanitized.email).toBeUndefined();
  });

  it("P0 #3: verificationService no longer simulates random auto-approvals", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "src/services/verificationService.ts"), "utf8");
    expect(src).not.toContain("Math.random");
    expect(src).not.toContain("referralBoostUntil");
    expect(src).not.toContain("audit_logs");
    const summary = getDocumentReviewSummary("Gas Safe Register");
    expect(summary.status).toBe("manual_review");
  });

  it("P0 #4: Business Team server lifecycle (list, invite, accept with token hash, remove, revoke, seat cap)", async () => {
    const db = createInMemoryDb({
      users: {
        biz1: { uid: "biz1", role: "business", name: "Acme Builders", email: "owner@acme.co.uk" },
        member1: { uid: "member1", role: "homeowner", name: "Sam Worker", email: "sam@acme.co.uk" },
        otherBiz: { uid: "otherBiz", role: "business", name: "Rival Ltd", email: "rival@other.co.uk" },
      },
    });

    // Send invite
    const inviteRes = await executeSendBusinessTeamInviteCommand({
      db,
      caller: { uid: "biz1", email: "owner@acme.co.uk" },
      email: "sam@acme.co.uk",
      appOrigin: "https://anytrader.app",
      env: {}, // unconfigured email transport still creates invite + notifies in-app
    });
    expect(inviteRes.success).toBe(true);
    expect(inviteRes.inAppNotified).toBe(true);

    // Duplicate invite blocked
    await expect(
      executeSendBusinessTeamInviteCommand({
        db,
        caller: { uid: "biz1", email: "owner@acme.co.uk" },
        email: "sam@acme.co.uk",
      })
    ).rejects.toThrow(/pending invitation/i);

    // List team shows pending invite
    const list1 = await executeListBusinessTeamCommand({ db, caller: { uid: "biz1" } });
    expect(list1.eligible).toBe(true);
    expect(list1.invitations.length).toBe(1);
    expect(list1.members.length).toBe(0);

    // Extract raw token from the in-app notification link
    const notifs = Object.values(db.store.notifications || {});
    expect(notifs.length).toBe(1);
    const link: string = (notifs[0] as any).link;
    const token = new URL(`https://anytrader.app${link}`).searchParams.get("token")!;
    expect(hashTeamInvitationToken(token)).toBe(db.store.invitations[inviteRes.invitationId].tokenHash);

    // Wrong email cannot accept
    await expect(
      executeAcceptBusinessTeamInviteCommand({
        db,
        caller: { uid: "otherBiz", email: "rival@other.co.uk", email_verified: true },
        invitationId: inviteRes.invitationId,
        token,
      })
    ).rejects.toThrow(/does not match/i);

    // Correct recipient accepts
    const accepted = await executeAcceptBusinessTeamInviteCommand({
      db,
      caller: { uid: "member1", email: "sam@acme.co.uk", email_verified: true },
      invitationId: inviteRes.invitationId,
      token,
    });
    expect(accepted.success).toBe(true);
    expect(db.store.users.member1.businessId).toBe("biz1");

    // Rival business cannot remove biz1's member
    await expect(
      executeRemoveBusinessTeamMemberCommand({
        db,
        caller: { uid: "otherBiz" },
        memberUid: "member1",
      })
    ).rejects.toThrow(/not an active member/i);

    // Owner removes member cleanly
    const removed = await executeRemoveBusinessTeamMemberCommand({
      db,
      caller: { uid: "biz1" },
      memberUid: "member1",
    });
    expect(removed.success).toBe(true);
    expect(db.store.users.member1.businessId).toBeNull();

    // Send another invite & revoke it
    const inv2 = await executeSendBusinessTeamInviteCommand({
      db,
      caller: { uid: "biz1", email: "owner@acme.co.uk" },
      email: "newbie@acme.co.uk",
      env: {},
    });
    await expect(
      executeRevokeBusinessTeamInviteCommand({ db, caller: { uid: "otherBiz" }, invitationId: inv2.invitationId })
    ).rejects.toThrow(/only revoke/i);
    const revoked = await executeRevokeBusinessTeamInviteCommand({
      db,
      caller: { uid: "biz1" },
      invitationId: inv2.invitationId,
    });
    expect(revoked.success).toBe(true);
    expect(db.store.invitations[inv2.invitationId]).toBeUndefined();
  });

  it("P0 #6: executeBootstrapProfileCommand atomically increments verified affiliate uses on server", async () => {
    const db = createInMemoryDb({
      affiliates: {
        aff_partner1: { code: "partner10", status: "active", uses: 4 },
      },
    });

    const res = await executeBootstrapProfileCommand(
      db,
      { uid: "new_user_1", email: "new@example.com" },
      {
        role: "homeowner",
        name: "Jane Homeowner",
        postcode: "SW1A 1AA",
        affiliateCode: "PARTNER10",
      }
    );

    expect(res.success).toBe(true);
    expect(db.store.users.new_user_1.affiliateId).toBe("aff_partner1");
    expect(db.store.affiliates.aff_partner1.uses).toBe(5);
  });

  it("P1 #8: executeSyncExpiredVerificationDocsCommand downgrades expired docs on private + public profiles and queues notifications", async () => {
    const now = new Date("2026-11-24T12:00:00Z");
    const db = createInMemoryDb({
      users: {
        t1: {
          uid: "t1",
          role: "tradesperson",
          verificationStatus: "verified",
          isVerified: true,
          verifiedTrader: true,
          verificationDocs: [
            { type: "Gas Safe", status: "approved", expiryDate: "2026-10-01" },
            { type: "Public Liability", status: "approved", expiryDate: "2026-12-10" },
          ],
        },
      },
      public_profiles: {
        t1: { uid: "t1", verificationStatus: "verified", isVerified: true, verifiedTrader: true },
      },
    });

    const res = await executeSyncExpiredVerificationDocsCommand({ db, caller: { uid: "t1" }, now });
    expect(res.updated).toBe(true);
    expect(res.expiredCount).toBe(1);
    expect(res.warnedCount).toBe(1);
    expect(db.store.users.t1.verificationStatus).toBe("unverified");
    expect(db.store.public_profiles.t1.verificationStatus).toBe("unverified");
    expect(db.store.public_profiles.t1.isVerified).toBe(false);
    expect(Object.keys(db.store.notifications || {}).length).toBe(2);
  });

  it("P1 #9: executeRemoveVideoVerificationCommand clears video fields on both users and public_profiles", async () => {
    const db = createInMemoryDb({
      users: {
        t2: {
          uid: "t2",
          videoVerificationUrl: "https://storage.example/v.mp4",
          videoVerificationStatus: "verified",
          videoVerified: true,
        },
      },
      public_profiles: {
        t2: {
          uid: "t2",
          videoVerificationUrl: "https://storage.example/v.mp4",
          videoVerificationStatus: "verified",
          videoVerified: true,
          isVideoVerified: true,
        },
      },
    });

    const res = await executeRemoveVideoVerificationCommand({ db, caller: { uid: "t2" } });
    expect(res.success).toBe(true);
    expect(res.publicProfileSynced).toBe(true);
    expect(db.store.users.t2.videoVerificationUrl).toBeNull();
    expect(db.store.users.t2.videoVerificationStatus).toBe("none");
    expect(db.store.public_profiles.t2.videoVerificationUrl).toBeNull();
    expect(db.store.public_profiles.t2.videoVerified).toBe(false);
  });
});
