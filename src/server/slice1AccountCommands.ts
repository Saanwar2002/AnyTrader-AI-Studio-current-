/**
 * Slice 1 — Server-Authoritative Account, Terms, Verification & Business Team Commands
 *
 * Replaces blocked or insecure client-side Firestore mutations with authenticated,
 * schema-validated, server-authoritative commands:
 * 1. Platform Terms & Privacy acceptance (`executeAcceptTermsCommand`)
 * 2. Verification document expiry & warning sync (`executeSyncExpiredVerificationDocsCommand`)
 * 3. Video verification removal across private + public profiles (`executeRemoveVideoVerificationCommand`)
 * 4. Business Team listing, inviting, revoking, accepting, and member removal
 */

import * as crypto from "crypto";
import { z } from "zod";
import admin from "firebase-admin";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "./httpErrors.ts";
import { dispatchTransactionalEmail } from "./emailTransport.ts";
import { CURRENT_TERMS_VERSION } from "../constants/termsAndPrivacy.ts";

const BASIC_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hashTeamInvitationToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

function getServerTimestamp(nowIso: string): any {
  return typeof admin?.firestore?.FieldValue?.serverTimestamp === "function"
    ? admin.firestore.FieldValue.serverTimestamp()
    : nowIso;
}

// ---------------------------------------------------------------------------
// 1. Platform Terms Acceptance (Fixes P0 #1: Blocking Terms Modal Lockout)
// ---------------------------------------------------------------------------

export const acceptTermsSchema = z.object({
  termsVersion: z.string().trim().min(1).max(40).default(CURRENT_TERMS_VERSION),
  compulsoryAgreed: z.literal(true, {
    errorMap: () => ({
      message: "You must accept the compulsory Terms & Conditions and Privacy Policy to continue.",
    }),
  }),
  marketingOptIn: z.boolean().optional().default(false),
  partnerDataSharingOptIn: z.boolean().optional().default(false),
}).strict();

export interface AcceptTermsResult {
  success: boolean;
  uid: string;
  termsAcceptedVersion: string;
  termsAcceptedAt: string;
  marketingOptIn: boolean;
  partnerDataSharingOptIn: boolean;
}

export async function executeAcceptTermsCommand(params: {
  db: any;
  caller: { uid: string; email?: string | null };
  rawInput: unknown;
  clientIp?: string;
  userAgent?: string;
}): Promise<AcceptTermsResult> {
  const { db, caller, rawInput, clientIp, userAgent } = params;
  if (!db) throw new BadRequestError("Database service unavailable.");
  if (!caller?.uid) throw new ForbiddenError("Authenticated user required.");

  const parsed = acceptTermsSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues?.[0]?.message || "Invalid terms acceptance payload.");
  }

  const { termsVersion, marketingOptIn, partnerDataSharingOptIn } = parsed.data;
  const nowIso = new Date().toISOString();
  const userRef = db.collection("users").doc(caller.uid);

  await userRef.set(
    {
      termsAccepted: true,
      termsAcceptedAt: nowIso,
      termsAcceptedVersion: termsVersion,
      termsAcceptedIp: String(clientIp || "unknown").slice(0, 120),
      termsAcceptedUserAgent: String(userAgent || "Web").slice(0, 300),
      marketingOptIn,
      partnerDataSharingOptIn,
      updatedAt: getServerTimestamp(nowIso),
    },
    { merge: true }
  );

  // Best-effort server audit record
  try {
    await db.collection("audit_logs").add({
      action: "TERMS_ACCEPTED",
      userId: caller.uid,
      termsVersion,
      marketingOptIn,
      partnerDataSharingOptIn,
      timestamp: nowIso,
    });
  } catch {
    // Non-blocking audit log
  }

  return {
    success: true,
    uid: caller.uid,
    termsAcceptedVersion: termsVersion,
    termsAcceptedAt: nowIso,
    marketingOptIn,
    partnerDataSharingOptIn,
  };
}

// ---------------------------------------------------------------------------
// 2. Verification Document Expiry & 30-Day Warning Sync (Fixes P1 #8)
// ---------------------------------------------------------------------------

export interface SyncExpiredDocsResult {
  success: boolean;
  updated: boolean;
  expiredCount: number;
  warnedCount: number;
  verificationStatus: string;
}

