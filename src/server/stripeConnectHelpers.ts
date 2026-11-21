import crypto from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } from "./httpErrors.ts";

const PAYOUT_ELIGIBLE_ROLES = new Set([
  "tradesperson",
  "trader",
  "driver",
  "fleet_driver",
  "provider",
  "business",
]);

function serverTimestampOrIso() {
  return typeof FieldValue?.serverTimestamp === "function"
    ? FieldValue.serverTimestamp()
    : new Date().toISOString();
}

export function isPayoutEligibleUser(userData: Record<string, any> | null | undefined): boolean {
  if (!userData || typeof userData !== "object") return false;
  const role = String(userData.role || "").trim().toLowerCase();
  if (PAYOUT_ELIGIBLE_ROLES.has(role)) return true;
  if (userData.isDriver === true || userData.isTradesperson === true) return true;
  return false;
}

export function assertPayoutEligibleRole(userData: Record<string, any> | null | undefined): void {
  if (!isPayoutEligibleUser(userData)) {
    throw new ForbiddenError(
      "Stripe Connect payouts are restricted to verified tradespeople, drivers, and service providers."
    );
  }
}

export interface EnsureStripeAccountInput {
  db: any;
  stripe: any;
  authUid: string;
  userData: Record<string, any>;
}

/**
 * Atomically reserves Connect onboarding for a user, passes a deterministic Stripe
 * idempotency key to stripe.accounts.create, and recovers orphaned Express account IDs
 * idempotently if persistence retries after Stripe creation.
 */
