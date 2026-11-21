/**
 * SERVER-AUTHORITATIVE PROVIDER PAYOUT COMMAND (AT-PAY-09)
 * Shared by both AnyTrader tradespeople and AnyRoller drivers.
 * Enforces:
 * - Mandatory durable Idempotency-Key (replays return cached result; mismatched payloads throw 409)
 * - Transactional per-provider payout lock with TTL lease (prevents double payout races)
 * - Account freeze / chargeback / suspension checks
 * - Deterministic Stripe idempotencyKey passed to Stripe Connect payouts.create
 */

import * as admin from "firebase-admin";
import * as crypto from "crypto";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "./httpErrors.ts";
import { domainEvents } from "./domainEvents.ts";

function serverTimestampOrNow(): any {
  try {
    return admin.firestore.FieldValue.serverTimestamp();
  } catch {
    return new Date().toISOString();
  }
}

function hashIdempotencyKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export interface ExecuteProviderPayoutInput {
  db: any;
  stripe: any | null;
  authUid: string;
  idempotencyKey?: string | null;
  amountGbp?: unknown;
  isMockDisallowed?: boolean;
  nowMs?: number;
}

export interface ExecuteProviderPayoutResult {
  success: true;
  payout: Record<string, any>;
  idempotentReplay?: boolean;
  mock?: boolean;
}

const PAYOUT_LOCK_TTL_MS = 60 * 1000; // 60-second active lease

