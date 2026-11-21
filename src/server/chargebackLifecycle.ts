/**
 * Stripe Chargeback / Card Dispute Webhook Lifecycle (AT-PAY-16)
 * Handles charge.dispute.created, charge.dispute.updated, and charge.dispute.closed:
 * - Resolves linked jobs, quotes, rides, payment_intents, and payees
 * - Freezes job/escrow/ride payouts immediately on open disputes
 * - Writes durable chargeback_cases & immutable payment_ledger hold/loss/release records
 * - Flags admin alerts and resolves or locks payouts monotonically on dispute close
 */

export const CHARGEBACK_EVENT_TYPES = new Set([
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
]);

export function isStripeChargebackEventType(eventType: string): boolean {
  return CHARGEBACK_EVENT_TYPES.has(eventType);
}

export interface ChargebackProcessResult {
  handled: boolean;
  disputeId: string;
  action: "frozen" | "won_released" | "lost_locked" | "stale_ignored";
  linkedJobId?: string | null;
  linkedRideId?: string | null;
  linkedPayeeId?: string | null;
}

export async function processStripeChargebackEvent(
  db: any,
  event: {
    id: string;
    type: string;
    created?: number;
    data: { object: Record<string, any> };
  }
): Promise<ChargebackProcessResult> {
  const dispute = event.data?.object || {};
  const disputeId = String(dispute.id || "").trim();
  if (!disputeId) {
    throw new Error("Stripe dispute event is missing dispute ID.");
  }

  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id || null;
  const paymentIntentId = typeof dispute.payment_intent === "string"
    ? dispute.payment_intent
    : dispute.payment_intent?.id || null;
  const amountPence = Number(dispute.amount || 0);
  const currency = String(dispute.currency || "gbp").toLowerCase();
  const stripeStatus = String(dispute.status || "needs_response").toLowerCase();
  const reason = String(dispute.reason || "general");
  const eventCreated = Number(event.created || Math.floor(Date.now() / 1000));
  const nowIso = new Date().toISOString();

  // Discover linked payment_ledger / payment_intents / ride_requests
  let linkedJobId: string | null = dispute.metadata?.jobId || null;
  let linkedQuoteId: string | null = dispute.metadata?.quoteId || null;
  let linkedMilestoneId: string | null = dispute.metadata?.milestoneId || null;
  let linkedRideId: string | null = dispute.metadata?.rideId || null;
  let linkedPayerId: string | null = dispute.metadata?.userId || null;
  let linkedPayeeId: string | null = dispute.metadata?.traderId || dispute.metadata?.driverId || null;

  if (paymentIntentId && db) {
    try {
      const ledgerSnap = await db.collection("payment_ledger").where("transactionId", "==", paymentIntentId).get();
      const entry = ledgerSnap?.docs?.[0]?.data?.() || ledgerSnap?.docs?.[0]?.data;
      if (entry) {
        linkedJobId = linkedJobId || entry.jobId || null;
        linkedQuoteId = linkedQuoteId || entry.quoteId || null;
        linkedMilestoneId = linkedMilestoneId || entry.milestoneId || null;
        linkedPayerId = linkedPayerId || entry.payerId || null;
        linkedPayeeId = linkedPayeeId || entry.payeeId || null;
      }
    } catch {
      // ignore if collection query unavailable in minimal mock
    }

    if (!linkedRideId) {
      try {
        const rideSnap = await db.collection("ride_requests").where("stripePaymentIntentId", "==", paymentIntentId).get();
        const rideDoc = rideSnap?.docs?.[0];
        if (rideDoc) {
          const rideData = typeof rideDoc.data === "function" ? rideDoc.data() : rideDoc.data;
          linkedRideId = rideDoc.id;
          linkedPayerId = linkedPayerId || rideData?.passengerId || rideData?.riderId || null;
          linkedPayeeId = linkedPayeeId || rideData?.driverId || rideData?.assignedDriverId || null;
        }
      } catch {
        // ignore if unsupported
      }
    }

    if (!linkedJobId && !linkedRideId) {
      try {
        const intentSnap = await db.collection("payment_intents").where("paymentIntentId", "==", paymentIntentId).get();
        const intentData = intentSnap?.docs?.[0]?.data?.() || intentSnap?.docs?.[0]?.data;
        if (intentData) {
          linkedPayerId = linkedPayerId || intentData.userId || null;
          linkedJobId = linkedJobId || intentData.metadata?.jobId || null;
          linkedRideId = linkedRideId || intentData.metadata?.rideId || null;
        }
      } catch {
        // ignore
      }
    }
  }

  const caseRef = db.collection("chargeback_cases").doc(disputeId);
  const isClosed = event.type === "charge.dispute.closed" || ["won", "lost", "warning_closed"].includes(stripeStatus);
  const isWon = isClosed && ["won", "warning_closed"].includes(stripeStatus);
  const isLost = isClosed && stripeStatus === "lost";

  const action: ChargebackProcessResult["action"] = isWon
    ? "won_released"
    : isLost
      ? "lost_locked"
      : "frozen";

  let staleIgnored = false;
  await db.runTransaction(async (tx: any) => {
    const existingSnap = await tx.get(caseRef);
    const existing = existingSnap.exists ? (typeof existingSnap.data === "function" ? existingSnap.data() : existingSnap.data) || {} : null;
    if (existing && Number(existing.lastEventCreated || 0) > eventCreated) {
      staleIgnored = true;
      return;
    }

    // Read linked entities before writing
    const jobRef = linkedJobId ? db.collection("jobs").doc(linkedJobId) : null;
    const rideRef = linkedRideId ? db.collection("ride_requests").doc(linkedRideId) : null;
    const payeeRef = linkedPayeeId ? db.collection("users").doc(linkedPayeeId) : null;

    const [jobSnap, rideSnap, payeeSnap] = await Promise.all([
      jobRef ? tx.get(jobRef) : Promise.resolve(null),
      rideRef ? tx.get(rideRef) : Promise.resolve(null),
      payeeRef ? tx.get(payeeRef) : Promise.resolve(null),
    ]);

    tx.set(
      caseRef,
      {
        disputeId,
        chargeId,
        paymentIntentId,
        amountPence,
        currency,
        reason,
        stripeStatus,
        caseStatus: isWon ? "won" : isLost ? "lost" : "open_freeze",
        payoutsFrozen: !isWon,
        recoveryRequired: isLost,
        linkedJobId,
        linkedQuoteId,
        linkedMilestoneId,
        linkedRideId,
        linkedPayerId,
        linkedPayeeId,
        evidenceDueBy: dispute.evidence_details?.due_by || null,
        lastEventId: event.id,
        lastEventType: event.type,
        lastEventCreated: eventCreated,
        updatedAt: nowIso,
        ...(existing ? {} : { createdAt: nowIso }),
      },
      { merge: true }
    );

    if (jobSnap?.exists) {
      if (isWon) {
        tx.update(jobRef, {
          chargebackFreeze: false,
          payoutFrozen: false,
          chargebackStatus: "won",
          chargebackResolvedAt: nowIso,
          updatedAt: nowIso,
        });
      } else {
        tx.update(jobRef, {
          chargebackFreeze: true,
          payoutFrozen: true,
          chargebackDisputeId: disputeId,
          chargebackStatus: isLost ? "lost" : stripeStatus,
          escrowStatus: isLost ? "chargeback_lost" : "frozen_chargeback",
          updatedAt: nowIso,
        });
      }
    }

    if (rideSnap?.exists) {
      if (isWon) {
        tx.update(rideRef, {
          chargebackFreeze: false,
          payoutFrozen: false,
          chargebackStatus: "won",
          payoutStatus: rideSnap.data()?.payoutTransferred ? "transferred" : "pending",
          updatedAt: nowIso,
        });
      } else {
        tx.update(rideRef, {
          chargebackFreeze: true,
          payoutFrozen: true,
          chargebackDisputeId: disputeId,
          chargebackStatus: isLost ? "lost" : stripeStatus,
          payoutStatus: isLost ? "chargeback_lost" : "frozen_chargeback",
          updatedAt: nowIso,
        });
      }
    }

    if (payeeSnap?.exists) {
      const currentPayee = (typeof payeeSnap.data === "function" ? payeeSnap.data() : payeeSnap.data) || {};
      const activeIds: string[] = Array.isArray(currentPayee.activeChargebackIds)
        ? currentPayee.activeChargebackIds.filter((id: string) => id !== disputeId)
        : [];
      if (!isClosed) {
        activeIds.push(disputeId);
      }
      tx.update(payeeRef, {
        activeChargebackIds: activeIds,
        payoutsFrozenByChargeback: isLost || activeIds.length > 0,
        chargebackRecoveryRequired: Boolean(currentPayee.chargebackRecoveryRequired || isLost),
        updatedAt: nowIso,
      });
    }

    const ledgerDocId = isWon
      ? `cb_won_${disputeId}`
      : isLost
        ? `cb_loss_${disputeId}`
        : `cb_hold_${disputeId}`;
    tx.set(
      db.collection("payment_ledger").doc(ledgerDocId),
      {
        entryId: ledgerDocId,
        type: isWon ? "CHARGEBACK_WON_RELEASE" : isLost ? "CHARGEBACK_LOSS" : "CHARGEBACK_HOLD",
        status: isWon ? "completed" : isLost ? "loss_recorded" : "frozen",
        disputeId,
        chargeId,
        paymentIntentId,
        transactionId: paymentIntentId || chargeId || disputeId,
        jobId: linkedJobId,
        rideId: linkedRideId,
        payerId: linkedPayerId,
        payeeId: linkedPayeeId,
        amount: amountPence,
        currency,
        reason,
        sourceEventId: event.id,
        createdAt: nowIso,
      },
      { merge: true }
    );
  });

  if (staleIgnored) {
    return {
      handled: true,
      disputeId,
      action: "stale_ignored",
      linkedJobId,
      linkedRideId,
      linkedPayeeId,
    };
  }

  // Flag admin operational queue on open dispute creation or loss
  if (!isWon) {
    try {
      await db.collection("admin_safety_escalations").doc(`chargeback_${disputeId}`).set(
        {
          type: isLost ? "stripe_chargeback_lost" : "stripe_chargeback_opened",
          severity: "CRITICAL",
          disputeId,
          paymentIntentId,
          chargeId,
          amountPence,
          currency,
          reason,
          stripeStatus,
          linkedJobId,
          linkedRideId,
          linkedPayeeId,
          status: isLost ? "recovery_required" : "open_freeze",
          updatedAt: nowIso,
        },
        { merge: true }
      );
    } catch {
      // non-fatal escalation record failure
    }
  }

  return {
    handled: true,
    disputeId,
    action,
    linkedJobId,
    linkedRideId,
    linkedPayeeId,
  };
}
