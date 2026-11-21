import * as crypto from 'crypto';
import * as admin from 'firebase-admin';
import { dispatchTransactionalEmail, DispatchEmailResult } from './emailTransport';

export class StaffInvitationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'StaffInvitationError';
  }
}

export interface CreateStaffInvitationInput {
  db: admin.firestore.Firestore | any;
  email: string;
  permissions: string[];
  invitedByUid: string;
  invitedByEmail?: string;
  appOrigin?: string;
  ttlHours?: number;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

export interface CreateStaffInvitationResult {
  success: boolean;
  invitationId: string;
  email: string;
  expiresAt: string;
  status: 'pending' | 'delivery_failed';
  deliveryStatus: 'delivered' | 'unconfigured' | 'failed';
  queueId?: string;
  error?: string;
}

const BASIC_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hashInvitationToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Persists a durable, expiring, SHA-256 token-hashed staff invitation in `invitations/{id}`
 * and dispatches the actual invitation email link via the configured server email provider.
 * If the email transport is unconfigured or fails delivery, transitions the invitation to
 * `delivery_failed` and returns `{ success: false }` so no silent false success can occur.
 */
export async function createAndDispatchStaffInvitation(
  input: CreateStaffInvitationInput
): Promise<CreateStaffInvitationResult> {
  if (!input.db) {
    throw new StaffInvitationError('Database service unavailable', 503);
  }
  const normalizedEmail = (input.email || '').trim().toLowerCase();
  if (!normalizedEmail || !BASIC_EMAIL_REGEX.test(normalizedEmail)) {
    throw new StaffInvitationError('Valid recipient email address is required', 400);
  }
  if (!Array.isArray(input.permissions) || input.permissions.length === 0) {
    throw new StaffInvitationError('At least one staff permission must be specified', 400);
  }
  if (!input.invitedByUid) {
    throw new StaffInvitationError('Authenticated inviter UID is required', 401);
  }

  const sanitizedPermissions = Array.from(
    new Set(
      input.permissions
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p) => p.trim())
    )
  );
  if (sanitizedPermissions.length === 0) {
    throw new StaffInvitationError('At least one valid permission string is required', 400);
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const ttlHours = Math.max(1, Math.min(168, Number(input.ttlHours) || 72));
  const expiresAt = new Date(nowMs + ttlHours * 3_600_000).toISOString();

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashInvitationToken(rawToken);
  const invitationId = `inv_${nowMs}_${crypto.randomBytes(6).toString('hex')}`;

  const serverTs =
    typeof admin?.firestore?.FieldValue?.serverTimestamp === 'function'
      ? admin.firestore.FieldValue.serverTimestamp()
      : nowIso;

  const invRef = input.db.collection('invitations').doc(invitationId);
  await invRef.set({
    id: invitationId,
    email: normalizedEmail,
    role: 'admin',
    permissions: sanitizedPermissions,
    status: 'pending',
    deliveryStatus: 'pending',
    tokenHash,
    expiresAt,
    invitedBy: input.invitedByUid,
    invitedByEmail: input.invitedByEmail || null,
    createdAt: serverTs,
    createdAtIso: nowIso,
    updatedAt: nowIso,
  });

  const baseOrigin =
    (input.appOrigin || process.env.APP_URL || process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '') ||
    'https://anytrader.app';
  const inviteLink = `${baseOrigin}/admin-invite?id=${encodeURIComponent(invitationId)}&token=${encodeURIComponent(rawToken)}`;

  const emailResult: DispatchEmailResult = await dispatchTransactionalEmail({
    db: input.db,
    to: normalizedEmail,
    subject: 'AnyTrader Admin Team Invitation',
    text: `You have been invited to join AnyTrader Admin Staff. Accept your invitation before ${expiresAt}: ${inviteLink}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #000000; border-radius: 12px; overflow: hidden;">
        <div style="background: #0f172a; color: #ffffff; padding: 20px 24px;">
          <h2 style="margin: 0; font-size: 18px;">AnyTrader Staff Invitation</h2>
        </div>
        <div style="padding: 24px; color: #000000;">
          <p>You have been invited to join the AnyTrader administration team with <strong>${sanitizedPermissions.length}</strong> permission(s).</p>
          <p style="font-size: 13px;">This invitation expires on <strong>${expiresAt}</strong>.</p>
          <p style="margin: 24px 0;">
            <a href="${inviteLink}" style="background: #0f172a; color: #ffffff; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: 700;">Accept Staff Invitation</a>
          </p>
        </div>
      </div>
    `,
    metadata: {
      type: 'staff_invitation',
      invitationId,
      invitedBy: input.invitedByUid,
    },
    env: input.env,
    fetchFn: input.fetchFn,
  });

  if (!emailResult.delivered) {
    await invRef.set(
      {
        status: 'delivery_failed',
        deliveryStatus: emailResult.status,
        deliveryError: emailResult.error || 'Email delivery failed',
        emailQueueId: emailResult.queueId || null,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
    return {
      success: false,
      invitationId,
      email: normalizedEmail,
      expiresAt,
      status: 'delivery_failed',
      deliveryStatus: emailResult.status,
      queueId: emailResult.queueId,
      error:
        emailResult.error ||
        'Invitation email could not be delivered. Verify SENDGRID_API_KEY or RESEND_API_KEY configuration.',
    };
  }

  await invRef.set(
    {
      status: 'pending',
      deliveryStatus: 'delivered',
      emailQueueId: emailResult.queueId || null,
      providerMessageId: emailResult.providerMessageId || null,
      sentAt: emailResult.timestamp,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );

  return {
    success: true,
    invitationId,
    email: normalizedEmail,
    expiresAt,
    status: 'pending',
    deliveryStatus: 'delivered',
    queueId: emailResult.queueId,
  };
}

/**
 * Verifies an invitation token hash, expiry, status, and recipient verified email before accepting.
 */
export async function acceptStaffInvitationToken(params: {
  db: admin.firestore.Firestore | any;
  invitationId: string;
  token: string;
  callerUid: string;
  callerEmail?: string;
  emailVerified?: boolean;
}): Promise<{ invitationId: string; status: 'accepted'; permissions: string[] }> {
  const { db, invitationId, token, callerUid, callerEmail, emailVerified } = params;
  if (!db) throw new StaffInvitationError('Database unavailable', 503);
  if (!invitationId || !token) {
    throw new StaffInvitationError('invitationId and token are required', 400);
  }
  if (!callerUid || !callerEmail || emailVerified !== true) {
    throw new StaffInvitationError('Verified recipient account email is required to accept invitation', 403);
  }

  const presentedHash = hashInvitationToken(token.trim());
  const invRef = db.collection('invitations').doc(invitationId);

  return db.runTransaction(async (tx: any) => {
    const snap = await tx.get(invRef);
    if (!snap || !snap.exists) {
      throw new StaffInvitationError('Invitation not found', 404);
    }
    const inv = snap.data() || {};
    if (inv.status !== 'pending') {
      throw new StaffInvitationError(`Invitation cannot be accepted in status '${inv.status}'`, 409);
    }
    if ((inv.email || '').toLowerCase() !== callerEmail.toLowerCase()) {
      throw new StaffInvitationError('Authenticated email does not match invitation recipient', 403);
    }
    if (!inv.expiresAt || Date.parse(inv.expiresAt) <= Date.now()) {
      throw new StaffInvitationError('Invitation has expired', 410);
    }
    if (!inv.tokenHash || inv.tokenHash !== presentedHash) {
      throw new StaffInvitationError('Invalid invitation token', 403);
    }

    const nowIso = new Date().toISOString();
    const adminRef = db.collection('admins').doc(callerUid);
    const userRef = db.collection('users').doc(callerUid);

    await tx.set(invRef, { status: 'accepted', acceptedBy: callerUid, acceptedAt: nowIso, updatedAt: nowIso }, { merge: true });
    await tx.set(
      adminRef,
      {
        uid: callerUid,
        email: callerEmail.toLowerCase(),
        role: 'admin',
        permissions: Array.isArray(inv.permissions) ? inv.permissions : [],
        invitationId,
        grantedBy: inv.invitedBy,
        grantedAt: nowIso,
      },
      { merge: true }
    );
    await tx.set(
      userRef,
      {
        role: 'admin',
        adminPermissions: Array.isArray(inv.permissions) ? inv.permissions : [],
        updatedAt: nowIso,
      },
      { merge: true }
    );

    return {
      invitationId,
      status: 'accepted' as const,
      permissions: Array.isArray(inv.permissions) ? inv.permissions : [],
    };
  });
}