export async function executeProviderPayoutCommand({
  db,
  stripe,
  authUid,
  idempotencyKey,
  amountGbp,
  isMockDisallowed = process.env.NODE_ENV === "production" || process.env.ALLOW_MOCK_PAYMENTS !== "true",
  nowMs = Date.now(),
}: ExecuteProviderPayoutInput): Promise<ExecuteProviderPayoutResult> {
  if (!db) throw new BadRequestError("Database not connected");
  if (!authUid) throw new ForbiddenError("Authentication required");

  const cleanKey = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
  if (cleanKey.length < 8) {
    throw new BadRequestError(
      "A durable Idempotency-Key header (minimum 8 characters) is required for provider payout requests."
    );
  }

  let requestedAmountPence: number | null = null;
  if (amountGbp !== undefined && amountGbp !== null && amountGbp !== "") {
    const parsedGbp = Number(amountGbp);
    if (!Number.isFinite(parsedGbp) || parsedGbp <= 0) {
      throw new BadRequestError("Requested payout amount must be a positive GBP amount.");
    }
    requestedAmountPence = Math.round(parsedGbp * 100);
    if (requestedAmountPence < 100) {
      throw new BadRequestError("Minimum payout request is £1.00.");
    }
  }

  const requestFingerprint = requestedAmountPence !== null ? `pence:${requestedAmountPence}` : "full_available";
  const keyHash = hashIdempotencyKey(cleanKey);
  const idemRef = db.collection("provider_payout_idempotency").doc(`${authUid}__${keyHash}`);
  const lockRef = db.collection("provider_payout_locks").doc(authUid);
  const userRef = db.collection("users").doc(authUid);
  const lockToken = crypto.randomUUID();

  let stripeAccountId = "";
  let cachedReplayResult: ExecuteProviderPayoutResult | null = null;

  await db.runTransaction(async (tx: any) => {
    const [userDoc, idemDoc, lockDoc] = await Promise.all([
      tx.get(userRef),
      tx.get(idemRef),
      tx.get(lockRef),
    ]);

    if (!userDoc.exists) {
      throw new NotFoundError("User not found");
    }

    const userData = userDoc.data() || {};
    if (
      userData.isSuspended === true ||
      userData.isFrozen === true ||
      userData.banned === true ||
      userData.payoutsFrozenByChargeback === true ||
      userData.payoutFrozen === true
    ) {
      throw new ForbiddenError("Payouts are currently frozen on your account. Please contact support.");
    }

    stripeAccountId = String(userData.stripeAccountId || "").trim();
    if (!stripeAccountId) {
      throw new BadRequestError("No Stripe account connected");
    }

    if (idemDoc.exists) {
      const idemData = idemDoc.data() || {};
      if (idemData.requestFingerprint !== requestFingerprint) {
        throw new ConflictError(
          "Idempotency-Key was already used with a different payout amount."
        );
      }
      if (idemData.status === "completed" && idemData.payout) {
        cachedReplayResult = {
          success: true,
          idempotentReplay: true,
          mock: Boolean(idemData.mock),
          payout: idemData.payout,
        };
        return;
      }
      if (idemData.status === "in_progress") {
        throw new ConflictError("A payout request with this Idempotency-Key is already in progress.");
      }
      if (idemData.status === "failed") {
        throw new ConflictError(
          "The previous payout attempt using this Idempotency-Key failed. Please generate a new Idempotency-Key to retry."
        );
      }
    }

    if (lockDoc.exists) {
      const lockData = lockDoc.data() || {};
      if (lockData.active === true && Number(lockData.expiresAtMs || 0) > nowMs) {
        throw new ConflictError(
          "Another payout request is currently being processed for your account. Please wait a moment and try again."
        );
      }
    }

    tx.set(lockRef, {
      active: true,
      lockToken,
      authUid,
      idempotencyKeyHash: keyHash,
      startedAtMs: nowMs,
      expiresAtMs: nowMs + PAYOUT_LOCK_TTL_MS,
      updatedAt: serverTimestampOrNow(),
    });

    tx.set(idemRef, {
      authUid,
      idempotencyKeyHash: keyHash,
      requestFingerprint,
      requestedAmountPence,
      status: "in_progress",
      lockToken,
      createdAt: serverTimestampOrNow(),
      updatedAt: serverTimestampOrNow(),
    });
  });

  if (cachedReplayResult) {
    return cachedReplayResult;
  }

  const releaseLockSafely = async () => {
    try {
      await db.runTransaction(async (tx: any) => {
        const snap = await tx.get(lockRef);
        if (snap.exists && snap.data()?.lockToken === lockToken) {
          tx.set(
            lockRef,
            {
              active: false,
              lockToken: null,
              releasedAtMs: Date.now(),
              updatedAt: serverTimestampOrNow(),
            },
            { merge: true }
          );
        }
      });
    } catch (releaseErr) {
      console.warn("[ProviderPayout] Failed to release lock cleanly:", releaseErr);
    }
  };

  const markIdempotencyFailed = async (errMsg: string) => {
    try {
      await idemRef.set(
        {
          status: "failed",
          errorMessage: errMsg.slice(0, 300),
          failedAt: serverTimestampOrNow(),
          updatedAt: serverTimestampOrNow(),
        },
        { merge: true }
      );
    } catch (markErr) {
      console.warn("[ProviderPayout] Failed to persist failure state:", markErr);
    }
  };

  try {
    if (stripeAccountId.startsWith("acct_mock_")) {
      if (isMockDisallowed) {
        throw new BadRequestError("Payouts cannot be requested for mock Stripe accounts in live environments.");
      }
      const mockPayout = {
        id: `po_mock_${keyHash.slice(0, 12)}`,
        amount: requestedAmountPence ?? 5000,
        currency: "gbp",
        status: "in_transit",
      };
      await idemRef.set(
        {
          status: "completed",
          mock: true,
          payoutId: mockPayout.id,
          payout: mockPayout,
          completedAt: serverTimestampOrNow(),
          updatedAt: serverTimestampOrNow(),
        },
        { merge: true }
      );
      return { success: true, mock: true, payout: mockPayout };
    }

    if (!stripe) {
      if (isMockDisallowed) {
        const unavailableErr: any = new Error("Stripe payout service is unavailable: Gateway is unconfigured.");
        unavailableErr.status = 503;
        throw unavailableErr;
      }
      const mockPayout = {
        id: `po_mock_${keyHash.slice(0, 12)}`,
        amount: requestedAmountPence ?? 5000,
        currency: "gbp",
        status: "in_transit",
      };
      await idemRef.set(
        {
          status: "completed",
          mock: true,
          payoutId: mockPayout.id,
          payout: mockPayout,
          completedAt: serverTimestampOrNow(),
          updatedAt: serverTimestampOrNow(),
        },
        { merge: true }
      );
      return { success: true, mock: true, payout: mockPayout };
    }

    const balance = await stripe.balance.retrieve({
      stripeAccount: stripeAccountId,
    });

    const available =
      balance?.available?.find((b: any) => String(b.currency).toLowerCase() === "gbp")?.amount || 0;
    if (available <= 0) {
      throw new BadRequestError("No available balance for payout");
    }

    const payoutAmountPence = requestedAmountPence !== null ? requestedAmountPence : available;
    if (payoutAmountPence > available) {
      throw new BadRequestError(
        `Requested payout (${(payoutAmountPence / 100).toFixed(2)}) exceeds available balance (${(available / 100).toFixed(2)})`
      );
    }

    const stripeIdempotencyKey = `provider-payout:${authUid}:${keyHash}`;
    const payout = await stripe.payouts.create(
      {
        amount: payoutAmountPence,
        currency: "gbp",
        metadata: {
          userId: authUid,
          idempotencyKeyHash: keyHash,
        },
      },
      {
        stripeAccount: stripeAccountId,
        idempotencyKey: stripeIdempotencyKey,
      }
    );

    const sanitizedPayout = {
      id: payout.id,
      amount: payout.amount,
      currency: payout.currency || "gbp",
      status: payout.status || "pending",
      arrival_date: payout.arrival_date ?? null,
    };

    await idemRef.set(
      {
        status: "completed",
        mock: false,
        payoutId: sanitizedPayout.id,
        payoutAmountPence,
        stripeIdempotencyKey,
        payout: sanitizedPayout,
        completedAt: serverTimestampOrNow(),
        updatedAt: serverTimestampOrNow(),
      },
      { merge: true }
    );

    await domainEvents.dispatch(
      "PROVIDER_PAYOUT_INITIATED",
      sanitizedPayout.id,
      authUid,
      {
        amount: payoutAmountPence,
        currency: "gbp",
        idempotencyKeyHash: keyHash,
      },
      undefined,
      db
    );

    return {
      success: true,
      payout: sanitizedPayout,
    };
  } catch (err: any) {
    await markIdempotencyFailed(err?.message || "Payout failed");
    throw err;
  } finally {
    await releaseLockSafely();
  }
}
