/**
 * Financial Double-Entry Ledger & Idempotency Engine for AnyTrader V6
 * Enforces core invariants:
 * 1. "NO CLIENT-CONTROLLED VALUE MAY CAUSE ANYTRADER TO ACCEPT A PAYMENT AS VALID WITHOUT SERVER-SIDE VERIFICATION."
 * 2. "ONE FINANCIAL ACTION -> ONE FINANCIAL EFFECT."
 * 3. Atomic idempotency locks preventing duplicate releases, double payouts, and race conditions.
 */
import { BadRequestError, ConflictError, InternalServerError, ForbiddenError } from "./httpErrors.ts";
import { validatePaymentTransition, validateMilestoneTransition } from "./stateMachine.ts";
import { domainEvents } from "./domainEvents.ts";
import { BusinessLogicDefense } from "./businessLogicDefense.ts";
import { getDynamicFirestoreConfigs, resolveAnyTraderCommission } from "./pricingCatalog.ts";
import crypto from "crypto";

export interface LedgerEntry {
  entryId: string;
  transactionId: string;
  idempotencyKey: string;
  jobId?: string;
  quoteId?: string;
  milestoneId?: string;
  payerId: string;
  payeeId: string;
  amount: number; // in minor units (pence / cents)
  platformFee: number;
  netPayout: number;
  appliedCommissionRate?: number;
  commissionCapGbp?: number;
  currency: string;
  type: "ESCROW_DEPOSIT" | "ESCROW_RELEASE" | "PLATFORM_COMMISSION" | "REFUND" | "RIDE_PAYMENT";
  status: "pending" | "completed" | "reversed";
  createdAt: string;
}