export async function ensureStripeAccountForProvider({
  db,
  stripe,
  authUid,
  userData,
}: EnsureStripeAccountInput): Promise<{ accountId: string; created: boolean; recovered: boolean }> {
  const existingOnUser = typeof userData?.stripeAccountId === "string" ? userData.stripeAccountId.trim() : "";
  if (existingOnUser && !existingOnUser.startsWith("acct_mock_")) {
    return { accountId: existingOnUser, created: false, recovered: false };
  }

  const userRef = db.collection("users").doc(authUid);
  const lockRef = db.collection("stripe_connect_locks").doc(authUid);
  const now = Date.now();
  const leaseDurationMs = 60_000;

  const reservation = await db.runTransaction(async (tx: any) => {
    const [latestUserSnap, lockSnap] = await Promise.all([tx.get(userRef), tx.get(lockRef)]);
    if (!latestUserSnap.exists) {
      throw new NotFoundError("User profile not found");
    }
    const latestUser = latestUserSnap.data() || {};
    assertPayoutEligibleRole(latestUser);

    const latestAccountId = typeof latestUser.stripeAccountId === "string" ? latestUser.stripeAccountId.trim() : "";
    if (latestAccountId && !latestAccountId.startsWith("acct_mock_")) {
      return { action: "existing" as const, accountId: latestAccountId };
    }

    const lockData = lockSnap?.exists ? lockSnap.data() || {} : null;
    if (lockData?.pendingStripeAccountId && typeof lockData.pendingStripeAccountId === "string") {
      // Orphaned Express account ID from an interrupted save: heal user profile atomically.
      const recoveredId = lockData.pendingStripeAccountId.trim();
      if (recoveredId && !recoveredId.startsWith("acct_mock_")) {
        tx.set(
          userRef,
          {
            stripeAccountId: recoveredId,
            updatedAt: serverTimestampOrIso(),
          },
          { merge: true }
        );
        tx.set(
          lockRef,
          {
            status: "completed",
            stripeAccountId: recoveredId,
            pendingStripeAccountId: null,
            leaseExpiresAtMs: 0,
            recoveredAtMs: now,
            updatedAt: serverTimestampOrIso(),
          },
          { merge: true }
        );
        return { action: "recovered" as const, accountId: recoveredId };
      }
    }

    if (lockData?.status === "creating" && Number(lockData.leaseExpiresAtMs || 0) > now) {
      throw new ConflictError("Stripe Connect account creation is already in progress. Please retry in a few seconds.");
    }

    const idempotencyKey =
      typeof lockData?.stripeIdempotencyKey === "string" && lockData.stripeIdempotencyKey.trim()
        ? lockData.stripeIdempotencyKey.trim()
        : `connect_acct_${authUid}_${crypto.randomUUID()}`;

    tx.set(
      lockRef,
      {
        uid: authUid,
        status: "creating",
        stripeIdempotencyKey: idempotencyKey,
        leaseExpiresAtMs: now + leaseDurationMs,
        updatedAt: serverTimestampOrIso(),
      },
      { merge: true }
    );

    return {
      action: "create" as const,
      idempotencyKey,
      email: latestUser.email,
      role: latestUser.role || "tradesperson",
    };
  });

  if (reservation.action === "existing") {
    return { accountId: reservation.accountId, created: false, recovered: false };
  }
  if (reservation.action === "recovered") {
    return { accountId: reservation.accountId, created: false, recovered: true };
  }

  let account: any;
  try {
    account = await stripe.accounts.create(
      {
        type: "express",
        country: "GB",
        ...(reservation.email ? { email: reservation.email } : {}),
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: "individual",
        metadata: {
          firebaseUid: authUid,
          role: String(reservation.role || "tradesperson"),
        },
      },
      { idempotencyKey: reservation.idempotencyKey }
    );
  } catch (stripeErr) {
    await lockRef
      .set(
        {
          status: "failed",
          leaseExpiresAtMs: 0,
          lastError: (stripeErr as any)?.message || "Stripe Connect creation failed",
          updatedAt: serverTimestampOrIso(),
        },
        { merge: true }
      )
      .catch(() => undefined);
    throw stripeErr;
  }

  const createdAccountId = String(account?.id || "").trim();
  if (!createdAccountId) {
    throw new ServiceUnavailableError("Stripe did not return a valid Connect account ID.");
  }

  // Record pending ID immediately before atomic commit so retries always recover if DB transaction retries.
  await lockRef
    .set(
      {
        pendingStripeAccountId: createdAccountId,
        updatedAt: serverTimestampOrIso(),
      },
      { merge: true }
    )
    .catch(() => undefined);

  await db.runTransaction(async (tx: any) => {
    const latestUserSnap = await tx.get(userRef);
    const latestUser = latestUserSnap?.exists ? latestUserSnap.data() || {} : {};
    const existingId = typeof latestUser.stripeAccountId === "string" ? latestUser.stripeAccountId.trim() : "";
    const finalId = existingId && !existingId.startsWith("acct_mock_") ? existingId : createdAccountId;

    tx.set(
      userRef,
      {
        stripeAccountId: finalId,
        updatedAt: serverTimestampOrIso(),
      },
      { merge: true }
    );
    tx.set(
      lockRef,
      {
        status: "completed",
        stripeAccountId: finalId,
        pendingStripeAccountId: null,
        leaseExpiresAtMs: 0,
        completedAtMs: Date.now(),
        updatedAt: serverTimestampOrIso(),
      },
      { merge: true }
    );
  });

  return { accountId: createdAccountId, created: true, recovered: false };
}

/**
 * Transactionally reserves and creates a single Stripe Customer ID per user across
 * Checkout and SetupIntent flows, eliminating duplicate Stripe customers on concurrency.
 */