export async function executeSyncExpiredVerificationDocsCommand(params: {
  db: any;
  caller: { uid: string };
  now?: Date;
}): Promise<SyncExpiredDocsResult> {
  const { db, caller } = params;
  if (!db) throw new BadRequestError("Database service unavailable.");
  if (!caller?.uid) throw new ForbiddenError("Authenticated user required.");

  const now = params.now || new Date();
  const nowIso = now.toISOString();
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const userRef = db.collection("users").doc(caller.uid);
  const userSnap = await userRef.get();
  if (!userSnap || !userSnap.exists) {
    throw new NotFoundError("User profile not found.");
  }

  const data = (typeof userSnap.data === "function" ? userSnap.data() : userSnap.data) || {};
  const docs = Array.isArray(data.verificationDocs) ? data.verificationDocs : [];
  if (docs.length === 0) {
    return {
      success: true,
      updated: false,
      expiredCount: 0,
      warnedCount: 0,
      verificationStatus: String(data.verificationStatus || "unverified"),
    };
  }

  let needsUpdate = false;
  let expiredCount = 0;
  let warnedCount = 0;
  let newVerificationStatus = String(data.verificationStatus || "unverified");
  const notificationsToCreate: Array<{ title: string; message: string }> = [];

  const updatedDocs = docs.map((docItem: any) => {
    if (!docItem || !docItem.expiryDate) return docItem;
    const expiry = new Date(docItem.expiryDate);
    if (Number.isNaN(expiry.getTime())) return docItem;

    if (expiry < now && docItem.status !== "expired") {
      needsUpdate = true;
      expiredCount += 1;
      newVerificationStatus = "unverified";
      notificationsToCreate.push({
        title: "Verification Expired",
        message: `Your ${docItem.type || "verification document"} has expired. Please upload a new document to restore your verified status.`,
      });
      return { ...docItem, status: "expired", expiredAt: nowIso };
    }

    if (expiry >= now && expiry < thirtyDaysFromNow && !docItem.expiryWarningSent) {
      needsUpdate = true;
      warnedCount += 1;
      notificationsToCreate.push({
        title: "Verification Expiring Soon",
        message: `Your ${docItem.type || "verification document"} will expire on ${expiry.toLocaleDateString("en-GB")}. Please prepare your renewal documents.`,
      });
      return { ...docItem, expiryWarningSent: true, expiryWarningSentAt: nowIso };
    }

    return docItem;
  });

  if (!needsUpdate) {
    return {
      success: true,
      updated: false,
      expiredCount: 0,
      warnedCount: 0,
      verificationStatus: newVerificationStatus,
    };
  }

  const userUpdate: Record<string, any> = {
    verificationDocs: updatedDocs,
    updatedAt: getServerTimestamp(nowIso),
  };
  if (expiredCount > 0) {
    userUpdate.verificationStatus = "unverified";
    userUpdate.isVerified = false;
    userUpdate.verifiedTrader = false;
  }

  await userRef.set(userUpdate, { merge: true });

  if (expiredCount > 0) {
    try {
      const pubRef = db.collection("public_profiles").doc(caller.uid);
      const pubSnap = await pubRef.get();
      if (pubSnap && pubSnap.exists) {
        await pubRef.set(
          {
            verificationStatus: "unverified",
            isVerified: false,
            verifiedTrader: false,
            updatedAt: getServerTimestamp(nowIso),
          },
          { merge: true }
        );
      }
    } catch {
      // Non-fatal public profile sync
    }
  }

  for (const notif of notificationsToCreate) {
    try {
      await db.collection("notifications").add({
        userId: caller.uid,
        title: notif.title,
        message: notif.message,
        type: "status",
        link: "/profile#verification",
        read: false,
        createdAt: getServerTimestamp(nowIso),
      });
    } catch {
      // Non-blocking notification
    }
  }

  return {
    success: true,
    updated: true,
    expiredCount,
    warnedCount,
    verificationStatus: newVerificationStatus,
  };
}

// ---------------------------------------------------------------------------
// 3. Video Verification Removal (Fixes P1 #9)
// ---------------------------------------------------------------------------