export class PaymentLedgerEngine {
  /**
   * Idempotency Guard:
   * Checks if an idempotency key has already been executed.
   * If yes, returns the existing result to avoid duplicate execution.
   */
  public static async executeIdempotentOperation<T>(
    db: any,
    idempotencyKey: string,
    operationName: string,
    semanticBinding: Record<string, unknown>,
    executor: () => Promise<T>
  ): Promise<{ result: T; wasReplayed: boolean }> {
    if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      throw new BadRequestError("A valid, non-empty idempotencyKey is required for financial operations.");
    }
    // Idempotency keys may originate in request headers or bodies. Keep them
    // as single Firestore document IDs; never let a slash create a nested path.
    if (idempotencyKey.includes("/") || idempotencyKey.length > 200) {
      throw new BadRequestError("Idempotency key must be at most 200 characters and cannot contain '/'.");
    }
    if (!semanticBinding || typeof semanticBinding !== "object" || Array.isArray(semanticBinding)) {
      throw new BadRequestError("A semantic binding is required for financial idempotency.");
    }
    const canonicalize = (value: any): any => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value && typeof value === "object") {
        return Object.keys(value).sort().reduce((result: any, key) => {
          result[key] = canonicalize(value[key]);
          return result;
        }, {});
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new BadRequestError("Semantic binding contains a non-finite number.");
      }
      if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
        throw new BadRequestError("Semantic binding contains an unsupported value.");
      }
      return value;
    };
    const bindingJson = JSON.stringify(canonicalize(semanticBinding));
    if (!bindingJson) throw new BadRequestError("Semantic binding could not be serialized.");
    const bindingHash = crypto.createHash("sha256").update(bindingJson).digest("hex");

    if (!db) {
      // In development fallback without db, run executor directly
      const result = await executor();
      return { result, wasReplayed: false };
    }

    const idempotencyRef = db.collection("payment_idempotency").doc(idempotencyKey);
    
    // A unique generation fences stale executors after lease takeover.
    const claimToken = crypto.randomUUID();
    const claimResult = await db.runTransaction(async (transaction: any) => {
      const doc = await transaction.get(idempotencyRef);
      if (doc.exists) {
        const data = doc.data();
        if (data.operationName !== operationName) {
          throw new ConflictError("Idempotency key is already bound to a different financial operation.");
        }
        if (typeof data.bindingHash !== "string" || data.bindingHash !== bindingHash) {
          throw new ConflictError("Idempotency key is already bound to different transaction details or requires reconciliation.");
        }
        if (data.status === "completed") {
          return { shouldExecute: false, result: data.response as T, wasReplayed: true };
        }
        // Reconciliation-required is a durable stop state. Never let a later
        // retry silently replace it with a fresh claim and repeat a possible
        // external financial effect.
        if (data.status === "reconciliation_required") {
          throw new ConflictError("Financial operation requires reconciliation; automatic replay remains blocked.");
        }
        if (data.status !== "in_progress") {
          throw new ConflictError("Existing financial operation has an unknown state and requires reconciliation.");
        }
        if (data.status === "in_progress") {
          const startedAt = data.startedAt ? new Date(data.startedAt).getTime() : Date.now();
          const ageMs = Date.now() - startedAt;
          if (ageMs < 5 * 60 * 1000) {
            throw new ConflictError("A concurrent request with the same idempotency key is already processing.");
          }
          // Timeout is not proof an external financial effect did not happen.
          // Persist reconciliation state and never replace the claim automatically.
          transaction.update(idempotencyRef, {
            status: "reconciliation_required",
            reconciliationRequiredAt: new Date().toISOString(),
            reconciliationReason: "Expired in-progress claim may have completed an external effect",
          });
          return { shouldExecute: false, reconciliationRequired: true };
        }
      }
      transaction.set(idempotencyRef, {
        operationName, bindingHash, status: "in_progress", startedAt: new Date().toISOString(), claimToken,
      });
      return { shouldExecute: true };
    });

    if (claimResult.reconciliationRequired) {
      throw new ConflictError("Expired financial operation requires reconciliation; automatic replay is blocked.");
    }
    if (!claimResult.shouldExecute) {
      return { result: claimResult.result as T, wasReplayed: true };
    }

    try {
      const result = await executor();
      const sanitizedResponse = result !== undefined ? JSON.parse(JSON.stringify(result)) : null;
      // Completion is fenced: an expired executor cannot complete a successor's claim.
      await db.runTransaction(async (transaction: any) => {
        const fresh = await transaction.get(idempotencyRef);
        if (!fresh.exists || fresh.data()?.claimToken !== claimToken || fresh.data()?.operationName !== operationName) {
          throw new ConflictError("Idempotency claim was superseded; executor result requires reconciliation.");
        }
        transaction.update(idempotencyRef, {
          status: "completed", completedAt: new Date().toISOString(), response: sanitizedResponse,
        });
      });
      return { result, wasReplayed: false };
    } catch (err) {
      // Only the current generation may release/fail its own lock.
      try {
        await db.runTransaction(async (transaction: any) => {
          const fresh = await transaction.get(idempotencyRef);
          if (fresh.exists && fresh.data()?.claimToken === claimToken) {
            transaction.delete(idempotencyRef);
          }
        });
      } catch (cleanupErr: any) {
        console.error("Failed to conditionally release idempotency claim:", cleanupErr);
      }
      throw err;
    }
  }

  /**
   * Record Escrow Funding:
   * Called strictly upon verified server-side Stripe webhook or payment intent confirmation.
   * Client-supplied price/amount is strictly rejected; amount must match the verified Stripe event.
   */
  public static async recordEscrowFunding(
    db: any,
    params: {
      jobId: string;
      milestoneId: string;
      customerId: string;
      traderId: string;
      verifiedAmount: number; // in pence
      currency: string;
      paymentIntentId: string;
      idempotencyKey: string;
      platformFeePence?: number;
      appliedCommissionRate?: number;
      commissionCapGbp?: number;
      traderTier?: string;
    }
  ): Promise<LedgerEntry> {
    const {
      jobId,
      milestoneId,
      customerId,
      traderId,
      verifiedAmount,
      currency,
      paymentIntentId,
      idempotencyKey,
    } = params;

    if (typeof verifiedAmount !== "number" || !Number.isFinite(verifiedAmount) || verifiedAmount <= 0) {
      throw new BadRequestError("Verified amount must be a strictly positive finite number in minor units (pence).");
    }

    const normalizedCustomerId = typeof customerId === "string" ? customerId.trim() : "";
    const normalizedTraderId = typeof traderId === "string" ? traderId.trim() : "";
    if (normalizedCustomerId && normalizedTraderId && normalizedCustomerId === normalizedTraderId) {
      throw new ForbiddenError("Self-payment is prohibited: payer and payee accounts must be distinct.");
    }

    const { result } = await this.executeIdempotentOperation(db, idempotencyKey, "FUND_MILESTONE_ESCROW", {
      version: 1, jobId, milestoneId, customerId, traderId,
      verifiedAmount, currency: currency.toLowerCase(), paymentIntentId,
    }, async () => {
      const hasAuthoritativeFee =
        typeof params.platformFeePence === "number" &&
        Number.isFinite(params.platformFeePence) &&
        params.platformFeePence >= 0 &&
        params.platformFeePence <= verifiedAmount;

      let platformFee: number;
      let netPayout: number;
      let appliedCommissionRate: number | undefined = params.appliedCommissionRate;
      let commissionCapGbp: number | undefined = params.commissionCapGbp;

      if (hasAuthoritativeFee) {
        platformFee = Math.round(params.platformFeePence!);
        netPayout = verifiedAmount - platformFee;
      } else {
        const resolved = await resolveAnyTraderCommission({
          amountPence: verifiedAmount,
          firestoreDb: db,
          traderId,
          traderTier: params.traderTier,
          explicitCommissionRate: params.appliedCommissionRate,
          explicitCapGbp: params.commissionCapGbp,
        });
        platformFee = resolved.platformFeePence;
        netPayout = resolved.netPayoutPence;
        appliedCommissionRate = resolved.commissionRate;
        commissionCapGbp = resolved.commissionCapGbp;
      }

      const entryHash = crypto.createHash("sha256").update(`${idempotencyKey}:${paymentIntentId}`).digest("hex").substring(0, 16);
      const entryId = `ledg_fund_${entryHash}`;
      const ledgerEntry: LedgerEntry = {
        entryId,
        transactionId: paymentIntentId,
        idempotencyKey,
        jobId,
        milestoneId,
        payerId: customerId,
        payeeId: traderId,
        amount: verifiedAmount,
        platformFee,
        netPayout,
        ...(appliedCommissionRate !== undefined ? { appliedCommissionRate } : {}),
        ...(commissionCapGbp !== undefined ? { commissionCapGbp } : {}),
        currency: currency.toLowerCase(),
        type: "ESCROW_DEPOSIT",
        status: "completed",
        createdAt: new Date().toISOString(),
      };

      if (db) {
        const milestoneRef = db.collection("jobs").doc(jobId).collection("milestones").doc(milestoneId);
        const milestoneDoc = await milestoneRef.get();
        if (milestoneDoc.exists) {
          const currentStatus = milestoneDoc.data()?.status || "pending";
          validateMilestoneTransition(currentStatus, "funded");
          await milestoneRef.update({
            status: "funded",
            fundedAt: new Date().toISOString(),
            escrowEntryId: entryId,
            verifiedAmount,
            platformFee,
            platformFeePence: platformFee,
            netPayout,
            netPayoutPence: netPayout,
            ...(appliedCommissionRate !== undefined ? { appliedCommissionRate } : {}),
            ...(commissionCapGbp !== undefined ? { commissionCapGbp } : {}),
          });
        }

        await db.collection("payment_ledger").doc(entryId).set(ledgerEntry);
      }

      await domainEvents.dispatch("MILESTONE_FUNDED", milestoneId, customerId, {
        jobId,
        amount: verifiedAmount,
        currency,
      }, idempotencyKey, db);

      return ledgerEntry;
    });

    return result;
  }

  /**
   * Record Escrow Release to Tradesperson:
   * Single canonical authority for milestone fund release.
   * Transactionally protects Job, Quote, and Milestone state.
   */
  /**
   * Durable per-job/per-user QR PIN throttle. Failed attempts commit in their
   * own transaction before rejection, so the counter survives thrown errors.
   */
  public static async validateAndRecordQrHandshakeAttempt(
    db: any,
    params: { jobId: string; authUid: string; handshakeCode?: string }
  ): Promise<void> {
    const { jobId, authUid, handshakeCode } = params;
    if (!db || !jobId || !authUid) throw new BadRequestError("Job and authenticated user are required");
    const jobRef = db.collection("jobs").doc(jobId);
    const attemptRef = jobRef.collection("handshake_attempts").doc(authUid);
    const arrivalPinRef = db.collection("job_arrival_pins").doc(jobId);
    const now = Date.now();
    const outcome = await db.runTransaction(async (tx: any) => {
      const [jobSnap, attemptSnap, arrivalPinSnap] = await Promise.all([
        tx.get(jobRef),
        tx.get(attemptRef),
        tx.get(arrivalPinRef),
      ]);
      if (!jobSnap.exists) return "invalid";
      const job = jobSnap.data() || {};
      const pinData = arrivalPinSnap?.exists
        ? (typeof arrivalPinSnap.data === "function" ? arrivalPinSnap.data() : arrivalPinSnap.data)
        : null;
      const attempt = attemptSnap.exists ? attemptSnap.data() || {} : {};
      if (Number(attempt.lockedUntilMs || 0) > now) return "locked";
      const acceptedTrader = [job.acceptedTradespersonId, job.acceptedTraderId, job.tradespersonId]
        .some((id) => typeof id === "string" && id === authUid);
      const expected = String(pinData?.verificationPin || job.handshakeCode || job.verificationPin || "").trim();
      const supplied = String(handshakeCode || "").trim();
      if (acceptedTrader && expected !== "" && supplied !== "" && expected === supplied) {
        tx.set(attemptRef, { attempts: 0, windowStartedAtMs: now, lockedUntilMs: 0, lastSuccessAtMs: now });
        return "valid";
      }
      const windowStarted = Number(attempt.windowStartedAtMs || 0);
      const activeWindow = windowStarted > 0 && now - windowStarted < 15 * 60 * 1000;
      const attempts = (activeWindow ? Number(attempt.attempts || 0) : 0) + 1;
      const locked = attempts >= 5;
      tx.set(attemptRef, {
        attempts,
        windowStartedAtMs: activeWindow ? windowStarted : now,
        lockedUntilMs: locked ? now + 15 * 60 * 1000 : 0,
        lastFailedAtMs: now,
      });
      return locked ? "locked" : "invalid";
    });
    if (outcome !== "valid") {
      throw new ForbiddenError(outcome === "locked"
        ? "QR verification is temporarily locked. Please wait 15 minutes or contact support."
        : "Invalid QR handshake code.");
    }
  }

  public static async releaseEscrowFunds(
    db: any,
    params: {
      jobId: string;
      quoteId: string;
      milestoneId: string;
      authUid: string;
      idempotencyKey: string;
      isQrHandshake?: boolean;
      handshakeCode?: string;
      isAdmin?: boolean;
    }
  ): Promise<any> {
    const { jobId, quoteId, milestoneId, authUid, idempotencyKey, isQrHandshake, handshakeCode, isAdmin } = params;

    if (!authUid || typeof authUid !== "string" || authUid.trim() === "") {
      throw new ForbiddenError("Unauthorized: authentic caller identity required");
    }

    if (!jobId || typeof jobId !== "string" || !quoteId || typeof quoteId !== "string") {
      throw new BadRequestError("jobId and quoteId must be valid strings");
    }
    if (!db) {
      throw new InternalServerError("Database is required for financial escrow release.");
    }

    // Revalidate current authorization before idempotency replay can return a cached
    // result. The transaction below repeats these checks against its own snapshot
    // before any new release transition is committed.
    const [authorizationJobSnap, authorizationPinSnap] = await Promise.all([
      db.collection("jobs").doc(jobId).get(),
      db.collection("job_arrival_pins").doc(jobId).get(),
    ]);
    if (!authorizationJobSnap.exists) throw new BadRequestError("Job not found");
    const authorizationJob = authorizationJobSnap.data();
    const authorizationPinData = authorizationPinSnap?.exists
      ? (typeof authorizationPinSnap.data === "function" ? authorizationPinSnap.data() : authorizationPinSnap.data)
      : null;
    const currentlyOwner = Boolean(
      (authorizationJob?.homeownerId && authorizationJob.homeownerId === authUid) ||
      (authorizationJob?.userId && authorizationJob.userId === authUid) ||
      (authorizationJob?.customerId && authorizationJob.customerId === authUid)
    );
    const currentlyAcceptedTrader = Boolean(
      (authorizationJob?.acceptedTradespersonId && authorizationJob.acceptedTradespersonId === authUid) ||
      (authorizationJob?.acceptedTraderId && authorizationJob.acceptedTraderId === authUid) ||
      (authorizationJob?.tradespersonId && authorizationJob.tradespersonId === authUid)
    );
    const expectedHandshakeCode = (
      authorizationPinData?.verificationPin ||
      authorizationJob?.handshakeCode ||
      authorizationJob?.verificationPin ||
      ""
    ).toString().trim();
    const suppliedHandshakeCode = (handshakeCode || "").toString().trim();
    const currentlyValidHandshake = Boolean(
      currentlyAcceptedTrader && isQrHandshake && expectedHandshakeCode !== "" &&
      suppliedHandshakeCode !== "" && expectedHandshakeCode === suppliedHandshakeCode
    );
    if (!currentlyOwner && !isAdmin && !currentlyValidHandshake) {
      throw new ForbiddenError("Unauthorized: current caller is not permitted to release milestone funds");
    }

    const authJobOwnerUids = [
      authorizationJob?.homeownerId,
      authorizationJob?.userId,
      authorizationJob?.customerId,
    ]
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .map((value) => value.trim());
    const authJobTraderUids = [
      authorizationJob?.acceptedTradespersonId,
      authorizationJob?.acceptedTraderId,
      authorizationJob?.tradespersonId,
    ]
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .map((value) => value.trim());
    if (authJobOwnerUids.some((ownerUid) => authJobTraderUids.includes(ownerUid))) {
      throw new ForbiddenError(
        "Self-payment is prohibited: escrow funds cannot be released when the job owner and tradesperson are the same account."
      );
    }

    const { result } = await this.executeIdempotentOperation(db, idempotencyKey, "RELEASE_MILESTONE", {
      version: 1, jobId, quoteId, milestoneId: milestoneId || null, authUid,
      authorizationMode: isAdmin ? "admin" : isQrHandshake ? "qr_handshake" : "owner",
    }, async () => {
      if (!db) {
        throw new InternalServerError("Database is required for financial escrow release.");
      }

      // Load dynamic Admin pricing/commission configs before entering the Firestore transaction
      // so commission calculations stay strictly in sync with Admin controls & Stripe Checkout.
      const { globalTiers, globalConfig } = await getDynamicFirestoreConfigs(db);

      // Execute everything inside a single Firestore transaction for atomic safety
      const transactionResult = await db.runTransaction(async (transaction: any) => {
        const jobRef = db.collection("jobs").doc(jobId);
        const arrivalPinRef = db.collection("job_arrival_pins").doc(jobId);
        const [jobDoc, arrivalPinDoc] = await Promise.all([
          transaction.get(jobRef),
          transaction.get(arrivalPinRef),
        ]);
        if (!jobDoc.exists) throw new BadRequestError("Job not found");

        const jobData = jobDoc.data();
        const arrivalPinData = arrivalPinDoc?.exists
          ? (typeof arrivalPinDoc.data === "function" ? arrivalPinDoc.data() : arrivalPinDoc.data)
          : null;
        if (jobData?.chargebackFreeze === true || jobData?.payoutFrozen === true || jobData?.escrowFrozen === true) {
          throw new ConflictError("Escrow release blocked: funds are frozen under active chargeback or cancellation review.");
        }

        const isOwner = Boolean(
          authUid && (
            (jobData?.homeownerId && jobData.homeownerId === authUid) ||
            (jobData?.userId && jobData.userId === authUid) ||
            (jobData?.customerId && jobData.customerId === authUid)
          )
        );
        const isAcceptedTrader = Boolean(
          authUid && (
            (jobData?.acceptedTradespersonId && jobData.acceptedTradespersonId === authUid) ||
            (jobData?.acceptedTraderId && jobData.acceptedTraderId === authUid) ||
            (jobData?.tradespersonId && jobData.tradespersonId === authUid)
          )
        );

        // Curing Escrow Self-Release:
        // Under no circumstances can a tradesperson self-release escrow funds simply by passing isQrHandshake: true!
        // An accepted tradesperson can only release if they supply the homeowner's secret handshake code / PIN.
        let hasValidHandshakeAuth = false;
        if (isAcceptedTrader && isQrHandshake) {
          const expectedCode = (
            arrivalPinData?.verificationPin ||
            jobData?.handshakeCode ||
            jobData?.verificationPin ||
            ""
          ).toString().trim();
          const suppliedCode = (handshakeCode || "").toString().trim();
          if (expectedCode !== "" && suppliedCode !== "" && expectedCode === suppliedCode) {
            hasValidHandshakeAuth = true;
          }
        }

        if (!isOwner && !isAdmin && !hasValidHandshakeAuth) {
          throw new ForbiddenError("Unauthorized: only the job owner or authorized admin can release milestone funds");
        }

        const quoteRef = jobRef.collection("quotes").doc(quoteId);
        const quoteDoc = await transaction.get(quoteRef);
        if (!quoteDoc.exists) throw new BadRequestError("Quote not found");

        const quoteData = quoteDoc.data();

        // Canonical IDOR / BOLA & Accepted Binding validation (AT-PAY-14):
        if (quoteData?.jobId && quoteData.jobId !== jobId) {
          throw new BadRequestError("IDOR rejection: Quote does not belong to the specified job");
        }
        if (!jobData?.acceptedQuoteId || jobData.acceptedQuoteId !== quoteId) {
          throw new BadRequestError(
            jobData?.acceptedQuoteId
              ? `Cannot release funds for quote '${quoteId}': Job has accepted quote '${jobData.acceptedQuoteId}'`
              : `Cannot release funds for quote '${quoteId}': Job does not have an accepted quote binding`
          );
        }
        if (quoteData?.status !== "accepted") {
          throw new BadRequestError(
            `Cannot release funds for quote '${quoteId}': Quote status is '${quoteData?.status || "unknown"}' and must be 'accepted'`
          );
        }
        if (jobData?.acceptedTradespersonId && quoteData?.tradespersonId && jobData.acceptedTradespersonId !== quoteData.tradespersonId) {
          throw new BadRequestError("IDOR rejection: Quote tradesperson does not match job accepted tradesperson");
        }

        const txJobOwnerUids = [jobData?.homeownerId, jobData?.userId, jobData?.customerId]
          .filter((value): value is string => typeof value === "string" && value.trim() !== "")
          .map((value) => value.trim());
        const txTraderUids = [
          jobData?.acceptedTradespersonId,
          jobData?.acceptedTraderId,
          jobData?.tradespersonId,
          quoteData?.tradespersonId,
        ]
          .filter((value): value is string => typeof value === "string" && value.trim() !== "")
          .map((value) => value.trim());
        if (txJobOwnerUids.some((ownerUid) => txTraderUids.includes(ownerUid))) {
          throw new ForbiddenError(
            "Self-payment is prohibited: escrow funds cannot be released when the job owner and tradesperson are the same account."
          );
        }

        const currentMilestones = quoteData?.milestones || [];
        const targetMilestone = milestoneId
          ? currentMilestones.find((m: any) => m.id === milestoneId)
          : (isQrHandshake ? currentMilestones[0] : null);

        if (!targetMilestone) {
          throw new BadRequestError(`Milestone not found: '${milestoneId || "initial"}' does not exist on quote '${quoteId}'`);
        }

        // Read tradesperson profile inside transaction before any writes (needed for tier commission + prod Stripe gate)
        const traderId = quoteData?.tradespersonId || jobData?.acceptedTradespersonId;
        let traderData: Record<string, any> | null = null;
        if (traderId) {
          const traderRef = db.collection("users").doc(traderId);
          const traderDoc = await transaction.get(traderRef);
          traderData = traderDoc?.exists
            ? (typeof traderDoc.data === "function" ? traderDoc.data() : traderDoc.data) || null
            : null;
        }

        // Production Pre-Commit Fail-Closed Gate:
        // Prevent committing release to Firestore if tradesperson cannot receive funds via Stripe
        const isProd = process.env.NODE_ENV === "production";
        if (isProd && !targetMilestone.isDestinationCharge) {
          if (!traderId) {
            throw new BadRequestError("Tradesperson ID missing on quote and job");
          }
          const traderStripeAccountId = traderData?.stripeAccountId;
          if (!traderStripeAccountId) {
            throw new BadRequestError("Tradesperson has no connected Stripe payout account");
          }
          if (traderStripeAccountId.startsWith("acct_mock_")) {
            throw new BadRequestError("Mock Stripe account is rejected in production");
          }
        }

        const computeReleaseAmounts = async (amountGbp: number) => {
          const amountPence = Math.round(amountGbp * 100);
          // 1. Honor exact persisted fee from milestone funding (zero drift with Stripe destination charge)
          if (
            typeof targetMilestone.platformFeePence === "number" &&
            Number.isFinite(targetMilestone.platformFeePence) &&
            targetMilestone.platformFeePence >= 0 &&
            targetMilestone.platformFeePence <= amountPence
          ) {
            const platformFeePence = Math.round(targetMilestone.platformFeePence);
            return {
              amountPence,
              platformFeePence,
              netPayoutPence: amountPence - platformFeePence,
              appliedCommissionRate:
                typeof targetMilestone.appliedCommissionRate === "number"
                  ? targetMilestone.appliedCommissionRate
                  : undefined,
              commissionCapGbp:
                typeof targetMilestone.commissionCapGbp === "number"
                  ? targetMilestone.commissionCapGbp
                  : undefined,
            };
          }

          // 2. Otherwise resolve dynamically via canonical AnyTrader commission resolver
          const resolved = await resolveAnyTraderCommission({
            amountPence,
            traderData: traderData || {},
            globalTiers,
            globalConfig,
            explicitCommissionRate:
              typeof targetMilestone.appliedCommissionRate === "number"
                ? targetMilestone.appliedCommissionRate
                : typeof quoteData?.appliedCommissionRate === "number"
                  ? quoteData.appliedCommissionRate
                  : undefined,
            explicitCapGbp:
              typeof targetMilestone.commissionCapGbp === "number"
                ? targetMilestone.commissionCapGbp
                : typeof quoteData?.commissionCapGbp === "number"
                  ? quoteData.commissionCapGbp
                  : undefined,
          });
          return {
            amountPence,
            platformFeePence: resolved.platformFeePence,
            netPayoutPence: resolved.netPayoutPence,
            appliedCommissionRate: resolved.commissionRate,
            commissionCapGbp: resolved.commissionCapGbp,
          };
        };

        // Transactional Claim Validation
        // If it's already released with the SAME idempotency key, authoritative state confirms this release was already committed!
        if (
          (targetMilestone.status === "released" || targetMilestone.status === "funds_released" || targetMilestone.releasedAt) &&
          targetMilestone.releaseOperationId === idempotencyKey
        ) {
          const releasedAmount = Number(targetMilestone.amount || targetMilestone.verifiedAmount || 0);
          const { platformFeePence, netPayoutPence } = await computeReleaseAmounts(releasedAmount);
          const ledgerEntryId = targetMilestone.escrowReleaseLedgerId || `ledg_rel_${crypto.createHash("sha256").update(idempotencyKey).digest("hex").substring(0, 16)}`;
          return {
            jobData,
            quoteData,
            releasedAmount,
            targetMilestoneTitle: targetMilestone.title || "Work Stage",
            platformFeePence,
            netPayoutPence,
            ledgerEntryId,
            targetMilestone,
            wasAlreadyCommitted: true
          };
        }

        if ((targetMilestone.status === "released" || targetMilestone.status === "funds_released" || targetMilestone.releasedAt) && targetMilestone.releaseOperationId !== idempotencyKey) {
          throw new ConflictError("Milestone has already been released by another request");
        }

        if (targetMilestone.releaseOperationId && targetMilestone.releaseOperationId !== idempotencyKey) {
          throw new ConflictError("Milestone release is already being processed by another request");
        }

        // Business Logic sequence check
        BusinessLogicDefense.validateEscrowReleaseEligibility(targetMilestone, jobData as any);

        const releasedAmount = Number(targetMilestone.amount || targetMilestone.verifiedAmount || 0);
        if (typeof releasedAmount !== "number" || !Number.isFinite(releasedAmount) || releasedAmount <= 0) {
          throw new BadRequestError(`Invalid milestone amount in database: '${releasedAmount}'. Must be a positive finite number.`);
        }

        const {
          amountPence,
          platformFeePence,
          netPayoutPence,
          appliedCommissionRate,
          commissionCapGbp,
        } = await computeReleaseAmounts(releasedAmount);
        const ledgerHash = crypto.createHash("sha256").update(`${idempotencyKey}:${jobId}:${quoteId}:${targetMilestone.id}`).digest("hex").substring(0, 16);
        const ledgerEntryId = `ledg_rel_${ledgerHash}`;

        let targetMilestoneTitle = targetMilestone.title || "Work Stage";

        const updatedMilestones = currentMilestones.map((m: any, idx: number) => {
          if (m.id === targetMilestone.id) {
            // Validation of state jump
            validateMilestoneTransition(m.status || 'funded', 'released');
            targetMilestoneTitle = m.title || "Work Stage";
            return { 
              ...m, 
              status: 'funds_released', 
              releasedAt: new Date().toISOString(), 
              releaseOperationId: idempotencyKey,
              escrowReleaseLedgerId: ledgerEntryId,
              platformFeePence,
              netPayoutPence,
              ...(appliedCommissionRate !== undefined ? { appliedCommissionRate } : {}),
              ...(commissionCapGbp !== undefined ? { commissionCapGbp } : {}),
            };
          }
          return m;
        });

        const quoteUpdatePayload: any = {
          milestones: updatedMilestones,
          updatedAt: new Date().toISOString()
        };

        if (isQrHandshake) {
          // QR handshake is an authorization method for this milestone only. It is not
          // proof that every milestone (or the whole job) has been paid. Keep the
          // guarantee metadata on the quote, but leave job/quote aggregate payment
          // projections to the canonical settlement reconciler.
          const guaranteeExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
          quoteUpdatePayload.guaranteeExpiresAt = guaranteeExpiry.toISOString();
        }

        transaction.update(quoteRef, quoteUpdatePayload);

        const releaseEntry: LedgerEntry = {
          entryId: ledgerEntryId,
          transactionId: targetMilestone.stripePaymentIntentId || targetMilestone.escrowEntryId || `rel_${jobId}_${quoteId}`,
          idempotencyKey,
          jobId,
          quoteId,
          milestoneId: targetMilestone.id,
          payerId: jobData?.homeownerId || authUid,
          payeeId: quoteData?.tradespersonId || "trader",
          amount: amountPence,
          platformFee: platformFeePence,
          netPayout: netPayoutPence,
          ...(appliedCommissionRate !== undefined ? { appliedCommissionRate } : {}),
          ...(commissionCapGbp !== undefined ? { commissionCapGbp } : {}),
          currency: "gbp",
          type: "ESCROW_RELEASE",
          status: "completed",
          createdAt: new Date().toISOString()
        };

        // Write ledger entry INSIDE the transaction for atomicity
        transaction.set(db.collection("payment_ledger").doc(ledgerEntryId), releaseEntry);

        return {
          jobData,
          quoteData,
          releasedAmount,
          targetMilestoneTitle,
          platformFeePence,
          netPayoutPence,
          ledgerEntryId,
          targetMilestone,
          releaseEntry,
          wasAlreadyCommitted: false
        };
      });

      const {
        jobData,
        quoteData,
        releasedAmount,
        targetMilestoneTitle,
        platformFeePence,
        netPayoutPence,
        ledgerEntryId,
        targetMilestone,
        wasAlreadyCommitted
      } = transactionResult;

      // Dispatch domain event only on initial commit, not on crash recovery re-evaluation
      if (!wasAlreadyCommitted) {
        await domainEvents.dispatch("MILESTONE_RELEASED", milestoneId || targetMilestone?.id || "m0", authUid, {
          jobId,
          quoteId,
          releasedAmount,
          isQrHandshake: Boolean(isQrHandshake)
        }, idempotencyKey, db);
      }

      return {
        success: true,
        jobId,
        quoteId,
        milestoneId,
        releasedAmount,
        netPayoutPence,
        platformFeePence,
        targetMilestoneTitle,
        traderId: quoteData?.tradespersonId,
        stripePaymentIntentId: targetMilestone.stripePaymentIntentId,
        isDestinationCharge: targetMilestone.isDestinationCharge,
        jobNo: jobData?.jobNo,
        ledgerEntryId
      };
    });

    return result;
  }

  /**
   * Submits completed milestone deliverables for homeowner review & approval (AT-CJ-MILESTONE-01).
   * Transitions funded -> in_progress -> submitted (or updates an in_progress/submitted deliverable).
   */
  public static async submitMilestoneWork(
    db: any,
    params: {
      jobId: string;
      quoteId: string;
      milestoneId: string;
      authUid: string;
      deliverableNotes: string;
      deliverablePhotos?: string[];
    }
  ): Promise<{ success: boolean; jobId: string; quoteId: string; milestoneId: string; status: string; milestone: any }> {
    const { jobId, quoteId, milestoneId, authUid, deliverableNotes, deliverablePhotos = [] } = params;
    if (!db) throw new InternalServerError("Database is required for milestone deliverable submission.");
    if (!authUid) throw new ForbiddenError("Authentication required.");
    if (!jobId || !quoteId || !milestoneId) {
      throw new BadRequestError("jobId, quoteId, and milestoneId are required.");
    }
    const trimmedNotes = String(deliverableNotes || "").trim();
    if (trimmedNotes.length < 3) {
      throw new BadRequestError("Please provide work summary notes (at least 3 characters) for your deliverable submission.");
    }

    const nowIso = new Date().toISOString();
    const txOut = await db.runTransaction(async (transaction: any) => {
      const jobRef = db.collection("jobs").doc(jobId);
      const quoteRef = jobRef.collection("quotes").doc(quoteId);
      const [jobDoc, quoteDoc] = await Promise.all([
        transaction.get(jobRef),
        transaction.get(quoteRef),
      ]);
      if (!jobDoc.exists) throw new BadRequestError("Job not found.");
      if (!quoteDoc.exists) throw new BadRequestError("Quote not found.");

      const jobData = jobDoc.data() || {};
      const quoteData = quoteDoc.data() || {};

      if (quoteData.jobId && quoteData.jobId !== jobId) {
        throw new ForbiddenError("Quote does not belong to the specified job.");
      }
      if (jobData.acceptedQuoteId !== quoteId || quoteData.status !== "accepted") {
        throw new ConflictError("Milestone deliverables can only be submitted on the accepted quote.");
      }

      const assignedTrader =
        jobData.acceptedTradespersonId ||
        jobData.acceptedTraderId ||
        quoteData.tradespersonId ||
        quoteData.traderId;
      if (!assignedTrader || assignedTrader !== authUid) {
        throw new ForbiddenError("Only the assigned tradesperson can submit deliverables for this milestone.");
      }

      const currentMilestones = Array.isArray(quoteData.milestones) ? quoteData.milestones : [];
      const targetMilestone = currentMilestones.find((m: any) => m.id === milestoneId);
      if (!targetMilestone) {
        throw new BadRequestError(`Milestone '${milestoneId}' not found on quote '${quoteId}'.`);
      }

      const currentStatus = String(targetMilestone.status || "pending");
      if (["released", "funds_released", "refunded", "disputed"].includes(currentStatus)) {
        throw new ConflictError(`Cannot submit work for milestone in '${currentStatus}' state.`);
      }
      if (currentStatus === "pending" || currentStatus === "pending_funding") {
        throw new ConflictError("Escrow funding is required before submitting deliverables for this milestone.");
      }

      if (currentStatus === "funded") {
        validateMilestoneTransition("funded", "in_progress");
        validateMilestoneTransition("in_progress", "submitted");
      } else if (currentStatus === "in_progress") {
        validateMilestoneTransition("in_progress", "submitted");
      } else if (currentStatus === "approved") {
        throw new ConflictError("Milestone deliverables have already been approved by the homeowner.");
      }

      const sanitizedPhotos = Array.isArray(deliverablePhotos)
        ? deliverablePhotos.filter((p) => typeof p === "string" && p.trim().length > 0).slice(0, 10)
        : [];
      const nextSubmissionCount = Number(targetMilestone.submissionCount || 0) + 1;
      let updatedTarget: any = null;

      const updatedMilestones = currentMilestones.map((m: any) => {
        if (m.id !== milestoneId) return m;
        updatedTarget = {
          ...m,
          status: "submitted",
          deliverableNotes: trimmedNotes.slice(0, 2000),
          deliverablePhotos: sanitizedPhotos,
          submittedAt: nowIso,
          submittedBy: authUid,
          submissionCount: nextSubmissionCount,
          updatedAt: nowIso,
        };
        return updatedTarget;
      });

      transaction.update(quoteRef, {
        milestones: updatedMilestones,
        updatedAt: nowIso,
      });

      const homeownerId = jobData.homeownerId || jobData.userId || jobData.ownerId;
      if (homeownerId) {
        transaction.set(
          db.collection("notifications").doc(`ms_submit_${jobId}_${milestoneId}_${nextSubmissionCount}`),
          {
            userId: homeownerId,
            title: "Milestone Deliverable Submitted",
            message: `Tradesperson submitted work for "${targetMilestone.title || "Milestone"}". Please review to approve or request a revision.`,
            type: "status",
            read: false,
            jobId,
            quoteId,
            milestoneId,
            link: `/job/${jobId}`,
            createdAt: nowIso,
          }
        );
      }

      return { updatedTarget };
    });

    await domainEvents.dispatch(
      "MILESTONE_SUBMITTED",
      milestoneId,
      authUid,
      { jobId, quoteId, milestoneId },
      `ms_submit_${jobId}_${milestoneId}_${txOut.updatedTarget?.submissionCount || 1}`,
      db
    );

    return {
      success: true,
      jobId,
      quoteId,
      milestoneId,
      status: "submitted",
      milestone: txOut.updatedTarget,
    };
  }

  /**
   * Homeowner review decision for a submitted milestone deliverable (AT-CJ-MILESTONE-01).
   * Supports approving deliverables (unlocked for payout release) or requesting revision (submitted -> in_progress).
   */
  public static async reviewMilestoneWork(
    db: any,
    params: {
      jobId: string;
      quoteId: string;
      milestoneId: string;
      authUid: string;
      decision: "approve" | "request_revision";
      revisionReason?: string;
      isAdmin?: boolean;
    }
  ): Promise<{ success: boolean; jobId: string; quoteId: string; milestoneId: string; status: string; milestone: any }> {
    const { jobId, quoteId, milestoneId, authUid, decision, revisionReason, isAdmin } = params;
    if (!db) throw new InternalServerError("Database is required for milestone review.");
    if (!authUid) throw new ForbiddenError("Authentication required.");
    if (!jobId || !quoteId || !milestoneId) {
      throw new BadRequestError("jobId, quoteId, and milestoneId are required.");
    }
    if (decision !== "approve" && decision !== "request_revision") {
      throw new BadRequestError("decision must be 'approve' or 'request_revision'.");
    }
    const cleanReason = String(revisionReason || "").trim();
    if (decision === "request_revision" && cleanReason.length < 3) {
      throw new BadRequestError("Please provide a revision reason when requesting changes.");
    }

    const nowIso = new Date().toISOString();
    const txOut = await db.runTransaction(async (transaction: any) => {
      const jobRef = db.collection("jobs").doc(jobId);
      const quoteRef = jobRef.collection("quotes").doc(quoteId);
      const [jobDoc, quoteDoc] = await Promise.all([
        transaction.get(jobRef),
        transaction.get(quoteRef),
      ]);
      if (!jobDoc.exists) throw new BadRequestError("Job not found.");
      if (!quoteDoc.exists) throw new BadRequestError("Quote not found.");

      const jobData = jobDoc.data() || {};
      const quoteData = quoteDoc.data() || {};

      if (quoteData.jobId && quoteData.jobId !== jobId) {
        throw new ForbiddenError("Quote does not belong to the specified job.");
      }
      if (jobData.acceptedQuoteId !== quoteId || quoteData.status !== "accepted") {
        throw new ConflictError("Milestone deliverables can only be reviewed on the accepted quote.");
      }

      const ownerId = jobData.homeownerId || jobData.userId || jobData.ownerId;
      if (!isAdmin && (!ownerId || ownerId !== authUid)) {
        throw new ForbiddenError("Only the job homeowner or an admin can review milestone deliverables.");
      }

      const currentMilestones = Array.isArray(quoteData.milestones) ? quoteData.milestones : [];
      const targetMilestone = currentMilestones.find((m: any) => m.id === milestoneId);
      if (!targetMilestone) {
        throw new BadRequestError(`Milestone '${milestoneId}' not found on quote '${quoteId}'.`);
      }

      const targetStatus = decision === "approve" ? "approved" : "in_progress";
      const currentStatus = String(targetMilestone.status || "pending");
      if (decision === "approve" && currentStatus === "approved") {
        return { updatedTarget: targetMilestone, nextStatus: "approved" };
      }

      validateMilestoneTransition(currentStatus as any, targetStatus);

      let updatedTarget: any = null;
      const revisionCount = Number(targetMilestone.revisionCount || 0) + (decision === "request_revision" ? 1 : 0);

      const updatedMilestones = currentMilestones.map((m: any) => {
        if (m.id !== milestoneId) return m;
        updatedTarget = {
          ...m,
          status: targetStatus,
          ...(decision === "approve"
            ? {
                approvedAt: nowIso,
                approvedBy: authUid,
                payoutUnlocked: true,
              }
            : {
                revisionRequestedAt: nowIso,
                revisionRequestedBy: authUid,
                revisionReason: cleanReason.slice(0, 1000),
                revisionCount,
              }),
          updatedAt: nowIso,
        };
        return updatedTarget;
      });

      transaction.update(quoteRef, {
        milestones: updatedMilestones,
        updatedAt: nowIso,
      });

      const traderId =
        jobData.acceptedTradespersonId ||
        jobData.acceptedTraderId ||
        quoteData.tradespersonId ||
        quoteData.traderId;
      if (traderId) {
        const notifId =
          decision === "approve"
            ? `ms_approve_${jobId}_${milestoneId}`
            : `ms_rev_${jobId}_${milestoneId}_${revisionCount}`;
        transaction.set(db.collection("notifications").doc(notifId), {
          userId: traderId,
          title:
            decision === "approve"
              ? "Milestone Work Approved"
              : "Milestone Revision Requested",
          message:
            decision === "approve"
              ? `Your work for "${targetMilestone.title || "Milestone"}" was approved and unlocked for payout release.`
              : `Homeowner requested a revision for "${targetMilestone.title || "Milestone"}": ${cleanReason.slice(0, 200)}`,
          type: "status",
          read: false,
          jobId,
          quoteId,
          milestoneId,
          link: `/job/${jobId}`,
          createdAt: nowIso,
        });
      }

      return { updatedTarget, nextStatus: targetStatus };
    });

    return {
      success: true,
      jobId,
      quoteId,
      milestoneId,
      status: txOut.nextStatus,
      milestone: txOut.updatedTarget,
    };
  }

  /**
   * Production-Path Stripe Escrow Transfer Side Effect:
   * Strictly executed AFTER Firestore transaction commits.
   * Generates deterministic Stripe idempotency key:
   * `release:${jobId}:${quoteId}:${milestoneId || '0'}:${idempotencyKey}`
   * Updates ledger transfer status and records transfer errors without mutating DB transaction history.
   */
  public static async executeStripeEscrowTransfer(
    db: any,
    params: {
      jobId: string;
      quoteId: string;
      milestoneId?: string;
      idempotencyKey: string;
      traderId?: string;
      netPayoutPence: number;
      targetMilestoneTitle?: string;
      jobNo?: string;
      stripePaymentIntentId?: string;
      isDestinationCharge?: boolean;
      ledgerEntryId?: string;
    },
    options?: {
      stripe?: any;
    }
  ): Promise<{
    transferStatus: "completed" | "failed" | "reconciliation_required" | "skipped_destination_charge" | "skipped_mock_account" | "skipped_no_trader" | "skipped_no_stripe";
    stripeTransferId?: string;
    stripeIdempotencyKey: string;
    error?: string;
  }> {
    const {
      jobId,
      quoteId,
      milestoneId,
      idempotencyKey,
      traderId,
      netPayoutPence,
      targetMilestoneTitle = "Work Stage",
      jobNo,
      isDestinationCharge,
      ledgerEntryId,
    } = params;

    const stripeIdempotencyKey = `release:${jobId}:${quoteId}:${milestoneId || "0"}:${idempotencyKey}`;

    if (isDestinationCharge) {
      return {
        transferStatus: "skipped_destination_charge",
        stripeIdempotencyKey,
      };
    }

    if (!traderId) {
      return {
        transferStatus: "skipped_no_trader",
        stripeIdempotencyKey,
      };
    }

    const isProd = process.env.NODE_ENV === "production";
    const stripe = options?.stripe;
    if (!stripe) {
      if (isProd) {
        return {
          transferStatus: "failed",
          error: "Stripe transfer client unconfigured in production",
          stripeIdempotencyKey,
        };
      }
      return {
        transferStatus: "skipped_no_stripe",
        stripeIdempotencyKey,
      };
    }

    try {
      let traderStripeAccountId: string | undefined;
      if (db) {
        const traderDoc = await db.collection("users").doc(traderId).get();
        const traderData = typeof traderDoc.data === "function" ? traderDoc.data() : traderDoc.data;
        traderStripeAccountId = traderData?.stripeAccountId;
      }

      if (!traderStripeAccountId) {
        return {
          transferStatus: "failed",
          error: "Tradesperson has no connected Stripe payout account",
          stripeIdempotencyKey,
        };
      }

      if (traderStripeAccountId.startsWith("acct_mock_")) {
        if (isProd) {
          return {
            transferStatus: "failed",
            error: "Mock Stripe account is rejected in production",
            stripeIdempotencyKey,
          };
        }
        return {
          transferStatus: "skipped_mock_account",
          stripeIdempotencyKey,
        };
      }

      const transfer = await stripe.transfers.create(
        {
          amount: netPayoutPence,
          currency: "gbp",
          destination: traderStripeAccountId,
          description: `Milestone release for Job #${jobNo || jobId} (${targetMilestoneTitle})`,
          metadata: {
            jobId,
            quoteId,
            milestoneId: milestoneId || "m0",
            traderId,
            // Durable lookup identity for read-only Stripe reconciliation after an ambiguous response.
            releaseOperationId: idempotencyKey,
            stripeIdempotencyKey,
            operationType: "ANYTRADER_ESCROW_RELEASE",
          },
        },
        {
          idempotencyKey: stripeIdempotencyKey,
        }
      );

      const stripeTransferId = transfer?.id;
      if (typeof stripeTransferId !== "string" || stripeTransferId.trim().length === 0) {
        // Stripe may have created the transfer even if its response is malformed or
        // incomplete. Never report completion without a durable external transfer ID.
        throw new Error("Stripe returned a transfer response without a valid transfer ID; reconciliation is required.");
      }
      // A syntactically valid ID is not sufficient: verify the returned Stripe object
      // is the exact transfer requested before marking the ledger as paid out.
      const returnedMetadata = transfer?.metadata || {};
      const responseMatchesRequest =
        transfer?.amount === netPayoutPence &&
        String(transfer?.currency || "").toLowerCase() === "gbp" &&
        transfer?.destination === traderStripeAccountId &&
        returnedMetadata.jobId === jobId &&
        returnedMetadata.quoteId === quoteId &&
        returnedMetadata.milestoneId === (milestoneId || "m0") &&
        returnedMetadata.traderId === traderId &&
        returnedMetadata.releaseOperationId === idempotencyKey &&
        returnedMetadata.stripeIdempotencyKey === stripeIdempotencyKey &&
        returnedMetadata.operationType === "ANYTRADER_ESCROW_RELEASE";
      if (!responseMatchesRequest) {
        throw new Error("Stripe transfer response does not match the requested amount, currency, destination, or operation metadata; reconciliation is required.");
      }

      if (db) {
        if (ledgerEntryId) {
          await db.collection("payment_ledger").doc(ledgerEntryId).update({
            stripeTransferId,
            transferStatus: "completed",
            transferCompletedAt: new Date().toISOString(),
          });
        } else {
          const ledgerSnap = await db.collection("payment_ledger")
            .where("idempotencyKey", "==", idempotencyKey).get();
          const matchingEntry = ledgerSnap.docs.find((doc: any) => {
            const entry = doc.data();
            return entry?.type === "ESCROW_RELEASE" && entry.jobId === jobId &&
              entry.quoteId === quoteId && entry.milestoneId === (milestoneId || "m0");
          });
          if (matchingEntry) await matchingEntry.ref.update({
            stripeTransferId, transferStatus: "completed",
            transferCompletedAt: new Date().toISOString(),
          });
        }
      }

      return {
        transferStatus: "completed",
        stripeTransferId,
        stripeIdempotencyKey,
      };
    } catch (stripeErr: any) {
      const errorMessage = stripeErr?.message || String(stripeErr);
      console.error(
        `[Stripe Transfer Error] Milestone release transfer failed for job ${jobId}, quote ${quoteId}:`,
        errorMessage
      );

      if (db) {
        try {
          if (ledgerEntryId) {
            await db.collection("payment_ledger").doc(ledgerEntryId).update({
              transferStatus: "reconciliation_required",
              transferError: errorMessage,
              lastTransferAttemptAt: new Date().toISOString(),
            });
          } else {
            const ledgerSnap = await db.collection("payment_ledger")
              .where("idempotencyKey", "==", idempotencyKey).get();
            const matchingEntry = ledgerSnap.docs.find((doc: any) => {
              const entry = doc.data();
              return entry?.type === "ESCROW_RELEASE" && entry.jobId === jobId &&
                entry.quoteId === quoteId && entry.milestoneId === (milestoneId || "m0");
            });
            if (matchingEntry) await matchingEntry.ref.update({
              transferStatus: "reconciliation_required",
              transferError: errorMessage,
              lastTransferAttemptAt: new Date().toISOString(),
            });
          }
        } catch (dbErr) {
          console.error("Failed to record Stripe transfer failure to ledger:", dbErr);
        }
      }

      return {
        transferStatus: "reconciliation_required",
        error: errorMessage,
        stripeIdempotencyKey,
      };
    }
  }

  /**
   * Generates accurate, non-misleading trader notification payloads for milestone escrow release.
   * Tailors title and messaging strictly to the external Stripe transfer status.
   */
  public static formatReleaseNotification(params: {
    transferStatus: "completed" | "failed" | "reconciliation_required" | "skipped_destination_charge" | "skipped_mock_account" | "skipped_no_trader" | "skipped_no_stripe";
    isQrHandshake?: boolean;
    jobNo?: string;
    targetMilestoneTitle?: string;
  }): { title: string; message: string } {
    const {
      transferStatus,
      isQrHandshake,
      jobNo = "Job",
      targetMilestoneTitle = "Milestone",
    } = params;

    if (transferStatus === "completed" || transferStatus === "skipped_destination_charge") {
      return {
        title: isQrHandshake ? "Work Verified & Funds Released! 🤝" : "Funds Released! 💸",
        message: isQrHandshake
          ? `QR Handshake complete for "${jobNo}". Funds released to your account.`
          : `The homeowner has released funds for milestone: "${targetMilestoneTitle}". Funds transferred to your Stripe account.`,
      };
    }

    if (transferStatus === "reconciliation_required") {
      return {
        title: "Payout Outcome Requires Reconciliation ⚠️",
        message: `Stripe did not confirm the outcome for milestone "${targetMilestoneTitle}". The release is locked to its original operation key pending reconciliation; do not start a new release.`,
      };
    }

    if (transferStatus === "failed") {
      return {
        title: isQrHandshake
          ? "Work Verified (Payout Pending) ⚠️"
          : "Release Recorded (Payout Pending Retry) ⚠️",
        message: isQrHandshake
          ? `QR Handshake verified for "${jobNo}". Payout transfer encountered an issue and will be retried.`
          : `The homeowner approved milestone: "${targetMilestoneTitle}". Escrow release is recorded, but payout transfer is pending retry.`,
      };
    }

    // Non-Stripe / Mock / No-Stripe configured
    return {
      title: isQrHandshake
        ? "Work Verified & Escrow Released 🤝"
        : "Milestone Approved & Escrow Released 📋",
      message: isQrHandshake
        ? `QR Handshake complete for "${jobNo}". Escrow released on platform.`
        : `Milestone "${targetMilestoneTitle}" escrow release recorded on platform.`,
    };
  }

  /**
   * Canonical Job Payment Status Reconciler (Slice 2 Money Flow Fix):
   * Executed after a milestone's Stripe transfer succeeds (or is skipped for destination/dev charges).
   * Inspects all milestones on the accepted quote inside a transaction:
   * - When ALL milestones are released cleanly, sets jobs/{jobId}.isPaid = true and
   *   paymentStatus = isQrHandshake ? "handshake_complete" : "paid", and upgrades any existing
   *   official job invoice (`INV_{jobId}`) to `paid`.
   * - When SOME milestones are released, sets paymentStatus = "partially_released" without
   *   marking the job fully paid.
   */
  public static async reconcileJobPaymentStatus(
    db: any,
    params: { jobId: string; quoteId: string; isQrHandshake?: boolean }
  ): Promise<{
    allMilestonesReleased: boolean;
    anyMilestoneReleased: boolean;
    paymentStatus: string | null;
    isPaid: boolean;
  }> {
    const { jobId, quoteId, isQrHandshake } = params;
    if (!db || !jobId || !quoteId) {
      return { allMilestonesReleased: false, anyMilestoneReleased: false, paymentStatus: null, isPaid: false };
    }

    const jobRef = db.collection("jobs").doc(jobId);
    const quoteRef = jobRef.collection("quotes").doc(quoteId);
    const invoiceRef = db.collection("invoices").doc(`INV_${jobId}`);
    const nowIso = new Date().toISOString();

    return db.runTransaction(async (tx: any) => {
      const [jobSnap, quoteSnap, invoiceSnap] = await Promise.all([
        tx.get(jobRef),
        tx.get(quoteRef),
        tx.get(invoiceRef),
      ]);
      if (!jobSnap.exists || !quoteSnap.exists) {
        return { allMilestonesReleased: false, anyMilestoneReleased: false, paymentStatus: null, isPaid: false };
      }
      const jobData = (typeof jobSnap.data === "function" ? jobSnap.data() : jobSnap.data) || {};
      const quoteData = (typeof quoteSnap.data === "function" ? quoteSnap.data() : quoteSnap.data) || {};
      const milestones = Array.isArray(quoteData.milestones) ? quoteData.milestones : [];

      if (milestones.length === 0) {
        return {
          allMilestonesReleased: false,
          anyMilestoneReleased: false,
          paymentStatus: jobData.paymentStatus || null,
          isPaid: Boolean(jobData.isPaid),
        };
      }

      const isCleanlyReleased = (m: any) =>
        ["released", "funds_released"].includes(String(m?.status || "").toLowerCase()) &&
        m?.releaseStatus !== "reconciliation_required" &&
        m?.releaseStatus !== "failed";

      const allMilestonesReleased = milestones.every(isCleanlyReleased);
      const anyMilestoneReleased = milestones.some(isCleanlyReleased);

      if (allMilestonesReleased) {
        const nextStatus = isQrHandshake ? "handshake_complete" : "paid";
        tx.update(jobRef, {
          isPaid: true,
          paymentStatus: nextStatus,
          paidAt: jobData.paidAt || nowIso,
          updatedAt: nowIso,
        });
        if (invoiceSnap.exists) {
          const invData = (typeof invoiceSnap.data === "function" ? invoiceSnap.data() : invoiceSnap.data) || {};
          if (invData.status !== "paid" || invData.isPaid !== true || invData.paid !== true) {
            tx.update(invoiceRef, {
              status: "paid",
              paid: true,
              isPaid: true,
              paidAt: invData.paidAt || nowIso,
              updatedAt: nowIso,
            });
          }
        }
        return {
          allMilestonesReleased: true,
          anyMilestoneReleased: true,
          paymentStatus: nextStatus,
          isPaid: true,
        };
      }

      if (anyMilestoneReleased && jobData.isPaid !== true) {
        tx.update(jobRef, {
          isPaid: false,
          paymentStatus: "partially_released",
          updatedAt: nowIso,
        });
        return {
          allMilestonesReleased: false,
          anyMilestoneReleased: true,
          paymentStatus: "partially_released",
          isPaid: false,
        };
      }

      return {
        allMilestonesReleased: false,
        anyMilestoneReleased,
        paymentStatus: jobData.paymentStatus || null,
        isPaid: Boolean(jobData.isPaid),
      };
    });
  }

  /**
   * Releases a stale `completed` idempotency lock ONLY when a definite preflight Stripe error
   * occurred BEFORE any transfer API call was issued and the milestone has been rolled back to `funded`.
   * Never call this for `reconciliation_required` (ambiguous transfer state).
   */
  public static async releaseFailedPreflightIdempotencyLock(
    db: any,
    idempotencyKey: string
  ): Promise<{ released: boolean }> {
    if (!db || !idempotencyKey || idempotencyKey.includes("/")) {
      return { released: false };
    }
    const idempotencyRef = db.collection("payment_idempotency").doc(idempotencyKey);
    return db.runTransaction(async (tx: any) => {
      const snap = await tx.get(idempotencyRef);
      if (!snap.exists) return { released: false };
      const data = (typeof snap.data === "function" ? snap.data() : snap.data) || {};
      if (data.status === "reconciliation_required" || data.releaseStatus === "reconciliation_required") {
        return { released: false };
      }
      if (data.operationName === "ESCROW_RELEASE") {
        tx.delete(idempotencyRef);
        return { released: true };
      }
      return { released: false };
    });
  }
}
