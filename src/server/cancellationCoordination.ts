/**
 * Job Cancellation Escrow & Mediation-Stake Financial Coordination (AT-PAY-12)
 * Ensures job cancellation inspects funded milestones and active mediation stakes,
 * freezes releasable escrow, initiates deterministic refund evaluation/tracking,
 * and opens recoverable stake tracking so cancelled jobs never leave orphaned funds.
 */

export interface CancellationCoordinationResult {
  jobId: string;
  escrowCancellationStatus: "none" | "refunded" | "refund_pending" | "partial_refund_review" | "manual_review";
  frozenMilestonesCount: number;
  refundedMilestonesCount: number;
  mediationStakeRecoveryStatus: "none" | "pending_review" | "refunded" | "forfeited_review";
}

export async function coordinateJobCancellationFinancials(
  db: any,
  params: {
    jobId: string;
    actorUid: string;
    jobData: Record<string, any>;
    cancellationReason?: string;
    stripe?: any;
  }
): Promise<CancellationCoordinationResult> {
  const { jobId, actorUid, jobData, cancellationReason = "Cancelled", stripe } = params;
  const nowIso = new Date().toISOString();

  const homeOwnerId = jobData.homeownerId || jobData.userId || jobData.ownerId || jobData.customerId || null;
  const cancelledByHomeowner = actorUid === homeOwnerId;

  let frozenMilestonesCount = 0;
  let refundedMilestonesCount = 0;
  let needsReview = false;

  const jobRef = db.collection("jobs").doc(jobId);

  // 1. Inspect quotes subcollection safely (handle minimal unit mocks without .collection on docRef)
  let quoteDocs: any[] = [];
  try {
    if (typeof jobRef.collection === "function") {
      const quotesSnap = await jobRef.collection("quotes").get();
      quoteDocs = quotesSnap?.docs || [];
    } else if (typeof db.collection === "function") {
      const subSnap = await db.collection(`jobs/${jobId}/quotes`).get();
      quoteDocs = subSnap?.docs || [];
    }
  } catch {
    quoteDocs = [];
  }

  for (const quoteDoc of quoteDocs) {
    const quoteData = typeof quoteDoc.data === "function" ? quoteDoc.data() : quoteDoc.data || {};
    const milestones = Array.isArray(quoteData.milestones) ? quoteData.milestones : [];
    if (milestones.length === 0) continue;

    let quoteModified = false;
    const updatedMilestones = [];

    for (const m of milestones) {
      const status = String(m.status || "").toLowerCase();
      const isFundedAndUnreleased =
        (["funded", "work_submitted", "in_escrow"].includes(status) || m.escrowFunded === true) &&
        !["released", "funds_released", "refunded", "cancelled_refunded"].includes(status) &&
        !m.releasedAt;

      if (!isFundedAndUnreleased) {
        updatedMilestones.push(m);
        continue;
      }

      frozenMilestonesCount++;
      quoteModified = true;

      const paymentIntentId = typeof m.stripePaymentIntentId === "string" ? m.stripePaymentIntentId : "";
      const amountPence = Math.round(Number(m.verifiedAmount || m.amount || 0) * 100);
      const caseId = `cancel_${jobId}_${quoteDoc.id}_${m.id || frozenMilestonesCount}`;
      const caseRef = db.collection("escrow_cancellation_cases").doc(caseId);

      let milestoneStatus = "cancelled_refund_pending";
      let refundStatus: "pending_evaluation" | "refunded" | "manual_review" = "pending_evaluation";
      let stripeRefundId: string | null = null;
      let refundError: string | null = null;

      if (stripe && /^pi_[A-Za-z0-9_]+$/.test(paymentIntentId) && amountPence > 0) {
        try {
          const refund = await stripe.refunds.create(
            {
              payment_intent: paymentIntentId,
              amount: amountPence,
              reason: "requested_by_customer",
              metadata: {
                jobId,
                quoteId: quoteDoc.id,
                milestoneId: String(m.id || "0"),
                operationType: "JOB_CANCEL_ESCROW_REFUND",
              },
            },
            { idempotencyKey: `cancel-refund:${jobId}:${quoteDoc.id}:${m.id || "0"}` }
          );
          if (refund?.id && refund.status === "succeeded") {
            refundStatus = "refunded";
            milestoneStatus = "refunded";
            stripeRefundId = refund.id;
            refundedMilestonesCount++;
          } else {
            refundStatus = "manual_review";
            stripeRefundId = refund?.id || null;
            needsReview = true;
          }
        } catch (err: any) {
          refundStatus = "manual_review";
          refundError = err?.message || String(err);
          needsReview = true;
        }
      } else if (paymentIntentId || m.escrowFunded) {
        // Record pending refund evaluation when Stripe client unavailable or PI requires lookup
        refundStatus = process.env.NODE_ENV === "production" ? "manual_review" : "pending_evaluation";
        if (process.env.NODE_ENV === "production") needsReview = true;
      }

      await caseRef.set(
        {
          id: caseId,
          jobId,
          quoteId: quoteDoc.id,
          milestoneId: m.id || null,
          amountPence,
          paymentIntentId: paymentIntentId || null,
          stripeRefundId,
          refundStatus,
          refundError,
          cancelledBy: actorUid,
          cancellationReason,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        { merge: true }
      );

      updatedMilestones.push({
        ...m,
        status: milestoneStatus,
        escrowFrozen: true,
        escrowFrozenReason: "job_cancelled",
        frozenAt: nowIso,
        isRefunded: refundStatus === "refunded",
        refundId: stripeRefundId,
        refundStatus,
      });
    }

    if (quoteModified) {
      const qRef =
        quoteDoc.ref ||
        (typeof jobRef.collection === "function"
          ? jobRef.collection("quotes").doc(quoteDoc.id)
          : db.collection(`jobs/${jobId}/quotes`).doc(quoteDoc.id));
      await qRef.update({
        milestones: updatedMilestones,
        escrowFrozen: true,
        updatedAt: nowIso,
      });
    }
  }

  // 2. Coordinate Active Mediation Stakes
  const dispute = jobData.dispute || {};
  const hasStakePaid = Boolean(
    jobData.mediationStakePaid === true ||
    dispute.mediationStakePaid === true ||
    dispute.stakePaid === true ||
    dispute.stakeStatus === "paid" ||
    dispute.stakePaymentStatus === "succeeded" ||
    dispute.stakePaymentId ||
    dispute.stakePaymentIntentId
  );
  const hasPendingStake = Boolean(dispute.stakePaymentAttemptId || dispute.status === "awaiting_payment");
  let mediationStakeRecoveryStatus: CancellationCoordinationResult["mediationStakeRecoveryStatus"] = "none";

  if (hasStakePaid || hasPendingStake) {
    mediationStakeRecoveryStatus = cancelledByHomeowner ? "forfeited_review" : "pending_review";
    const stakeDocId = `stake_cancel_${jobId}`;
    await db.collection("mediation_stake_recoveries").doc(stakeDocId).set(
      {
        id: stakeDocId,
        jobId,
        stakePaymentId: dispute.stakePaymentId || dispute.stakePaymentIntentId || null,
        paymentIntentId: dispute.paymentIntentId || dispute.stakePaymentIntentId || null,
        stakePaymentAttemptId: dispute.stakePaymentAttemptId || null,
        stakePaid: hasStakePaid,
        amount: Number(dispute.mediationStakeAmount || (hasStakePaid ? 25 : 0)),
        raisedBy: dispute.raisedBy || null,
        cancelledBy: actorUid,
        recoveryStatus: mediationStakeRecoveryStatus,
        cancellationReason,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      { merge: true }
    );
  }

  const escrowCancellationStatus: CancellationCoordinationResult["escrowCancellationStatus"] =
    frozenMilestonesCount === 0
      ? "none"
      : refundedMilestonesCount === frozenMilestonesCount
        ? "refunded"
        : needsReview
          ? (refundedMilestonesCount > 0 ? "partial_refund_review" : "manual_review")
          : "refund_pending";

  const jobPatch: Record<string, any> = {
    escrowCancellationStatus,
    frozenMilestonesCount,
    refundedMilestonesCount,
    mediationStakeRecoveryStatus,
    escrowStatus: frozenMilestonesCount > 0 ? (escrowCancellationStatus === "refunded" ? "refunded" : "frozen_on_cancel") : (jobData.escrowStatus || "none"),
    updatedAt: nowIso,
  };

  if (hasStakePaid || hasPendingStake) {
    jobPatch["dispute"] = {
      ...dispute,
      stakeRecoveryStatus: mediationStakeRecoveryStatus,
      cancelledWhileDisputedAt: nowIso,
    };
  }

  await jobRef.update(jobPatch);

  return {
    jobId,
    escrowCancellationStatus,
    frozenMilestonesCount,
    refundedMilestonesCount,
    mediationStakeRecoveryStatus,
  };
}