export async function executeRemoveVideoVerificationCommand(params: {
  db: any;
  caller: { uid: string };
}): Promise<{ success: boolean; uid: string; publicProfileSynced: boolean }> {
  const { db, caller } = params;
  if (!db) throw new BadRequestError("Database service unavailable.");
  if (!caller?.uid) throw new ForbiddenError("Authenticated user required.");

  const nowIso = new Date().toISOString();
  const userRef = db.collection("users").doc(caller.uid);
  const pubRef = db.collection("public_profiles").doc(caller.uid);

  await userRef.set(
    {
      videoVerificationUrl: null,
      videoVerificationStatus: "none",
      videoVerified: false,
      isVideoVerified: false,
      updatedAt: getServerTimestamp(nowIso),
    },
    { merge: true }
  );

  let publicProfileSynced = false;
  try {
    const pubSnap = await pubRef.get();
    if (pubSnap && pubSnap.exists) {
      await pubRef.set(
        {
          videoVerificationUrl: null,
          videoVerificationStatus: "none",
          videoVerified: false,
          isVideoVerified: false,
          updatedAt: getServerTimestamp(nowIso),
        },
        { merge: true }
      );
      publicProfileSynced = true;
    }
  } catch {
    // Non-fatal public profile sync
  }

  return {
    success: true,
    uid: caller.uid,
    publicProfileSynced,
  };
}

// ---------------------------------------------------------------------------
// 4. Business Team Management (Fixes P0 #4)
// ---------------------------------------------------------------------------

export function isEligibleBusinessTeamOwner(profile: Record<string, any> | null | undefined): boolean {
  if (!profile) return false;
  const role = String(profile.role || "").trim().toLowerCase();
  const subType = String(profile.subscriptionType || "").trim().toLowerCase();
  return (
    role === "admin" ||
    role === "super_admin" ||
    role === "business" ||
    role === "tradesperson" ||
    subType === "business" ||
    subType === "gold" ||
    subType === "platinum" ||
    subType === "enterprise" ||
    subType.includes("business") ||
    subType.includes("enterprise")
  );
}

export function getBusinessTeamSeatLimit(profile: Record<string, any> | null | undefined): number {
  const subType = String(profile?.subscriptionType || "").toLowerCase();
  const tierId = String(profile?.tierId || "").toLowerCase();
  if (subType.includes("enterprise") || tierId.includes("enterprise")) {
    return 100; // High enterprise seat cap (displayed as Unlimited in UI)
  }
  return 5;
}

export async function executeListBusinessTeamCommand(params: {
  db: any;
  caller: { uid: string };
}): Promise<{
  eligible: boolean;
  seatLimit: number;
  isUnlimitedSeats: boolean;
  members: Array<{
    uid: string;
    name: string;
    email: string;
    role: string;
    avatarUrl?: string;
    isDisabled?: boolean;
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: string;
    status: string;
    deliveryStatus?: string;
    createdAt?: any;
    expiresAt?: string;
    businessId: string;
  }>;
}> {
  const { db, caller } = params;
  if (!db) throw new BadRequestError("Database service unavailable.");
  if (!caller?.uid) throw new ForbiddenError("Authenticated user required.");

  const ownerSnap = await db.collection("users").doc(caller.uid).get();
  const ownerData = ownerSnap?.exists
    ? (typeof ownerSnap.data === "function" ? ownerSnap.data() : ownerSnap.data) || {}
    : {};

  if (!isEligibleBusinessTeamOwner(ownerData)) {
    return {
      eligible: false,
      seatLimit: 0,
      isUnlimitedSeats: false,
      members: [],
      invitations: [],
    };
  }

  const seatLimit = getBusinessTeamSeatLimit(ownerData);
  const isUnlimitedSeats = seatLimit >= 100;

  const [membersSnap, invitesSnap] = await Promise.all([
    db.collection("users").where("businessId", "==", caller.uid).get(),
    db.collection("invitations").where("invitedBy", "==", caller.uid).get(),
  ]);

  const members = (membersSnap?.docs || [])
    .filter((d: any) => d.id !== caller.uid)
    .map((d: any) => {
      const m = (typeof d.data === "function" ? d.data() : d.data) || {};
      return {
        uid: d.id,
        name: String(m.name || m.displayName || "Team Member"),
        email: String(m.email || ""),
        role: String(m.businessTeamRole || "member"),
        avatarUrl: m.avatarUrl || m.photoURL || undefined,
        isDisabled: Boolean(m.isDisabled),
      };
    });

  const invitations = (invitesSnap?.docs || [])
    .map((d: any) => {
      const inv = (typeof d.data === "function" ? d.data() : d.data) || {};
      return {
        id: d.id,
        email: String(inv.email || ""),
        role: String(inv.role || "member"),
        status: String(inv.status || "pending"),
        deliveryStatus: inv.deliveryStatus,
        createdAt: inv.createdAtIso || inv.createdAt || null,
        expiresAt: inv.expiresAt || undefined,
        businessId: String(inv.businessId || caller.uid),
        type: String(inv.type || ""),
      };
    })
    .filter((inv: any) => inv.type === "business_team" && inv.status === "pending")
    .map(({ type: _t, ...rest }: any) => rest);

  return {
    eligible: true,
    seatLimit,
    isUnlimitedSeats,
    members,
    invitations,
  };
}