export async function ensureStripeCustomerIdForUser({
  db,
  stripe,
  userId,
}: {
  db: any;
  stripe: any;
  userId: string;
}): Promise<string> {
  if (!db) throw new ServiceUnavailableError("Database backend unavailable");
  if (!userId) throw new ForbiddenError("Authenticated user ID is required");

  const userRef = db.collection("users").doc(userId);
  const lockRef = db.collection("stripe_customer_locks").doc(userId);
  const now = Date.now();
  const leaseDurationMs = 30_000;

  const reservation = await db.runTransaction(async (tx: any) => {
    const [userSnap, lockSnap] = await Promise.all([tx.get(userRef), tx.get(lockRef)]);
    if (!userSnap.exists) {
      throw new NotFoundError("User profile not found");
    }
    const userData = userSnap.data() || {};
    const existingCustomerId = typeof userData.stripeCustomerId === "string" ? userData.stripeCustomerId.trim() : "";
    if (existingCustomerId) {
      return { action: "existing" as const, customerId: existingCustomerId };
    }

    const lockData = lockSnap?.exists ? lockSnap.data() || {} : null;
    if (lockData?.pendingStripeCustomerId && typeof lockData.pendingStripeCustomerId === "string") {
      const recoveredId = lockData.pendingStripeCustomerId.trim();
      if (recoveredId) {
        tx.set(userRef, { stripeCustomerId: recoveredId, updatedAt: serverTimestampOrIso() }, { merge: true });
        tx.set(
          lockRef,
          {
            status: "completed",
            stripeCustomerId: recoveredId,
            pendingStripeCustomerId: null,
            leaseExpiresAtMs: 0,
            updatedAt: serverTimestampOrIso(),
          },
          { merge: true }
        );
        return { action: "existing" as const, customerId: recoveredId };
      }
    }

    if (lockData?.status === "creating" && Number(lockData.leaseExpiresAtMs || 0) > now) {
      throw new ConflictError("Stripe customer initialization is already in progress. Please retry in a moment.");
    }

    const idempotencyKey =
      typeof lockData?.stripeIdempotencyKey === "string" && lockData.stripeIdempotencyKey.trim()
        ? lockData.stripeIdempotencyKey.trim()
        : `cust_create_${userId}_${crypto.randomUUID()}`;

    tx.set(
      lockRef,
      {
        uid: userId,
        status: "creating",
        stripeIdempotencyKey: idempotencyKey,
        leaseExpiresAtMs: now + leaseDurationMs,
        updatedAt: serverTimestampOrIso(),
      },
      { merge: true }
    );

    return {
      action: "create" as const,
      idempotencyKey,
      email: typeof userData.email === "string" ? userData.email.trim() : undefined,
    };
  });

  if (reservation.action === "existing") {
    return reservation.customerId;
  }

  let customer: any;
  try {
    customer = await stripe.customers.create(
      {
        ...(reservation.email ? { email: reservation.email } : {}),
        metadata: { firebaseUid: userId },
      },
      { idempotencyKey: reservation.idempotencyKey }
    );
  } catch (err) {
    await lockRef
      .set(
        {
          status: "failed",
          leaseExpiresAtMs: 0,
          lastError: (err as any)?.message || "Stripe customer create failed",
          updatedAt: serverTimestampOrIso(),
        },
        { merge: true }
      )
      .catch(() => undefined);
    throw err;
  }

  const createdCustomerId = String(customer?.id || "").trim();
  if (!createdCustomerId) {
    throw new ServiceUnavailableError("Stripe did not return a customer ID.");
  }

  await lockRef
    .set(
      {
        pendingStripeCustomerId: createdCustomerId,
        updatedAt: serverTimestampOrIso(),
      },
      { merge: true }
    )
    .catch(() => undefined);

  let resolvedCustomerId = createdCustomerId;
  await db.runTransaction(async (tx: any) => {
    const latestSnap = await tx.get(userRef);
    const latest = latestSnap?.exists ? latestSnap.data() || {} : {};
    const currentId = typeof latest.stripeCustomerId === "string" ? latest.stripeCustomerId.trim() : "";
    resolvedCustomerId = currentId || createdCustomerId;

    tx.set(
      userRef,
      {
        stripeCustomerId: resolvedCustomerId,
        updatedAt: serverTimestampOrIso(),
      },
      { merge: true }
    );
    tx.set(
      lockRef,
      {
        status: "completed",
        stripeCustomerId: resolvedCustomerId,
        pendingStripeCustomerId: null,
        leaseExpiresAtMs: 0,
        completedAtMs: Date.now(),
        updatedAt: serverTimestampOrIso(),
      },
      { merge: true }
    );
  });

  return resolvedCustomerId;
}

/**
 * Reconciles a Stripe `account.updated` webhook event into canonical `users/{uid}`
 * and linked `driver_profiles/{uid}` records inside a fenced transaction.
 */
