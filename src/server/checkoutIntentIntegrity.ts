import { FieldValue } from "firebase-admin/firestore";

export type CheckoutIntentBindingState = "pending" | "valid" | "mismatch";

export type TerminalCheckoutIntentStatus = "completed" | "expired" | "failed" | "requires_reconciliation";

const TERMINAL_INTENT_STATUSES = new Set<string>([
  "completed",
  "expired",
  "failed",
  "requires_reconciliation",
]);

function getTimestampValue() {
  return typeof FieldValue?.serverTimestamp === "function"
    ? FieldValue.serverTimestamp()
    : new Date().toISOString();
}

function resolveIntentEpochMs(intent: Record<string, any>): number {
  const raw = intent.sessionCreatedAt || intent.createdAt;
  if (!raw) return 0;
  if (typeof raw?.toMillis === "function") return raw.toMillis();
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function evaluateCheckoutIntentBinding(
  intent: Record<string, any>,
  session: Record<string, any>
): CheckoutIntentBindingState {
  if (intent.status === "pending" && !intent.checkoutSessionId) return "pending";

  const expectedAmount = Number(intent.amount);
  const sessionPaymentIntentId = typeof session.payment_intent === "string"
    ? session.payment_intent
    : typeof session.payment_intent?.id === "string" ? session.payment_intent.id : "";

  const matches =
    intent.userId === session.client_reference_id &&
    intent.checkoutSessionId === session.id &&
    intent.mode === session.mode &&
    Number.isSafeInteger(expectedAmount) &&
    expectedAmount === Number(session.amount_total) &&
    String(intent.currency || "").toLowerCase() === String(session.currency || "").toLowerCase() &&
    (!intent.paymentIntentId || intent.paymentIntentId === sessionPaymentIntentId) &&
    ["session_created", "processing"].includes(String(intent.status));

  return matches ? "valid" : "mismatch";
}

/**
 * Transitions a `payment_intents` doc cleanly to a terminal state inside a transaction
 * (optionally fenced by a webhook event claim). Never overwrites a prior terminal state.
 */
export async function transitionCheckoutIntentState(input: {
  db: any;
  intentId: string;
  nextStatus: TerminalCheckoutIntentStatus;
  eventId?: string;
  sessionId?: string;
  paymentIntentId?: string;
  failureReason?: string;
  eventRef?: any;
  claimToken?: string | null;
  ownsClaimFn?: (claimData: Record<string, any>, claimToken: string | null) => boolean;
}): Promise<{ transitioned: boolean; reason?: string; currentStatus?: string }> {
  const { db, intentId, nextStatus, eventId, sessionId, paymentIntentId, failureReason, eventRef, claimToken, ownsClaimFn } = input;
  if (!db || !intentId) {
    return { transitioned: false, reason: "missing_db_or_intent" };
  }

  const intentRef = db.collection("payment_intents").doc(intentId);
  let outcome: { transitioned: boolean; reason?: string; currentStatus?: string } = { transitioned: true };

  await db.runTransaction(async (tx: any) => {
    if (eventRef && ownsClaimFn) {
      const claimSnap = await tx.get(eventRef);
      const claimData = claimSnap?.data ? claimSnap.data() || {} : {};
      if (!ownsClaimFn(claimData, claimToken ?? null)) {
        throw new Error("Webhook claim lost before checkout intent terminal transition.");
      }
    }

    const intentSnap = await tx.get(intentRef);
    if (!intentSnap.exists) {
      outcome = { transitioned: false, reason: "intent_not_found" };
      return;
    }

    const current = intentSnap.data() || {};
    const currentStatus = String(current.status || "");
    if (TERMINAL_INTENT_STATUSES.has(currentStatus)) {
      outcome = { transitioned: false, reason: "already_terminal", currentStatus };
      return;
    }

    const patch: Record<string, any> = {
      status: nextStatus,
      terminalAt: getTimestampValue(),
      updatedAt: getTimestampValue(),
    };
    if (nextStatus === "completed") patch.completedAt = getTimestampValue();
    if (nextStatus === "expired") patch.expiredAt = getTimestampValue();
    if (nextStatus === "failed") {
      patch.failedAt = getTimestampValue();
      if (failureReason) patch.failureReason = String(failureReason).slice(0, 500);
    }
    if (nextStatus === "requires_reconciliation" && failureReason) {
      patch.reviewReason = String(failureReason).slice(0, 500);
    }
    if (eventId) patch.terminalEventId = eventId;
    if (sessionId && !current.checkoutSessionId) patch.checkoutSessionId = sessionId;
    if (paymentIntentId && !current.paymentIntentId) patch.paymentIntentId = paymentIntentId;

    tx.update(intentRef, patch);
  });

  return outcome;
}

/**
 * Bounded sweeper that reconciles stale pending/session_created `payment_intents` against
 * Stripe Checkout Sessions so abandoned or failed checkouts never remain stuck non-terminal.
 */
export async function sweepStaleCheckoutIntents(input: {
  db: any;
  stripeClient?: any;
  nowMs?: number;
  staleAfterMs?: number;
  maxBatch?: number;
}): Promise<{
  scanned: number;
  expired: number;
  failed: number;
  flaggedForReconciliation: number;
  errors: number;
}> {
  const { db, stripeClient } = input;
  const nowMs = typeof input.nowMs === "number" ? input.nowMs : Date.now();
  const staleAfterMs = typeof input.staleAfterMs === "number" ? input.staleAfterMs : 25 * 60 * 60 * 1000;
  const maxBatch = Math.min(200, Math.max(1, Number(input.maxBatch || 50)));

  if (!db) {
    return { scanned: 0, expired: 0, failed: 0, flaggedForReconciliation: 0, errors: 0 };
  }

  const [pendingSnap, createdSnap] = await Promise.all([
    db.collection("payment_intents").where("status", "==", "pending").limit(maxBatch).get(),
    db.collection("payment_intents").where("status", "==", "session_created").limit(maxBatch).get(),
  ]);

  const docs = [...(pendingSnap?.docs || []), ...(createdSnap?.docs || [])].slice(0, maxBatch);
  let scanned = 0;
  let expired = 0;
  let failed = 0;
  let flaggedForReconciliation = 0;
  let errors = 0;

  for (const doc of docs) {
    scanned += 1;
    const data = typeof doc.data === "function" ? doc.data() : doc.data || {};
    const createdMs = resolveIntentEpochMs(data);
    if (!createdMs || nowMs - createdMs < staleAfterMs) {
      continue;
    }

    try {
      const sessionId = typeof data.checkoutSessionId === "string" ? data.checkoutSessionId.trim() : "";
      if (sessionId && stripeClient?.checkout?.sessions?.retrieve) {
        const session = await stripeClient.checkout.sessions.retrieve(sessionId);
        if (session?.payment_status === "paid" || session?.status === "complete") {
          const res = await transitionCheckoutIntentState({
            db,
            intentId: doc.id,
            nextStatus: "requires_reconciliation",
            sessionId,
            failureReason: "sweeper_found_paid_stripe_session_without_terminal_intent",
          });
          if (res.transitioned) flaggedForReconciliation += 1;
          continue;
        }
        if (session?.status === "expired") {
          const res = await transitionCheckoutIntentState({
            db,
            intentId: doc.id,
            nextStatus: "expired",
            sessionId,
          });
          if (res.transitioned) expired += 1;
          continue;
        }
        if (session?.status === "open" && stripeClient?.checkout?.sessions?.expire) {
          await stripeClient.checkout.sessions.expire(sessionId).catch(() => undefined);
          const res = await transitionCheckoutIntentState({
            db,
            intentId: doc.id,
            nextStatus: "expired",
            sessionId,
          });
          if (res.transitioned) expired += 1;
          continue;
        }
      }

      if (typeof data.paymentIntentId === "string" && data.paymentIntentId.trim() && stripeClient?.paymentIntents?.retrieve) {
        const pi = await stripeClient.paymentIntents.retrieve(data.paymentIntentId.trim());
        if (pi?.status === "succeeded") {
          const res = await transitionCheckoutIntentState({
            db,
            intentId: doc.id,
            nextStatus: "requires_reconciliation",
            paymentIntentId: pi.id,
            failureReason: "sweeper_found_succeeded_payment_intent",
          });
          if (res.transitioned) flaggedForReconciliation += 1;
          continue;
        }
        if (pi?.status === "canceled" || pi?.last_payment_error) {
          const res = await transitionCheckoutIntentState({
            db,
            intentId: doc.id,
            nextStatus: "failed",
            paymentIntentId: pi.id,
            failureReason: pi.last_payment_error?.message || "Payment intent canceled or failed prior to expiry",
          });
          if (res.transitioned) failed += 1;
          continue;
        }
      }

      // Past staleAfterMs (>25h) with no completed payment: mark expired cleanly.
      const res = await transitionCheckoutIntentState({
        db,
        intentId: doc.id,
        nextStatus: "expired",
        ...(sessionId ? { sessionId } : {}),
      });
      if (res.transitioned) expired += 1;
    } catch {
      errors += 1;
    }
  }

  return { scanned, expired, failed, flaggedForReconciliation, errors };
}