export async function executeSendBusinessTeamInviteCommand(params: {
  db: any;
  caller: { uid: string; email?: string | null };
  email: string;
  appOrigin?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}): Promise<{
  success: boolean;
  invitationId: string;
  email: string;
  expiresAt: string;
  deliveryStatus: "delivered" | "unconfigured" | "failed";
  inAppNotified: boolean;
}> {
  const { db, caller, appOrigin, env, fetchFn } = params;
  if (!db) throw new BadRequestError("Database service unavailable.");
  if (!caller?.uid) throw new ForbiddenError("Authenticated user required.");

  const normalizedEmail = String(params.email || "").trim().toLowerCase();
  if (!normalizedEmail || !BASIC_EMAIL_REGEX.test(normalizedEmail)) {
    throw new BadRequestError("Please enter a valid teammate email address.");
  }
  if (caller.email && normalizedEmail === caller.email.trim().toLowerCase()) {
    throw new BadRequestError("You cannot invite your own account email.");
  }

  const ownerSnap = await db.collection("users").doc(caller.uid).get();
  if (!ownerSnap || !ownerSnap.exists) {
    throw new NotFoundError("Business owner profile not found.");
  }
  const ownerData = (typeof ownerSnap.data === "function" ? ownerSnap.data() : ownerSnap.data) || {};
  if (!isEligibleBusinessTeamOwner(ownerData)) {
    throw new ForbiddenError("Team management requires an eligible Business or Tradesperson account.");
  }

  const seatLimit = getBusinessTeamSeatLimit(ownerData);
  const [membersSnap, invitesSnap] = await Promise.all([
    db.collection("users").where("businessId", "==", caller.uid).get(),
    db.collection("invitations").where("invitedBy", "==", caller.uid).get(),
  ]);

  const activeMembersCount = (membersSnap?.docs || []).filter((d: any) => d.id !== caller.uid).length;
  const pendingInvites = (invitesSnap?.docs || []).filter((d: any) => {
    const inv = (typeof d.data === "function" ? d.data() : d.data) || {};
    return inv.type === "business_team" && inv.status === "pending";
  });

  const duplicatePending = pendingInvites.some((d: any) => {
    const inv = (typeof d.data === "function" ? d.data() : d.data) || {};
    return String(inv.email || "").toLowerCase() === normalizedEmail;
  });
  if (duplicatePending) {
    throw new ConflictError("A pending invitation has already been sent to this email address.");
  }

  // +1 for the business owner's own seat
  if (activeMembersCount + 1 + pendingInvites.length >= seatLimit) {
    throw new ConflictError(
      `Your current plan allows up to ${seatLimit} team seats (including pending invitations). Upgrade your subscription to add more seats.`
    );
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + 7 * 24 * 3_600_000).toISOString();
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashTeamInvitationToken(rawToken);
  const invitationId = `team_inv_${nowMs}_${crypto.randomBytes(6).toString("hex")}`;
  const businessName = String(ownerData.businessName || ownerData.companyName || ownerData.name || "Your Business Team");

  const invRef = db.collection("invitations").doc(invitationId);
  await invRef.set({
    id: invitationId,
    email: normalizedEmail,
    role: "member",
    permissions: ["post_job", "view_quotes"],
    status: "pending",
    deliveryStatus: "pending",
    tokenHash,
    expiresAt,
    invitedBy: caller.uid,
    invitedByEmail: caller.email || ownerData.email || null,
    businessId: caller.uid,
    businessName,
    type: "business_team",
    createdAt: getServerTimestamp(nowIso),
    createdAtIso: nowIso,
    updatedAt: nowIso,
  });

  const baseOrigin =
    (appOrigin || process.env.APP_URL || process.env.PUBLIC_APP_URL || "").replace(/\/+$/, "") ||
    "https://anytrader.app";
  const inviteLink = `${baseOrigin}/team-invite?id=${encodeURIComponent(invitationId)}&token=${encodeURIComponent(rawToken)}`;

  const emailResult = await dispatchTransactionalEmail({
    db,
    to: normalizedEmail,
    subject: `You've been invited to join ${businessName} on AnyTrader`,
    text: `${businessName} has invited you to join their AnyTrader business team. Accept your invitation before ${expiresAt}: ${inviteLink}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #000000; border-radius: 12px; overflow: hidden;">
        <div style="background: #0f172a; color: #ffffff; padding: 20px 24px;">
          <h2 style="margin: 0; font-size: 18px;">AnyTrader Team Invitation</h2>
        </div>
        <div style="padding: 24px; color: #000000;">
          <p><strong>${businessName}</strong> has invited you to join their AnyTrader Business Team.</p>
          <p style="font-size: 13px;">This invitation expires on <strong>${expiresAt}</strong>.</p>
          <p style="margin: 24px 0;">
            <a href="${inviteLink}" style="background: #4f46e5; color: #ffffff; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: 700;">Accept Team Invitation</a>
          </p>
        </div>
      </div>
    `,
    metadata: {
      type: "business_team_invitation",
      invitationId,
      businessId: caller.uid,
    },
    env,
    fetchFn,
  });

  await invRef.set(
    {
      deliveryStatus: emailResult.status,
      emailQueueId: emailResult.queueId || null,
      deliveryError: emailResult.delivered ? null : emailResult.error || null,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );

  // Also send an in-app notification if this email already belongs to a registered user
  let inAppNotified = false;
  try {
    const existingUserSnap = await db.collection("users").where("email", "==", normalizedEmail).limit(1).get();
    if (existingUserSnap && !existingUserSnap.empty) {
      const targetUid = existingUserSnap.docs[0].id;
      if (targetUid !== caller.uid) {
        await db.collection("notifications").add({
          userId: targetUid,
          title: `Team Invite from ${businessName}`,
          message: `You have been invited to join ${businessName}'s AnyTrader business team.`,
          type: "status",
          link: `/team-invite?id=${encodeURIComponent(invitationId)}&token=${encodeURIComponent(rawToken)}`,
          read: false,
          createdAt: getServerTimestamp(nowIso),
        });
        inAppNotified = true;
      }
    }
  } catch {
    // Non-blocking in-app notification
  }

  return {
    success: true,
    invitationId,
    email: normalizedEmail,
    expiresAt,
    deliveryStatus: emailResult.status,
    inAppNotified,
  };
}

export async function executeRevokeBusinessTeamInviteCommand(params: {
  db: any;
  caller: { uid: string };
  invitationId: string;
}): Promise<{ success: boolean; invitationId: string }> {
  const { db, caller, invitationId } = params;
  if (!db) throw new BadRequestError("Database service unavailable.");
  if (!caller?.uid) throw new ForbiddenError("Authenticated user required.");
  if (!invitationId) throw new BadRequestError("Invitation ID is required.");

  const invRef = db.collection("invitations").doc(invitationId);
  const snap = await invRef.get();
  if (!snap || !snap.exists) {
    throw new NotFoundError("Invitation not found.");
  }
  const inv = (typeof snap.data === "function" ? snap.data() : snap.data) || {};
  if (inv.invitedBy !== caller.uid && inv.businessId !== caller.uid) {
    throw new ForbiddenError("You can only revoke invitations created by your business.");
  }
  if (inv.type !== "business_team") {
    throw new ForbiddenError("This invitation cannot be revoked from Business Team Management.");
  }

  await invRef.delete();
  return { success: true, invitationId };
}

export async function executeAcceptBusinessTeamInviteCommand(params: {
  db: any;
  caller: { uid: string; email?: string | null; email_verified?: boolean };
  invitationId: string;
  token: string;
}): Promise<{ success: boolean; invitationId: string; businessId: string; businessName: string }> {
  const { db, caller, invitationId, token } = params;
  if (!db) throw new BadRequestError("Database service unavailable.");
  if (!caller?.uid || !caller?.email) {
    throw new ForbiddenError("Please sign in with the invited email address to accept this invitation.");
  }
  if (!invitationId || !token) {
    throw new BadRequestError("Invitation ID and verification token are required.");
  }

  const presentedHash = hashTeamInvitationToken(token.trim());
  const invRef = db.collection("invitations").doc(invitationId);

  return db.runTransaction(async (tx: any) => {
    const snap = await tx.get(invRef);
    if (!snap || !snap.exists) {
      throw new NotFoundError("Team invitation not found.");
    }
    const inv = (typeof snap.data === "function" ? snap.data() : snap.data) || {};
    if (inv.type !== "business_team") {
      throw new BadRequestError("This invitation link is not a business team invitation.");
    }
    if (inv.status !== "pending") {
      throw new ConflictError(`This invitation has already been ${inv.status}.`);
    }
    if (String(inv.email || "").toLowerCase() !== caller.email!.trim().toLowerCase()) {
      throw new ForbiddenError("Your signed-in email does not match the invitation recipient.");
    }
    if (inv.expiresAt && Date.parse(inv.expiresAt) <= Date.now()) {
      throw new BadRequestError("This team invitation has expired. Ask the business owner for a new invite.");
    }
    if (!inv.tokenHash || inv.tokenHash !== presentedHash) {
      throw new ForbiddenError("Invalid team invitation token.");
    }
    if (!inv.businessId || inv.businessId === caller.uid) {
      throw new BadRequestError("Invalid business team owner binding.");
    }

    const nowIso = new Date().toISOString();
    const userRef = db.collection("users").doc(caller.uid);

    tx.set(
      invRef,
      {
        status: "accepted",
        acceptedBy: caller.uid,
        acceptedAt: nowIso,
        updatedAt: nowIso,
      },
      { merge: true }
    );
    tx.set(
      userRef,
      {
        businessId: inv.businessId,
        businessTeamRole: inv.role || "member",
        businessTeamPermissions: Array.isArray(inv.permissions) ? inv.permissions : ["post_job", "view_quotes"],
        joinedBusinessTeamAt: nowIso,
        updatedAt: getServerTimestamp(nowIso),
      },
      { merge: true }
    );

    return {
      success: true,
      invitationId,
      businessId: String(inv.businessId),
      businessName: String(inv.businessName || "Business Team"),
    };
  });
}

export async function executeRemoveBusinessTeamMemberCommand(params: {
  db: any;
  caller: { uid: string };
  memberUid: string;
}): Promise<{ success: boolean; memberUid: string }> {
  const { db, caller, memberUid } = params;
  if (!db) throw new BadRequestError("Database service unavailable.");
  if (!caller?.uid) throw new ForbiddenError("Authenticated user required.");
  if (!memberUid || memberUid === caller.uid) {
    throw new BadRequestError("Valid team member UID is required.");
  }

  const memberRef = db.collection("users").doc(memberUid);
  const memberSnap = await memberRef.get();
  if (!memberSnap || !memberSnap.exists) {
    throw new NotFoundError("Team member account not found.");
  }
  const memberData = (typeof memberSnap.data === "function" ? memberSnap.data() : memberSnap.data) || {};
  if (memberData.businessId !== caller.uid) {
    throw new ForbiddenError("This user is not an active member of your business team.");
  }

  const nowIso = new Date().toISOString();
  await memberRef.set(
    {
      businessId: null,
      businessTeamRole: null,
      businessTeamPermissions: [],
      removedFromBusinessAt: nowIso,
      updatedAt: getServerTimestamp(nowIso),
    },
    { merge: true }
  );

  return { success: true, memberUid };
}