export async function reconcileStripeAccountUpdatedWebhook({
  db,
  eventId,
  eventCreated,
  account,
  eventRef,
  claimToken,
  ownsClaimFn,
}: {
  db: any;
  eventId: string;
  eventCreated: number;
  account: any;
  eventRef?: any;
  claimToken?: string | null;
  ownsClaimFn?: (claimData: Record<string, any>, claimToken: string | null) => boolean;
}): Promise<{ synced: boolean; uid?: string; reason?: string }> {
  const accountId = typeof account?.id === "string" ? account.id.trim() : "";
  if (!db || !accountId) {
    return { synced: false, reason: "missing_db_or_account_id" };
  }

  const byAccountSnap = await db.collection("users").where("stripeAccountId", "==", accountId).limit(2).get();
  if (byAccountSnap.size > 1) {
    throw new Error(`Stripe Connect account ${accountId} is linked to multiple users; manual reconciliation required.`);
  }

  let targetUserRef = byAccountSnap.empty ? null : byAccountSnap.docs[0].ref;
  if (!targetUserRef) {
    const fallbackUid = typeof account?.metadata?.firebaseUid === "string" ? account.metadata.firebaseUid.trim() : "";
    if (fallbackUid) {
      const candidateRef = db.collection("users").doc(fallbackUid);
      const candidateSnap = await candidateRef.get();
      if (candidateSnap.exists) {
        const currentAcct = candidateSnap.data()?.stripeAccountId;
        if (!currentAcct || currentAcct === accountId || String(currentAcct).startsWith("acct_mock_")) {
          targetUserRef = candidateRef;
        }
      }
    }
  }

  if (!targetUserRef) {
    return { synced: false, reason: "no_matching_user" };
  }

  const targetUid = targetUserRef.id;
  const driverProfileRef = db.collection("driver_profiles").doc(targetUid);
  const payoutsEnabled = Boolean(account.payouts_enabled);
  const chargesEnabled = Boolean(account.charges_enabled);
  const detailsSubmitted = Boolean(account.details_submitted);
  const transfersCapability = String(account.capabilities?.transfers || "inactive");
  const cardPaymentsCapability = String(account.capabilities?.card_payments || "inactive");
  const disabledReason = account.requirements?.disabled_reason ? String(account.requirements.disabled_reason) : null;
  const currentlyDue = Array.isArray(account.requirements?.currently_due)
    ? account.requirements.currently_due.map((item: unknown) => String(item)).slice(0, 50)
    : [];

  let result: { synced: boolean; uid: string; reason?: string } = { synced: true, uid: targetUid };

  await db.runTransaction(async (tx: any) => {
    if (eventRef && ownsClaimFn) {
      const claimSnap = await tx.get(eventRef);
      const claimData = claimSnap?.data ? claimSnap.data() || {} : {};
      if (!ownsClaimFn(claimData, claimToken ?? null)) {
        throw new Error("Webhook claim lost before account.updated mutation.");
      }
    }

    const [userSnap, driverSnap] = await Promise.all([tx.get(targetUserRef), tx.get(driverProfileRef)]);
    if (!userSnap.exists) {
      result = { synced: false, uid: targetUid, reason: "user_missing" };
      return;
    }

    const current = userSnap.data() || {};
    if (current.stripeAccountId && !String(current.stripeAccountId).startsWith("acct_mock_") && current.stripeAccountId !== accountId) {
      result = { synced: false, uid: targetUid, reason: "account_id_mismatch" };
      return;
    }
    if (Number(current.stripeAccountLastEventCreated || 0) > Number(eventCreated || 0)) {
      result = { synced: false, uid: targetUid, reason: "stale_out_of_order_event" };
      return;
    }

    const capabilitiesPatch = {
      transfers: transfersCapability,
      cardPayments: cardPaymentsCapability,
    };
    const requirementsPatch = {
      disabledReason,
      currentlyDue,
    };

    tx.update(targetUserRef, {
      stripeAccountId: accountId,
      payoutsEnabled,
      chargesEnabled,
      stripeOnboardingComplete: detailsSubmitted,
      stripeCapabilities: capabilitiesPatch,
      stripeRequirements: requirementsPatch,
      stripeAccountLastEventCreated: Number(eventCreated || 0),
      stripeAccountLastEventId: eventId,
      updatedAt: serverTimestampOrIso(),
    });

    if (driverSnap?.exists) {
      tx.update(driverProfileRef, {
        stripeAccountId: accountId,
        payoutsEnabled,
        chargesEnabled,
        stripeOnboardingComplete: detailsSubmitted,
        stripeCapabilities: capabilitiesPatch,
        updatedAt: serverTimestampOrIso(),
      });
    }
  });

  return result;
}
