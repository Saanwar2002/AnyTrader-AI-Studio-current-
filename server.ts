import express from "express";
import { decrementGothamPropertyUsage, evaluateGothamPropertyQuota } from "./src/server/gothamPropertyQuota.ts";
import { getSubscriptionIdForProduct, isExplicitMockSubscriptionAllowed, isMockSubscriptionId, resolveVerifiedSubscriptionTarget } from "./src/server/stripeSubscriptionGuards.ts";
import { buildLandlordCheckoutFulfillmentPatch, buildSubscriptionLifecyclePatch, extractInvoiceSubscriptionId, isStripeSubscriptionLifecycleEventType, resolveSubscriptionProductMatch } from "./src/server/subscriptionLifecycle.ts";
import { ownsStripeWebhookClaim } from "./src/server/stripeWebhookIdempotency.ts";
import { claimStripeEventLease, markStripeEventCompleted, markStripeEventFailed } from "./src/server/stripeWebhookHandler.ts";
import { generateFinancialReconciliationReport, executeReconciliationOperatorAction } from "./src/server/reconciliationReport.ts";
import { suspendOrDeleteAccount, reinstateSuspendedAccount, verifyTraderAccountWithProjection, reviewTraderVerificationDocument } from "./src/server/accountLifecycle.ts";
import { publishPlatformPricingConfigAtomic } from "./src/server/pricingConfigPublish.ts";
import { createMediationStakePaymentIntent, confirmMediationStakePayment, recordMediationStakePaymentFailure } from "./src/server/mediationStake.ts";
import { getRefundEventReconciliationStatus, recordConfirmedRefund, reconcilePaymentRefundAggregates } from "./src/server/refundReconciliation.ts";
import { listAllChargeRefunds } from "./src/server/stripeRefundPagination.ts";
import { evaluateCheckoutIntentBinding, transitionCheckoutIntentState, sweepStaleCheckoutIntents } from "./src/server/checkoutIntentIntegrity.ts";
import {
  assertPayoutEligibleRole,
  ensureStripeAccountForProvider,
  ensureStripeCustomerIdForUser,
  reconcileStripeAccountUpdatedWebhook,
} from "./src/server/stripeConnectHelpers.ts";
import {
  listCustomerPaymentMethods,
  setCustomerDefaultPaymentMethod,
  detachCustomerPaymentMethod,
  syncDefaultPaymentMethodFromSetupSession,
  PaymentMethodRouteError,
} from "./src/server/stripePaymentMethods.ts";
import { executeUpgradeHomeownerToTraderCommand } from "./src/server/accountUpgrade.ts";
import {
  executeExportUserDataCommand,
  executeSelfServiceAccountDeletionCommand,
} from "./src/server/accountGdpr.ts";
import {
  executeTransitionRideCommand,
  executeCompleteRideCommand,
  executeCancelRideCommand,
  fulfillTaxiTripCheckout,
  createDriverFeeSettlementCheckout,
  fulfillDriverFeeSettlementWebhook,
  recordDriverOnlineHeartbeat,
} from "./src/server/rideLifecycleCommands.ts";
import {
  dispatchRideOffersCommand,
  executeDeclineRideOfferCommand,
  executeRatePassengerCommand,
  getSanitizedNearbyDrivers,
  notifyRideCounterpartyPush,
  RIDE_OFFER_CHANNEL_ID,
  RIDE_UPDATES_CHANNEL_ID,
} from "./src/server/rideOfferDispatch.ts";
import { createServer as createViteServer } from "vite";
import path from "path";
import crypto from "crypto";

import dotenv from "dotenv";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import firebaseConfig from "./firebase-applet-config.json" with { type: "json" };
import { GoogleGenAI } from "@google/genai";
import jwt from "jsonwebtoken";
import cron from "node-cron";
import Stripe from 'stripe';
import twilio from 'twilio';
import rateLimit from "express-rate-limit";
import { startInstantMatchEngine, advanceInstantMatchAfterDecline } from "./instantMatchWorker.ts";
import * as geminiServer from "./src/services/geminiServer.ts";
import { sendHttpError, BadRequestError, UnauthorizedError, ForbiddenError, NotFoundError, ConflictError, InternalServerError, ServiceUnavailableError } from "./src/server/httpErrors.ts";
import { runProductionChecks } from "./src/server/productionChecks.ts";
import { isMaintenanceModeActive, invalidateMaintenanceCache, createMaintenanceEmergencyStopMiddleware } from "./src/server/maintenanceGate.ts";
import { verifyFirebaseIdTokenWithRevocation } from "./src/server/tokenVerification.ts";
import { buildClaimPropertyTransferUpdate } from "./src/server/propertyTransferCommand.ts";
import {
  sanitizePropertyTenantContext,
  resolveTenantIssueCreationPayload,
  TenantIssueValidationError,
} from "./src/server/propertyLifecycleHelpers.ts";
import { assertCanReadJobIntelligence } from "./src/server/intelligence/jobIntelligenceAccess.ts";
import {
  resolveAdminCapabilityTier,
  assertAdminCapability,
  createDualControlApprovalRequest,
  reviewDualControlApprovalRequest,
  consumeDualControlApproval,
  enqueueAdminBroadcastCommand,
  upsertFeatureFlagCommand,
  listFeatureFlagsCommand,
  getOperationalHealthSnapshot,
  DUAL_CONTROL_THRESHOLD_GBP,
  type AdminCapabilityTier,
  type AdminActor,
} from "./src/server/adminGovernance.ts";
import {
  executeAdminResolveDisputeCommand,
  executeAdminVideoVerificationCommand,
  executeAdminProvisionalOverrideCommand,
  executeAdminModerateReviewCommand,
} from "./src/server/adminControlCommands.ts";
import { FirestoreRateLimitStore } from "./src/server/distributedRateLimit.ts";
import {
  reportOrBlockChatParticipantCommand,
  unblockChatParticipantCommand,
  listUserChatBlocksCommand,
} from "./src/server/chatSafety.ts";
import {
  processSmsQueueCommand,
  runConsultancyRecurringSessionCreatorCommand,
  runConsultancyScoreRecalculatorCommand,
  publishMatureCoolingOffReviewsCommand,
  buildCronDispatchResponse,
  fetchPostcodeWithTimeout,
} from "./src/server/cronWorkers.ts";
import { validateJobTransition, validateMilestoneTransition, validateRideTransition, validateQuoteTransition, JobStatus } from "./src/server/stateMachine.ts";
import { PaymentLedgerEngine } from "./src/server/paymentLedger.ts";
import { sanitizeRedirectUrl, getAuthoritativeAppUrl } from "./src/server/paymentVerification.ts";
import { assertResourceOwner, assertCanManageMilestone, sanitizeClientPayload, validateNotificationPayload, authorizeNotificationRequest, isUserAdminClaim } from "./src/server/authorization.ts";
import { assertCanReview, ReviewType, getJobParticipantIds } from "./src/server/reviewAuthorization.ts";
import { executeBootstrapProfileCommand, bootstrapProfileSchema } from "./src/server/accountBootstrap.ts";
import {
  executeAcceptTermsCommand,
  executeSyncExpiredVerificationDocsCommand,
  executeRemoveVideoVerificationCommand,
  executeListBusinessTeamCommand,
  executeSendBusinessTeamInviteCommand,
  executeRevokeBusinessTeamInviteCommand,
  executeAcceptBusinessTeamInviteCommand,
  executeRemoveBusinessTeamMemberCommand,
} from "./src/server/slice1AccountCommands.ts";
import {
  listAuthoritativeNotifications,
  markAuthoritativeNotificationRead,
  deleteAuthoritativeNotification,
  registerAuthoritativePushToken,
  unregisterAuthoritativePushToken,
  dispatchAuthoritativeFcmPush,
  sendAuthoritativeChatPush,
} from "./src/server/notificationEngine.ts";
import {
  getMetaWhatsAppConfig,
  verifyMetaWebhookSignature,
  enqueueWhatsAppFallback,
  processWhatsAppFallbackQueue,
  createWhatsAppActivationLink,
  getUserNotificationPreferences,
  updateUserNotificationPreferences,
  recordUserChatPresence,
  handleMetaWhatsAppWebhook,
  type WhatsAppContextType,
} from "./src/server/whatsappNotificationEngine.ts";
import {
  buildAndroidAssetLinksPayload,
  buildAppleAppSiteAssociationPayload,
} from "./src/server/mobileDeepLinks.ts";
import {
  generateAuthoritativeSsoToken,
  executeAuthoritativeAccountLinking,
} from "./src/server/ssoClaimIntegrity.ts";
import { AbuseDefenseEngine } from "./src/server/abuseDefense.ts";
import { BusinessLogicDefense } from "./src/server/businessLogicDefense.ts";
import { domainEvents } from "./src/server/domainEvents.ts";
import { resolveAuthoritativeLineItem, SERVER_PRICING_CATALOG, calculateGothamSaaSPlanServer, getDynamicFirestoreConfigs } from "./src/server/pricingCatalog.ts";
import { normalizeTraderTier } from "./src/services/stripeIntegrationService.ts";
import { resolveTrustedCanonicalIdentity } from "./src/server/identity.ts";
import { executeCreateJobCommand, executeUpdateJobCommand, executeDeleteJobCommand, resolveCreateJobQuota } from "./src/server/createJobCommand.ts";
import { executeQuoteCommand, executeAcceptQuoteCommand } from "./src/server/quoteCommands.ts";
import { executeAcceptRideCommand } from "./src/server/driverAuthorization.ts";
import { executeCreateTripPaymentCommand } from "./src/server/tripPaymentAuthorization.ts";
import { executeJobLifecycleCommand, executeJobScheduleActionCommand } from "./src/server/jobLifecycleCommands.ts";
import {
  executeInviteTraderToJobCommand,
  executeCreateBomOrderCommand,
  executeGenerateRecurringJobCommand,
} from "./src/server/stage1Commands.ts";
import { 
  startPublicJobCardsSync, 
  backfillPublicJobCards, 
  sanitizeJobToPublicCard,
  startPublicPropertiesSync,
  backfillPublicProperties,
  sanitizePropertyToPublicPassport,
  isPropertyEligibleForPublicPassport,
  startPublicAdsSync,
  backfillPublicAds,
  isDirectJob
} from "./src/server/projectionSync.ts";
import {
  jobIntelligenceService,
  propertyIntelligenceService,
  qualityReviewService,
  controlledBackfillEngine,
  evidenceRegistry,
  intelligenceTaskQueue,
  immutableIntelligenceStore,
  buildIdempotencyKey,
  processAICandidateToCanonical,
  resolveAuthoritativeJobPropertyId,
  AICandidateSecurityError,
  validateAndSanitizeAICandidate,
  TrustedServerContext,
  INTELLIGENCE_PIPELINE_VERSION,
  INTELLIGENCE_SCHEMA_VERSION,
  PredictiveMaintenanceService,
  enqueuePredictiveMaintenanceTask,
  RecordPredictiveMaintenanceInput,
  PropertyPassportService,
  propertyPassportService,
  GeneratePropertyPassportInput,
  enqueuePropertyPassportTask,
  BuyerIntelligenceService,
  buyerIntelligenceService,
  GenerateBuyerIntelligenceInput,
  enqueueBuyerIntelligenceTask,
  ContractorArchiveRightsService,
  contractorArchiveRightsService,
  ContractorArchiveSecurityError,
  ContractorArchiveValidationError,
  DataClassificationEligibilityService,
  dataClassificationEligibilityService,
  DataClassificationSecurityError,
  DataClassificationValidationError,
  AiTrainingUsageControlsService,
  aiTrainingUsageControlsService,
  AiUsageControlsSecurityError,
  AiUsageControlsValidationError,
  computeJobAnalysisVersionHash,
  computeSha256,
  DataRetentionService,
  dataRetentionService,
  DataRetentionSecurityError,
  DataRetentionValidationError,
  DataRetentionNotFoundError,
} from "./src/server/intelligence/index.ts";
import { enqueueOutreachMessageCommand, listOutreachQueueCommand } from "./src/server/outreachQueue.ts";
import { updateFieldEntityWithOwnershipGuard } from "./src/server/fieldOperationsCommands.ts";
import { executeDriverPayoutOrchestrationCommand } from "./src/server/driverPayoutOrchestration.ts";
import {
  runBootstrapSequence,
  verifyFirestoreReadiness,
  verifyIntelligenceHandlersRegistered,
  BootstrapLifecycleHooks
} from "./src/server/bootstrap.ts";
import {
  acquireSchedulerLock,
  renewSchedulerLeaseHeartbeat,
  releaseSchedulerLock,
} from "./src/server/schedulerLock.ts";
import { dispatchTransactionalEmail } from "./src/server/emailTransport.ts";
import {
  createAndDispatchStaffInvitation,
  acceptStaffInvitationToken,
  StaffInvitationError,
} from "./src/server/staffInvitations.ts";
import {
  parseAdminBackfillOptions,
  BackfillValidationError,
} from "./src/server/intelligence/backfillEngine.ts";
import { isStripeChargebackEventType, processStripeChargebackEvent } from "./src/server/chargebackLifecycle.ts";
import {
  filterEligibleLeadRecipients,
  distributeJobLeadsAuthoritative,
  expandLowQuoteJobsWave2,
} from "./src/server/leadDistribution.ts";
import { createManualInvoiceCommand, createOrGetJobInvoiceCommand } from "./src/server/invoiceCreation.ts";
import {
  resolveInstantMatchPaymentIntentId,
  canReplaceLinkedSubscription,
  resolveSubscriptionPeriodEndIso,
} from "./src/server/slice2MoneyFlowHelpers.ts";
import { respondToInstantMatchAttempt } from "./src/server/instantMatchEligibility.ts";
import {
  createBannerAdCommand,
  createCpcCampaignCommand,
  editAdCreativeCommand,
  moderateAdCommand,
  processAdAutoTopUpCommand,
  toggleAdActiveCommand,
  topUpAdCampaignCommand,
  trackSponsoredAdEventCommand,
  updateAdAutoTopUpSettingsCommand,
} from "./src/server/adEngine.ts";
import { executeProviderPayoutCommand } from "./src/server/providerPayoutCommand.ts";

dotenv.config();



// Real-time Firestore sync for Gemini Category Prompt Layer
const startCategoryRegistrySyncWorker = (firestoreDb: admin.firestore.Firestore) => {
  try {
    let unsubCat: (() => void) | null = null;
    let unsubSyn: (() => void) | null = null;

    unsubCat = firestoreDb.collection("platform_categories").onSnapshot((snapshot) => {
      const categories: any[] = [];
      snapshot.forEach((doc) => {
        categories.push({ id: doc.id, ...doc.data() });
      });
      if (categories.length > 0) {
        geminiServer.syncCategoryRegistryServer(categories);
        console.log(`[Gemini Sync] Synchronized ${categories.length} Firestore categories to AI prompt layer.`);
      }
    }, (err: any) => {
      const msg = err?.message || String(err);
      if (err?.code === 7 || msg.includes("7") || msg.includes("PERMISSION_DENIED") || msg.includes("Missing or insufficient permissions") || msg.includes("UNAUTHENTICATED") || msg.includes("Could not load the default credentials")) {
        if (unsubCat) {
          try { unsubCat(); } catch {}
        }
        return;
      }
      console.warn("[Gemini Sync] Firestore category sync listener notice:", msg);
    });

    unsubSyn = firestoreDb.collection("dynamic_search_synonyms").onSnapshot((snapshot) => {
      const synonyms: any[] = [];
      snapshot.forEach((doc) => {
        synonyms.push({ id: doc.id, ...doc.data() });
      });
      if (synonyms.length > 0) {
        geminiServer.syncCategoryRegistryServer(undefined, synonyms);
        console.log(`[Gemini Sync] Synchronized ${synonyms.length} search synonyms to AI prompt layer.`);
      }
    }, (err: any) => {
      const msg = err?.message || String(err);
      if (err?.code === 7 || msg.includes("7") || msg.includes("PERMISSION_DENIED") || msg.includes("Missing or insufficient permissions") || msg.includes("UNAUTHENTICATED") || msg.includes("Could not load the default credentials")) {
        if (unsubSyn) {
          try { unsubSyn(); } catch {}
        }
        return;
      }
      console.warn("[Gemini Sync] Firestore synonym sync listener notice:", msg);
    });
  } catch (syncErr: any) {
    // Gracefully handle if DB is unavailable
  }
};

// Initialize Firebase Admin
let db: admin.firestore.Firestore | null = null;
let isApplicationReady = false;
let bootstrapError: string | null = null;

export async function initializeFirebaseAdminAsync(): Promise<{ app: admin.app.App; db: admin.firestore.Firestore }> {
  let app: admin.app.App;
  if (admin.apps.length > 0 && admin.apps[0]) {
    app = admin.apps[0]!;
  } else {
    app = admin.initializeApp({
      projectId: firebaseConfig.projectId,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || firebaseConfig.storageBucket,
    });
    console.log("Firebase Admin initialized for project:", firebaseConfig.projectId);
  }

  const dbId = firebaseConfig.firestoreDatabaseId || "(default)";
  let firestoreDb: admin.firestore.Firestore;

  try {
    firestoreDb = getFirestore(app, dbId);
  } catch (err: any) {
    if (dbId !== "(default)") {
      console.warn(`Falling back to (default) database due to issue with: ${dbId}`);
      firestoreDb = getFirestore(app, "(default)");
    } else {
      throw err;
    }
  }

  // Defense-in-depth: Canonical intelligence records carry explicit undefined for optional fields.
  // Enabling ignoreUndefinedProperties ensures writes containing undefined properties do not throw in production.
  try {
    firestoreDb.settings({ ignoreUndefinedProperties: true });
  } catch {
    // settings() throws if the instance has already been initialized or used — safe to ignore.
  }

  db = firestoreDb;
  return { app, db: firestoreDb };
}

export function registerIntelligenceTaskHandlers(overrideDb?: any): void {
  if (
    !overrideDb &&
    intelligenceTaskQueue.hasHandler("job_extraction") &&
    intelligenceTaskQueue.hasHandler("property_rollup") &&
    intelligenceTaskQueue.hasHandler("predictive_maintenance") &&
    intelligenceTaskQueue.hasHandler("property_passport") &&
    intelligenceTaskQueue.hasHandler("buyer_intelligence")
  ) {
    return;
  }

  intelligenceTaskQueue.registerHandler("job_extraction", async (task) => {
    const payload = (task.payload || {}) as any;
    const job = payload.job;
    if (!job) throw new Error("Missing job payload for extraction");

    const activeDb = overrideDb || payload.db || payload.firestoreDb || (intelligenceTaskQueue as any).firestoreDb || db;
    if (!activeDb) {
      throw new AICandidateSecurityError("Firestore DB reference is required to validate evidence lineage and persist intelligence");
    }

    // Resolve authoritative propertyId from transactional jobs collection
    let authoritativePropertyId = job.propertyId;
    if (activeDb && job.jobId) {
      try {
        authoritativePropertyId = await resolveAuthoritativeJobPropertyId(activeDb, job.jobId);
      } catch {
        // Retain job.propertyId if present, or undefined
      }
    }

    // Server-owned trusted context (MUST override any model claims)
    const serverContext: TrustedServerContext = {
      aggregateType: 'job',
      aggregateId: job.jobId,
      propertyId: authoritativePropertyId,
      sourceId: job.homeownerId || job.userId || `usr_${job.jobId}`,
      sourceVersion: String(job.sourceVersion || '1'),
      pipelineVersion: job.pipelineVersion || INTELLIGENCE_PIPELINE_VERSION,
      modelVersion: job.modelVersion || 'gemini-2.5-flash',
      promptVersion: job.promptVersion || 'job_extraction_v8.1',
      schemaVersion: job.schemaVersion || INTELLIGENCE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
    };

    // Obtain untrusted AI candidate
    let rawCandidate = payload.rawCandidate ?? payload.rawAICandidate ?? job.rawCandidate ?? job.rawAICandidate;

    if (rawCandidate === undefined) {
      // Derive candidate through model extraction
      const derived = await jobIntelligenceService.deriveJobIntelligence(
        job,
        undefined,
        {
          firestoreDb: activeDb,
          provider: payload.provider || job.provider,
          persist: false,
        }
      );

      // Keep provenance truthful: use the model that actually ran, not the default fallback
      if (derived.extraction?.modelVersion) {
        serverContext.modelVersion = job.modelVersion || derived.extraction.modelVersion;
      }

      rawCandidate = (derived as any).rawCandidate || (derived as any).extraction?.structuredCandidate;
      if (!rawCandidate) {
        const evIds = derived.jobIntelligence.evidenceIds || [];
        rawCandidate = {
          domain: (derived.jobIntelligence.category || 'general').toLowerCase(),
          category: derived.jobIntelligence.category,
          component: derived.jobIntelligence.buildingComponent,
          observations: [
            {
              description: derived.jobIntelligence.observedProblem || 'Observed problem',
              component: derived.jobIntelligence.buildingComponent,
              evidenceIds: evIds.length > 0 ? evIds : ['ev_placeholder'],
            },
          ],
          inferences: [
            {
              hypothesis: derived.jobIntelligence.recommendedIntervention || 'Recommended intervention',
              confidence: derived.jobIntelligence.confidence?.overall ?? 0.85,
              supportingEvidenceIds: evIds.length > 0 ? evIds : ['ev_placeholder'],
              targetComponent: derived.jobIntelligence.buildingComponent,
            },
          ],
          evidenceIds: evIds,
          candidateConfidence: derived.jobIntelligence.confidence?.overall,
        };
      }
    }

    // MANDATORY AI CANDIDATE SECURITY BOUNDARY INVOCATION:
    // Untrusted AI Candidate -> Structural Validation -> Server Metadata -> Evidence Lineage -> Canonicalization -> Immutable Store
    const { canonical, persisted } = await processAICandidateToCanonical(
      rawCandidate,
      serverContext,
      {
        firestoreDb: activeDb,
        persistToStore: true,
      }
    );

    const summaryProjection = {
      jobId: canonical.aggregateId,
      propertyId: authoritativePropertyId || canonical.propertyId,
      currentVersionId: canonical.canonicalId,
      domain: canonical.domain,
      category: canonical.category || canonical.domain,
      buildingComponent: canonical.component || canonical.observations[0]?.component || '',
      observedProblem: canonical.problems?.[0]?.description || canonical.observations[0]?.description || '',
      extractedScope: canonical.interventions?.map((i) => i.description) || [],
      recommendedIntervention: canonical.interventions?.[0]?.description || '',
      evidenceIds: canonical.evidenceIds,
      confidence: canonical.confidence,
      provenance: canonical.provenance,
      pipelineVersion: canonical.pipelineVersion,
      updatedAt: canonical.generatedAt,
    };

    return {
      jobIntelligence: summaryProjection,
      canonical,
      eventId: `event_${canonical.canonicalId}`,
      versionId: canonical.canonicalId,
      persisted,
    };
  });

  intelligenceTaskQueue.registerHandler("property_rollup", async (task) => {
    const payload = (task.payload || {}) as any;
    const { property, historicalJobs } = payload;
    if (!property) throw new Error("Missing property payload for rollup");
    const activeDb = overrideDb || payload.db || payload.firestoreDb || (intelligenceTaskQueue as any).firestoreDb || db;
    
    const propId = typeof property === 'string' ? property : property.propertyId;
    let jobsToRollup = historicalJobs;
    if ((!jobsToRollup || jobsToRollup.length === 0) && activeDb) {
      try {
        jobsToRollup = await propertyIntelligenceService.getHistoricalJobsForProperty(propId, activeDb);
      } catch {
        jobsToRollup = [];
      }
    }

    const result = await propertyIntelligenceService.aggregatePropertyIntelligence(
      property,
      jobsToRollup || [],
      undefined,
      { firestoreDb: activeDb }
    );
    return { propertyIntelligence: result.propertyIntelligence, eventId: result.event.eventId, versionId: result.versionId };
  });

  intelligenceTaskQueue.registerHandler("predictive_maintenance", async (task) => {
    const payload = (task.payload || {}) as any;
    const activeDb = overrideDb || payload.db || payload.firestoreDb || (intelligenceTaskQueue as any).firestoreDb || db;
    if (!activeDb) {
      throw new Error("[PredictiveMaintenance Task] Firestore DB reference is required");
    }

    const targetPropertyId = payload.propertyId || task.aggregateId;
    if (!targetPropertyId) {
      throw new Error("[PredictiveMaintenance Task] Missing propertyId");
    }

    // Resolve authoritative propertyId from properties collection
    let authoritativePropertyId = targetPropertyId;
    try {
      const propSnap = await activeDb.collection("properties").doc(targetPropertyId).get();
      if (propSnap && propSnap.exists) {
        authoritativePropertyId = propSnap.data()?.propertyId || targetPropertyId;
      }
    } catch {
      // Retain targetPropertyId
    }

    const {
      componentType,
      predictionType,
      forecastStart,
      forecastEnd,
      likelihood,
      severity,
      rationale,
      evidenceIds,
      supportingConditionIds,
      supportingRiskIds,
      supportingJobIds,
      sourceJobId,
      sourceType,
      sourceId,
      confidence,
      provenance,
      isVerifiedServerAction,
      metadata,
      rawCandidate,
    } = payload;

    let effectiveInput: RecordPredictiveMaintenanceInput = {
      propertyId: authoritativePropertyId,
      componentType: componentType || 'roof',
      predictionType: predictionType || 'maintenance_due',
      forecastStart: forecastStart || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      forecastEnd: forecastEnd || new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
      likelihood,
      severity: severity || 'medium',
      rationale: rationale || 'Authoritative evidence-backed maintenance forecast',
      evidenceIds: Array.isArray(evidenceIds) ? evidenceIds : [],
      supportingConditionIds,
      supportingRiskIds,
      supportingJobIds,
      sourceJobId,
      sourceType,
      sourceId,
      confidence,
      provenance: provenance || {
        origin: 'manual_inspection',
        tenantId: 'tenant_default',
      },
      metadata,
    };

    if (rawCandidate && typeof rawCandidate === 'object') {
      // 1. Reject attempts to manufacture raw evidence or hijack system instructions
      if ('evidenceRegistryRecord' in rawCandidate || 'createEvidence' in rawCandidate || 'rawEvidence' in rawCandidate) {
        throw new AICandidateSecurityError('AI model output is strictly forbidden from creating raw evidence records');
      }

      // 2. Untrusted AI candidates can NEVER self-verify or override server-authoritative context
      const safeCandidate = { ...rawCandidate };
      delete (safeCandidate as any).propertyId;
      delete (safeCandidate as any).aggregateId;
      delete (safeCandidate as any).aggregateType;
      delete (safeCandidate as any).isVerifiedServerAction;
      delete (safeCandidate as any).verified;
      delete (safeCandidate as any).maintenanceId;

      if (Array.isArray(safeCandidate.evidenceIds)) {
        effectiveInput.evidenceIds = safeCandidate.evidenceIds;
      }
      if (safeCandidate.componentType) {
        effectiveInput.componentType = safeCandidate.componentType;
      }
      if (safeCandidate.forecastStart) {
        effectiveInput.forecastStart = safeCandidate.forecastStart;
      }
      if (safeCandidate.forecastEnd) {
        effectiveInput.forecastEnd = safeCandidate.forecastEnd;
      }
      if (safeCandidate.rationale || safeCandidate.description) {
        effectiveInput.rationale = safeCandidate.rationale || safeCandidate.description;
      }
      if (safeCandidate.predictionType) {
        effectiveInput.predictionType = safeCandidate.predictionType;
      }
      if (safeCandidate.likelihood !== undefined) {
        effectiveInput.likelihood = safeCandidate.likelihood;
      }
      if (safeCandidate.severity) {
        effectiveInput.severity = safeCandidate.severity;
      }
    }

    const service = new PredictiveMaintenanceService({ firestoreDb: activeDb });
    const assessment = await service.recordMaintenancePrediction(effectiveInput, {
      firestoreDb: activeDb,
      isVerifiedServerAction: rawCandidate ? false : !!isVerifiedServerAction,
    });

    return {
      success: true,
      maintenanceId: assessment.maintenanceId,
      contentHash: assessment.contentHash,
      assessment,
    };
  });

  intelligenceTaskQueue.registerHandler("property_passport", async (task) => {
    const payload = (task.payload || {}) as any;
    const activeDb = overrideDb || payload.db || payload.firestoreDb || (intelligenceTaskQueue as any).firestoreDb || db;
    if (!activeDb) {
      throw new Error("[PropertyPassport Task] Firestore DB reference is required");
    }

    const targetPropertyId = payload.propertyId || task.aggregateId;
    if (!targetPropertyId) {
      throw new Error("[PropertyPassport Task] Missing propertyId");
    }

    const { provenance, isVerifiedServerAction } = payload;
    const input: GeneratePropertyPassportInput = {
      propertyId: targetPropertyId,
      provenance,
    };

    const service = new PropertyPassportService({ firestoreDb: activeDb });
    const passport = await service.generatePropertyPassport(input, {
      firestoreDb: activeDb,
      isVerifiedServerAction: !!isVerifiedServerAction,
    });

    return {
      success: true,
      propertyId: passport.propertyId,
      snapshotId: passport.provenance.snapshotId,
      contentHash: passport.provenance.contentHash,
      passport,
    };
  });

  intelligenceTaskQueue.registerHandler("buyer_intelligence", async (task) => {
    const payload = (task.payload || {}) as any;
    const activeDb = overrideDb || payload.db || payload.firestoreDb || (intelligenceTaskQueue as any).firestoreDb || db;
    if (!activeDb) {
      throw new Error("[BuyerIntelligence Task] Firestore DB reference is required");
    }

    const targetPropertyId = payload.propertyId || task.aggregateId;
    if (!targetPropertyId) {
      throw new Error("[BuyerIntelligence Task] Missing propertyId");
    }

    const { provenance, isVerifiedServerAction, requestingUserRole } = payload;
    const input: GenerateBuyerIntelligenceInput = {
      propertyId: targetPropertyId,
      provenance,
      requestingUserRole,
    };

    const service = new BuyerIntelligenceService({ firestoreDb: activeDb });
    const assessment = await service.generateBuyerIntelligence(input, {
      firestoreDb: activeDb,
      isVerifiedServerAction: !!isVerifiedServerAction,
    });

    return {
      success: true,
      propertyId: assessment.propertyId,
      assessmentId: assessment.provenance.assessmentId,
      contentHash: assessment.provenance.contentHash,
      assessment,
    };
  });
}

const configCache = new Map<string, any>();
const cacheUnsubscribers = new Map<string, () => void>();

async function getCachedConfig(docId: string): Promise<any> {
  // Return instantly from memory cache if already registered and loaded
  if (configCache.has(docId)) {
    return configCache.get(docId) ?? null;
  }

  // If db exists and we don't have a listener, set up a real-time listener
  if (db) {
    if (!cacheUnsubscribers.has(docId)) {
      await new Promise<void>((resolve) => {
        let isResolved = false;
        try {
          const unsub = db!.collection("platform_config").doc(docId).onSnapshot(
            (docSnap) => {
              const data = docSnap.exists ? docSnap.data() : null;
              configCache.set(docId, data);
              if (docId === "global") {
                invalidateMaintenanceCache(Boolean(data?.maintenanceMode === true));
              }
              if (!isResolved) {
                isResolved = true;
                resolve();
              }
            },
            (error: any) => {
              const msg = error?.message || String(error);
              if (error?.code !== 7 && !msg.includes("7") && !msg.includes("PERMISSION_DENIED") && !msg.includes("Missing or insufficient permissions") && !msg.includes("UNAUTHENTICATED") && !msg.includes("Could not load the default credentials")) {
                console.error(`Real-time config listener error for ${docId}:`, error);
              }
              if (!isResolved) {
                isResolved = true;
                resolve();
              }
            }
          );
          cacheUnsubscribers.set(docId, unsub);
        } catch (err: any) {
          const msg = err?.message || String(err);
          if (err?.code !== 7 && !msg.includes("7") && !msg.includes("PERMISSION_DENIED") && !msg.includes("Missing or insufficient permissions") && !msg.includes("UNAUTHENTICATED") && !msg.includes("Could not load the default credentials")) {
            console.error(`Failed to register real-time config listener for ${docId}:`, err);
          }
          isResolved = true;
          resolve();
        }
      });
    }
    return configCache.get(docId) ?? null;
  }

  return null;
}

// Scheduled task: Daily Profitability Aggregation
async function runDailyAggregation() {
  if (!db) return;
  if (await isMaintenanceModeActive({ db })) {
    console.log("[Maintenance] Daily aggregation skipped (maintenance mode active).");
    return;
  }
  console.log("Running daily profitability aggregation...");
  try {
    // Only fetch tradespeople
    const usersSnapshot = await db.collection("users")
      .where("role", "==", "tradesperson")
      .get();
    
    for (const userDoc of usersSnapshot.docs) {
      const uid = userDoc.id;
      
      // Calculate Revenue
      let totalRevenue = 0;
      const quotesSnapshot = await db.collectionGroup("quotes")
        .where("tradespersonId", "==", uid)
        .where("status", "==", "accepted")
        .get();
      quotesSnapshot.forEach(doc => { totalRevenue += doc.data().amount || 0; });

      // Calculate Spend
      let totalSpend = 0;
      let shopSavings = 0;
      const ordersSnapshot = await db.collection("shop_orders")
        .where("userId", "==", uid)
        .get();
      ordersSnapshot.forEach(doc => { 
        const orderData = doc.data();
        totalSpend += orderData.totalAmount || 0;
        shopSavings += orderData.savingsAmount || 0; // Track shop-specific savings
      });

      try {
        await db.collection("user_profitability_daily").doc(uid).set({
          totalRevenue,
          totalSpend,
          shopSavings,
          orderCount: ordersSnapshot.size,
          netProfit: totalRevenue - totalSpend,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (e: any) {
        const msg = e?.message || String(e);
        if (!msg.includes("PERMISSION_DENIED") && !msg.includes("UNAUTHENTICATED") && !msg.includes("Could not load the default credentials")) {
          console.error(`Error updating profitability for ${uid}:`, e);
        }
      }
    }
    console.log("Daily profitability aggregation completed.");
  } catch (error: any) {
    const msg = error?.message || String(error);
    if (!msg.includes("PERMISSION_DENIED") && !msg.includes("UNAUTHENTICATED") && !msg.includes("Could not load the default credentials")) {
      console.error("Error in daily aggregation:", error);
    }
  }
}

// Distributed Cron Lease Locking Helper (Fail-Closed + Heartbeat Fencing)
async function acquireCronLock(jobName: string, lockDurationMs: number = 60000): Promise<boolean> {
  const res = await acquireSchedulerLock(db, jobName, lockDurationMs);
  return res.acquired;
}

async function runWithSchedulerLease<T>(
  jobName: string,
  lockDurationMs: number,
  work: (leaseCtx: { isFenced: () => boolean }) => Promise<T>
): Promise<{ acquired: boolean; fencedOut: boolean; reason?: string; result?: T }> {
  const lease = await acquireSchedulerLock(db, jobName, lockDurationMs);
  if (!lease.acquired || !lease.leaseToken) {
    return { acquired: false, fencedOut: false, reason: lease.reason || "lock_unavailable" };
  }

  let fencedOut = false;
  const heartbeatEveryMs = Math.max(2000, Math.floor(lockDurationMs / 3));
  const timer = setInterval(async () => {
    const hb = await renewSchedulerLeaseHeartbeat(db, jobName, lease.leaseToken, lockDurationMs);
    if (!hb.renewed && hb.fencedOut) {
      fencedOut = true;
      console.warn(`[SchedulerLease] Worker '${jobName}' fenced out (${hb.reason}); stopping iteration.`);
    }
  }, heartbeatEveryMs);
  if (typeof (timer as any).unref === "function") {
    (timer as any).unref();
  }

  try {
    const result = await work({ isFenced: () => fencedOut });
    return { acquired: true, fencedOut, result };
  } finally {
    clearInterval(timer);
    await releaseSchedulerLock(db, jobName, lease.leaseToken);
  }
}

// Scheduled task: Process SMS Queue (AT-ADMIN-OPS-03 strict Twilio config gate)
async function processSmsQueue() {
  const maintenanceActive = db ? await isMaintenanceModeActive({ db }) : false;
  if (maintenanceActive) {
    console.log("[Maintenance] SMS queue processing paused (maintenance mode active).");
  }
  return await processSmsQueueCommand({
    db,
    env: process.env,
    twilioFactory: (sid, token) => twilio(sid, token) as any,
    maintenanceActive,
  });
}

// Scheduled task: Background Orchestration for Automated Driver Payouts (AT-ADMIN-AUDIT-02)
async function runDriverPayoutOrchestration(initiatedBy?: {
  uid: string;
  email?: string;
  triggerSource?: "manual_admin" | "cron" | "approval_execution";
  reason?: string;
  approvalRequestId?: string;
}) {
  if (!db) return { success: false, error: "Firebase not initialized" };
  if (await isMaintenanceModeActive({ db })) {
    console.log("[Maintenance] Driver payout orchestration paused (maintenance mode active).");
    return { success: false, pausedByMaintenance: true, processed: 0 };
  }
  let stripe: any = null;
  try {
    stripe = getStripe();
  } catch (e) {
    console.warn("Stripe missing in orchestrator. Running in mock/verification mode.");
  }

  return await executeDriverPayoutOrchestrationCommand({
    db,
    stripeClient: stripe,
    initiatedBy: initiatedBy || {
      uid: "system_cron",
      email: "cron@anytrader.internal",
      triggerSource: "cron",
      reason: "Scheduled driver payout orchestration",
    },
    logger: console,
  });
}

// Scheduled task: Consultancy Recurring Session Creator (AT-CONS-SCHED-01 real worker + error propagation)
async function runConsultancyRecurringSessionCreator() {
  const maintenanceActive = db ? await isMaintenanceModeActive({ db }) : false;
  if (maintenanceActive) {
    console.log("[Maintenance] Consultancy recurring session creator paused (maintenance mode active).");
  }
  return await runConsultancyRecurringSessionCreatorCommand(db, { maintenanceActive });
}

// Scheduled task: Consultancy Match Score Recalculator (AT-CONS-SCHED-01 real worker + error propagation)
async function runConsultancyScoreRecalculator() {
  const maintenanceActive = db ? await isMaintenanceModeActive({ db }) : false;
  if (maintenanceActive) {
    console.log("[Maintenance] Consultancy match score recalculator paused (maintenance mode active).");
  }
  return await runConsultancyScoreRecalculatorCommand(db, { maintenanceActive });
}

// Scheduled task: Autonomous Compliance Guardian Audit (Real Firestore Counts)
async function runComplianceGuardianAudit() {
  if (!db) return;
  if (await isMaintenanceModeActive({ db })) {
    console.log("[Maintenance] Compliance Guardian audit paused (maintenance mode active).");
    return;
  }
  console.log("🤖 Running Compliance Guardian audit...");
  try {
    const [tradersSnap, propertiesSnap] = await Promise.all([
      db.collection("users").where("role", "==", "tradesperson").limit(200).get(),
      db.collection("properties").limit(200).get(),
    ]);
    const unverifiedTraders = tradersSnap.docs.filter((d) => !d.data().idVerified && !d.data().verifiedTrader).length;
    const expiringGasSafe = tradersSnap.docs.filter((d) => {
      const exp = d.data().gasSafeExpiry;
      return exp && Date.parse(exp) - Date.now() <= 30 * 86_400_000;
    }).length;
    const expiringCp12 = propertiesSnap.docs.filter((d) => {
      const exp = d.data().cp12Expiry;
      return exp && Date.parse(exp) - Date.now() <= 30 * 86_400_000;
    }).length;

    await db.collection("ai_agent_audit_logs").add({
      agentType: "compliance_guardian",
      action: "AUTONOMOUS_CRON_AUDIT",
      details: `Audited ${propertiesSnap.size} properties (${expiringCp12} CP12 due <=30d) and ${tradersSnap.size} traders (${unverifiedTraders} unverified, ${expiringGasSafe} Gas Safe due <=30d).`,
      metrics: {
        propertiesAudited: propertiesSnap.size,
        expiringCp12,
        tradersAudited: tradersSnap.size,
        unverifiedTraders,
        expiringGasSafe,
      },
      timestamp: new Date().toISOString(),
      status: "success",
      triggerSource: "autonomous_cron"
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (!msg.includes("PERMISSION_DENIED") && !msg.includes("UNAUTHENTICATED") && !msg.includes("Could not load the default credentials")) {
      console.warn("Compliance guardian audit error:", e);
    }
  }
}

// Scheduled task: Autonomous Sentinel Guard Anomaly Scan (Real Firestore Telemetry)
async function runSentinelAnomalyScan() {
  if (!db) return;
  if (await isMaintenanceModeActive({ db })) {
    console.log("[Maintenance] Sentinel Guard anomaly scan paused (maintenance mode active).");
    return;
  }
  console.log("🛡️ Running Sentinel Guard anomaly check...");
  try {
    const usersSnap = await db.collection("users").limit(200).get();
    const phoneCounts: Record<string, number> = {};
    const disposableDomains = new Set(["mailinator.com", "tempmail.com", "10minutemail.com", "guerrillamail.com", "trashmail.com"]);
    let disposableEmailCount = 0;

    usersSnap.docs.forEach((d) => {
      const u = d.data() || {};
      const emailDomain = typeof u.email === "string" ? u.email.split("@")[1]?.toLowerCase() : "";
      if (emailDomain && disposableDomains.has(emailDomain)) disposableEmailCount++;
      const phone = typeof (u.phone || u.phoneNumber) === "string" ? (u.phone || u.phoneNumber).replace(/\s+/g, "") : "";
      if (phone.length > 5) {
        phoneCounts[phone] = (phoneCounts[phone] || 0) + 1;
      }
    });

    const duplicatePhoneClusters = Object.values(phoneCounts).filter((c) => c > 1).length;

    await db.collection("ai_agent_audit_logs").add({
      agentType: "sentinel_guard",
      action: "AUTONOMOUS_ANOMALY_SCAN",
      details: `Scanned ${usersSnap.size} user accounts: ${duplicatePhoneClusters} duplicate phone cluster(s), ${disposableEmailCount} disposable email(s).`,
      metrics: {
        scannedUsers: usersSnap.size,
        duplicatePhoneClusters,
        disposableEmailCount,
      },
      timestamp: new Date().toISOString(),
      status: "success",
      triggerSource: "autonomous_cron"
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (!msg.includes("PERMISSION_DENIED") && !msg.includes("UNAUTHENTICATED") && !msg.includes("Could not load the default credentials")) {
      console.warn("Sentinel anomaly scan error:", e);
    }
  }
}

// In-process Background Schedulers Starter
const startBackgroundSchedulers = () => {
  if (process.env.DISABLE_IN_PROCESS_CRON === "true") {
    console.log("In-process background cron schedulers disabled (external Cloud Scheduler mode active).");
    return;
  }

  // 1. Run SMS processor every minute
  cron.schedule("* * * * *", async () => {
    await runWithSchedulerLease("sms_queue", 45000, async () => processSmsQueue());
  });

  // 1b. Run 4-tier WhatsApp offline fallback processor every minute (45s unread check + 5-min cooldown)
  cron.schedule("* * * * *", async () => {
    await runWithSchedulerLease("whatsapp_fallback_queue", 30000, async () =>
      processWhatsAppFallbackQueue(db)
    );
  });

  // 2. Schedule: 00:30 every day for profitability aggregation
  cron.schedule("30 0 * * *", async () => {
    await runWithSchedulerLease("daily_aggregation", 300000, async () => runDailyAggregation());
  });

  // 3. Schedule: 01:00 every day for driver payouts
  cron.schedule("0 1 * * *", async () => {
    await runWithSchedulerLease("driver_payouts", 300000, async () => runDriverPayoutOrchestration());
  });

  // 4. Schedule: 02:00 every day for recurring sessions
  cron.schedule("0 2 * * *", async () => {
    await runWithSchedulerLease("recurring_sessions", 300000, async () => runConsultancyRecurringSessionCreator());
  });

  // 5. Schedule: 02:30 every day for matching scores
  cron.schedule("30 2 * * *", async () => {
    await runWithSchedulerLease("match_scores", 300000, async () => runConsultancyScoreRecalculator());
  });

  // 6. 06:00 Daily Compliance Guardian Audit
  cron.schedule("0 6 * * *", async () => {
    await runWithSchedulerLease("compliance_audit", 300000, async () => runComplianceGuardianAudit());
  });

  // 7. Every 2 hours Sentinel Anomaly Scan
  cron.schedule("0 */2 * * *", async () => {
    await runWithSchedulerLease("sentinel_scan", 300000, async () => runSentinelAnomalyScan());
  });

  // 8. Every 2 hours Continuous Refund Aggregate Drift Reconciliation (AT-PAY-07)
  cron.schedule("15 */2 * * *", async () => {
    await runWithSchedulerLease("refund_reconciliation", 180000, async () =>
      reconcilePaymentRefundAggregates(db, getOptionalStripeClient())
    );
  });

  // 9. Every 30 minutes Stale Stripe Checkout Intent Sweeper (AT-PAY-15)
  cron.schedule("*/30 * * * *", async () => {
    await runWithSchedulerLease("sweep_payment_intents", 120000, async () =>
      sweepStaleCheckoutIntents({ db, stripeClient: getOptionalStripeClient() })
    );
  });

  // 10. Every 15 minutes Publish Mature Cooling-Off Reviews
  cron.schedule("*/15 * * * *", async () => {
    await runWithSchedulerLease("cooling_off_reviews", 120000, async () =>
      publishMatureCoolingOffReviewsCommand(db)
    );
  });

  // 11. Every 15 minutes Low-Quote Lead Wave 2 Radius Expansion
  cron.schedule("*/15 * * * *", async () => {
    await runWithSchedulerLease("lead_wave_expansion", 60000, async () =>
      expandLowQuoteJobsWave2({
        db,
        extraRadiusMiles: 10,
        maxJobsPerRun: 25,
        dispatchFcmPush: (payload) => dispatchAuthoritativeFcmPush(db!, getFirebaseMessagingClient(), payload),
      })
    );
  });
};

const getFirebaseMessagingClient = () => {
  try {
    if (admin.apps.length > 0 && typeof admin.messaging === "function") {
      return admin.messaging();
    }
  } catch {
    // Unconfigured FCM environment — strict gate handles honestly
  }
  return null;
};

// Decoupled Matching Engine Cycle Execution
async function runMatchingCycle(leaseCtx?: { isFenced: () => boolean }) {
  if (!db) return;
  if (leaseCtx?.isFenced()) return;
  if (await isMaintenanceModeActive({ db })) {
    console.log("[Maintenance] Matching cycle paused (maintenance mode active).");
    return;
  }
  try {
    console.log("Polling trader_notifications...");
      
      // Use a try-catch for the specific collection query
      let snapshot;
      try {
        snapshot = await db.collection("trader_notifications")
          .where("processed", "==", false)
          .get();
      } catch (err: any) {
        if (err.code === 5 || err.message?.includes('NOT_FOUND')) {
          console.info("trader_notifications collection not found (expected if empty).");
        } else if (err.code === 7 || err.message?.includes('PERMISSION_DENIED')) {
          console.warn("Matching System: Permission Denied. Skipping this iteration.");
        } else {
          console.error("Error querying trader_notifications:", err);
        }
        return; 
      }
        
      if (snapshot.docs.length > 0) {
        console.log(`Found ${snapshot.docs.length} notifications.`);
      }

      // Fetch global config for monetization check
      let globalConfig: any = { paywallEnabled: true };
      try {
        const cachedGlobal = await getCachedConfig("global");
        if (cachedGlobal) {
          globalConfig = cachedGlobal;
        }
      } catch (err) {
        console.error("Error fetching global config:", err);
      }
      
      // 3. AnyTrader Rides Dispatch Logic (Fairness Engine)
      try {
        const cachedRides = await getCachedConfig("rides");
        const maxDailyDriverHours = cachedRides && cachedRides.maxDailyDriverHours 
          ? cachedRides.maxDailyDriverHours 
          : 12;

        const pendingRidesSnapshot = await db.collection("ride_requests")
          .where("status", "==", "pending")
          .get();

        for (const rideDoc of pendingRidesSnapshot.docs) {
          if (leaseCtx?.isFenced()) break;
          const ride = rideDoc.data();
          const pickupLat = ride.pickupLat; 
          const pickupLng = ride.pickupLng;
          const dropoffLat = ride.dropoffLat;
          const dropoffLng = ride.dropoffLng;
          
          if (pickupLat && pickupLng) {
            // Find ALL online drivers
            const onlineDriversSnapshot = await db.collection("driver_status")
              .where("online", "==", true)
              .get();
              
            if (onlineDriversSnapshot.empty) continue;

            let bestDriver: any = null;
            let highestScore = -1000;

            const declinedSet = new Set<string>([
              ...(Array.isArray(ride.declinedDriverIds) ? ride.declinedDriverIds : []),
              ...(Array.isArray(ride.declinedBy) ? ride.declinedBy : []),
            ].map((id: any) => String(id)));

            for (const statusDoc of onlineDriversSnapshot.docs) {
              const driverId = statusDoc.id;
              const statusData = statusDoc.data();
              
              // Skip if busy, already considering an offer, or previously declined this ride
              if (statusData.isBusy) continue;
              if (statusData.pendingRideId && statusData.pendingRideId !== rideDoc.id) continue;
              if (declinedSet.has(driverId)) continue;

              // 1. Get Live Tracking (Distance)
              const trackingDoc = await db.collection("live_tracking").doc(driverId).get();
              if (!trackingDoc.exists) continue;
              const dL = trackingDoc.data()!;

              // 2. Get Performance Metrics & User Preferences
              const metricsRef = db.collection("driver_metrics").doc(driverId);
              let metrics: any = { dailyEarnings: 0, lastAssignmentAt: new Date(0).toISOString() };
              const mDoc = await metricsRef.get();
              if (mDoc.exists) metrics = mDoc.data()!;

              const userDoc = await db.collection("users").doc(driverId).get();
              const userData = userDoc.exists ? userDoc.data()! : {};

              // --- MAX HOURS CHECK ---
              if (metrics.onlineSecondsToday && (metrics.onlineSecondsToday / 3600) >= maxDailyDriverHours) {
                  continue; // Skip driver, exceeded daily hours
              }

              // --- ZONES CHECK ---
              if (userData.zoneEnabled && userData.zoneMaxDistance && userData.homeLat && userData.homeLng) {
                 const R = 3959; // Radius of Earth in miles
                 const toRad = (value: number) => value * Math.PI / 180;
                 // Function to calc miles distance
                 const calcDist = (lat1: number, lon1: number, lat2: number, lon2: number) => {
                    const dLat = toRad(lat2 - lat1);
                    const dLon = toRad(lon2 - lon1);
                    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * 
                              Math.sin(dLon/2) * Math.sin(dLon/2);
                    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                    return R * c;
                 };
                 
                 const distPickup = calcDist(userData.homeLat, userData.homeLng, pickupLat, pickupLng);
                 // Only check dropoff distance if we have dropoff coordinates
                 let distDropoff = 0;
                 if (dropoffLat && dropoffLng) {
                     distDropoff = calcDist(userData.homeLat, userData.homeLng, dropoffLat, dropoffLng);
                 }
                 
                 if (distPickup > userData.zoneMaxDistance || (dropoffLat && distDropoff > userData.zoneMaxDistance)) {
                     continue; // Driver configured bounds exceeded, skip this driver
                 }
              }

              // Calculate Haversine distance (approximate simple version)
              const latDiff = Math.abs(dL.lat - pickupLat);
              const lonDiff = Math.abs(dL.lng - pickupLng);
              const distance = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff);
              
              /**
               * FAIRNESS SCORING FORMULA
               * Proximity (40%): Reward nearby drivers.
               * Poverty/Fairness (30%): Help drivers with low daily earnings.
               * Idle Reward (30%): Reward drivers who have waited the longest.
               */
              const distanceScore = 1 / (distance + 0.05); // Boost close ones (capped at 20)
              const earningsScore = 1 / ((metrics.dailyEarnings / 100) + 1); // Decay as earnings grow
              const idleTimeSec = (Date.now() - new Date(metrics.lastAssignmentAt).getTime()) / 1000;
              const idleScore = Math.min(idleTimeSec / 3600, 5); // 1 point per hour, capped at 5

              // Normalize scores for weight application
              const score = (distanceScore * 0.4) + (earningsScore * 0.3) + (idleScore * 0.3);

              if (score > highestScore) {
                highestScore = score;
                bestDriver = driverId;
              }
            }

            if (bestDriver) {
              console.log(`Dispatching Ride ${rideDoc.id} to Driver ${bestDriver} (Score: ${highestScore.toFixed(2)})`);
              const nowMs = Date.now();
              const expiresAtMs = nowMs + 15000;
              
              // Move to 'offered' state with 15s timer
              await rideDoc.ref.update({ 
                status: "offered", 
                assignedDriverId: bestDriver,
                offerExpiresAt: new Date(expiresAtMs).toISOString(),
                dispatchAttempts: admin.firestore.FieldValue.increment(1),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });

              // Mark driver as temporarily considering (merge: true avoids NotFound if doc is newly created)
              await db.collection("driver_status").doc(bestDriver).set({
                pendingRideId: rideDoc.id,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              }, { merge: true });

              // P0-6: Wake native Android & Web drivers via high-priority FCM push
              const fareEstimateNum = Number(ride.estimatedFare ?? ride.fare ?? 0);
              const fareStr = Number.isFinite(fareEstimateNum) && fareEstimateNum > 0
                ? fareEstimateNum.toFixed(2)
                : "";
              const pickupAddress = String(ride.pickupAddress || "Nearby pickup");
              const dropoffAddress = String(ride.dropoffAddress || "");
              const vehicleCategory = String(ride.vehicleCategory || ride.carCategory || "Standard");
              const surgeMultiplier = Number(ride.surgeMultiplier || 1);

              void dispatchAuthoritativeFcmPush(db, getFirebaseMessagingClient(), {
                recipientId: bestDriver,
                title: fareStr ? `New Ride Offer — £${fareStr}` : "New Ride Offer Nearby",
                body: dropoffAddress
                  ? `${pickupAddress} → ${dropoffAddress}`
                  : `Pickup: ${pickupAddress}`,
                channelId: RIDE_OFFER_CHANNEL_ID,
                eventType: "ride_offer",
                data: {
                  type: "ride_offer",
                  rideId: rideDoc.id,
                  pickupAddress,
                  dropoffAddress,
                  pickupLat: String(pickupLat ?? ""),
                  pickupLng: String(pickupLng ?? ""),
                  dropoffLat: String(dropoffLat ?? ""),
                  dropoffLng: String(dropoffLng ?? ""),
                  fareEstimate: fareStr,
                  surgeMultiplier: String(surgeMultiplier),
                  vehicleCategory,
                  isPriority: String(Boolean(ride.isPriority)),
                  isPetFriendly: String(Boolean(ride.isPetFriendly || ride.petFriendly)),
                  offeredAtMs: String(nowMs),
                  expiresAtMs: String(expiresAtMs),
                  route: `/driver-terminal?rideId=${encodeURIComponent(rideDoc.id)}`,
                },
              });
            }
          }
        }

        // 4. Handle Expired Offers
        const expiredOffersSnapshot = await db.collection("ride_requests")
          .where("status", "==", "offered")
          .get();

        for (const rideDoc of expiredOffersSnapshot.docs) {
          if (leaseCtx?.isFenced()) break;
          const ride = rideDoc.data();
          if (ride.offerExpiresAt && new Date(ride.offerExpiresAt).getTime() < Date.now()) {
            console.log(`Offer for Ride ${rideDoc.id} expired. Auto-declining for driver ${ride.assignedDriverId}`);
            
            // Revert driver status (merge: true safe if doc absent)
            if (ride.assignedDriverId) {
              await db.collection("driver_status").doc(ride.assignedDriverId).set({
                pendingRideId: admin.firestore.FieldValue.delete(),
                consecutiveDeclines: admin.firestore.FieldValue.increment(1),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              }, { merge: true });
            }

            // Put ride back in pool & record timed-out driver to prevent immediate re-offer loop
            const expiredPatch: Record<string, any> = {
              status: "pending",
              assignedDriverId: admin.firestore.FieldValue.delete(),
              offerExpiresAt: admin.firestore.FieldValue.delete(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            };
            if (ride.assignedDriverId) {
              expiredPatch.declinedDriverIds = admin.firestore.FieldValue.arrayUnion(ride.assignedDriverId);
              expiredPatch.declinedBy = admin.firestore.FieldValue.arrayUnion(ride.assignedDriverId);
            }
            await rideDoc.ref.update(expiredPatch);
          }
        }
      } catch (err) {
        console.error("Error in Fairness Dispatch Engine:", err);
      }
      
      // Unified AnyTrader Lead Distribution Bridge (replaces legacy unverified 2-char postcode loop)
      const messagingClientForCycle = getFirebaseMessagingClient();
      const dispatchFcmForCycle = (payload: {
        recipientId: string;
        title: string;
        body: string;
        channelId: string;
        eventType: string;
        data: Record<string, string>;
      }) => dispatchAuthoritativeFcmPush(db!, messagingClientForCycle, payload);

      for (const doc of snapshot.docs) {
        if (leaseCtx?.isFenced()) break;
        const notification = doc.data() || {};
        if (notification.jobId) {
          try {
            await distributeJobLeadsAuthoritative({
              db,
              jobId: String(notification.jobId),
              maxRecipients: 25,
              wave: 1,
              dispatchFcmPush: dispatchFcmForCycle,
            });
          } catch (err) {
            console.error(`Error distributing leads for legacy notification ${doc.id}:`, err);
          }
        }

        // Mark as processed
        try {
          await doc.ref.update({ processed: true });
        } catch (err) {
          console.error("Error marking notification as processed:", err);
        }
      }

      // Dynamic Wave 2 Radius Expansion (throttled to once every 5 minutes inside matching cycle)
      const nowMsForWave2 = Date.now();
      const lastWave2RunMs = (globalThis as any).__anytraderLastWave2RunMs || 0;
      if (!leaseCtx?.isFenced() && nowMsForWave2 - lastWave2RunMs >= 5 * 60 * 1000) {
        (globalThis as any).__anytraderLastWave2RunMs = nowMsForWave2;
        await expandLowQuoteJobsWave2({
          db,
          nowMs: nowMsForWave2,
          extraRadiusMiles: 10,
          maxJobsPerRun: 15,
          dispatchFcmPush: dispatchFcmForCycle,
        }).catch((err) => console.warn("Wave 2 low-quote expansion warning:", err));
      }
  } catch (error: any) {
    const msg = error?.message || String(error);
    if (!msg.includes("PERMISSION_DENIED") && !msg.includes("UNAUTHENTICATED")) {
      console.error("Error in matching logic cycle:", error);
    }
  }
}

// Matching logic listener starter
const startMatchingSystem = async () => {
  if (!db) {
    console.error("Firebase not initialized, matching system disabled.");
    return;
  }
  if (process.env.DISABLE_IN_PROCESS_CRON === "true") {
    console.log("In-process matching system worker disabled (external Cloud Scheduler / Cloud Run Job mode active).");
    return;
  }
  console.log("Starting server-side matching system loop...");
  setInterval(async () => {
    await runWithSchedulerLease("matching_system", 12000, async (leaseCtx) => {
      await runMatchingCycle(leaseCtx);
    });
  }, 10000);
};

// Stripe initialization
let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY environment variable is required');
    }
    stripeClient = new Stripe(key, { apiVersion: '2025-02-24.acacia' });
  }
  return stripeClient;
}

function getOptionalStripeClient(): Stripe | undefined {
  try {
    return getStripe();
  } catch {
    return undefined;
  }
}

// --- Authentication Middlewares ---
async function verifyTokenSafely(token: string) {
  return verifyFirebaseIdTokenWithRevocation(token, {
    adminAuth: admin.auth(),
    getDb: () => db || (admin.apps.length > 0 ? admin.firestore() : null),
  });
}

/**
 * Server-authoritative check verifying if a caller holds administrator privileges.
 * Strictly trusts ONLY server-controlled evidence:
 * 1. Firebase Custom User Claims (admin: true, isAdmin: true)
 * 2. Firestore 'admins' collection record (admins/{uid})
 * Untrusted client fields or user document 'role' fields are strictly ignored to prevent privilege escalation.
 */
export async function checkIsAdmin(user: any): Promise<boolean> {
  if (!user || !user.uid) return false;

  // 1. Primary check: Firebase Custom User Claims (server-minted only)
  if (user.admin === true || user.isAdmin === true) {
    return true;
  }

  // 2. Secondary check: Server-authoritative admins collection
  if (db) {
    try {
      const adminDoc = await db.collection("admins").doc(user.uid).get();
      if (adminDoc.exists) {
        return true;
      }
    } catch (dbErr: any) {
      const msg = dbErr?.message || String(dbErr);
      if (
        !msg.includes("PERMISSION_DENIED") &&
        !msg.includes("UNAUTHENTICATED") &&
        !msg.includes("Could not load the default credentials") &&
        dbErr?.code !== 7
      ) {
        console.warn("[Admin Check Warning] Firestore fallback lookup failed due to permissions/network:", dbErr);
      }
    }
  }

  return false;
}

const requireAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: missing token" });
  }
  const token = authHeader.split("Bearer ")[1];
  try {
    const decodedToken = await verifyTokenSafely(token);
    (req as any).user = decodedToken;
    next();
  } catch (error) {
    console.error("Token err:", error); return res.status(401).json({ error: "Unauthorized: invalid or revoked token" });
  }
};

const requireAdmin = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  let decodedToken = (req as any).user;
  if (!decodedToken) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized: missing token" });
    }
    const token = authHeader.split("Bearer ")[1];
    try {
      decodedToken = await verifyTokenSafely(token);
      (req as any).user = decodedToken;
    } catch (error) {
      console.error("Admin Token err:", error);
      return res.status(401).json({ error: "Unauthorized: invalid or revoked token" });
    }
  }

  try {
    const isAdmin = await checkIsAdmin(decodedToken);
    if (!isAdmin) {
      return res.status(403).json({ error: "Forbidden: requires admin privileges" });
    }

    // AT-ADMIN-AUTH-01: Resolve explicit admin capability tier (support_readonly | financial_operator | super_admin)
    let userDocData: Record<string, any> | null = null;
    let adminDocData: Record<string, any> | null = null;
    if (db && decodedToken?.uid) {
      try {
        const [userSnap, adminSnap] = await Promise.all([
          db.collection("users").doc(decodedToken.uid).get(),
          db.collection("admins").doc(decodedToken.uid).get(),
        ]);
        if (userSnap.exists) {
          userDocData = userSnap.data() || null;
        }
        if (adminSnap.exists) {
          adminDocData = adminSnap.data() || null;
        }
      } catch {
        // Non-blocking fallback to token claims
      }
    }
    const adminTier = resolveAdminCapabilityTier(decodedToken, userDocData, adminDocData);
    (req as any).adminTier = adminTier;
    (req as any).adminActor = {
      uid: decodedToken.uid,
      email: decodedToken.email || userDocData?.email || "",
      tier: adminTier,
    } as AdminActor;

    // Auto-migrate verified admin by applying custom claim (including explicit adminTier) if missing or drifted
    if (decodedToken.admin !== true || decodedToken.isAdmin !== true || decodedToken.adminTier !== adminTier) {
      try {
        const userRecord = await admin.auth().getUser(decodedToken.uid);
        const currentClaims = userRecord.customClaims || {};
        await admin.auth().setCustomUserClaims(decodedToken.uid, {
          ...currentClaims,
          admin: true,
          isAdmin: true,
          adminTier,
        });
      } catch (claimErr) {
        // Non-blocking if identity toolkit is disabled
      }
    }

    next();
  } catch (error) {
    console.error("Admin check err:", error);
    return res.status(500).json({ error: "Internal server error during admin validation" });
  }
};

const requireAdminTier = (requiredTier: AdminCapabilityTier, actionLabel?: string) => {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const actor: AdminActor = (req as any).adminActor || {
        uid: (req as any).user?.uid,
        email: (req as any).user?.email,
        tier: (req as any).adminTier || "support_readonly",
      };
      assertAdminCapability(actor, requiredTier, actionLabel);
      next();
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  };
};

const timingSafeEqualStr = (a: string, b: string) => {
  try {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
};

const requireCronOrAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret && process.env.NODE_ENV === "production") {
    return res.status(500).json({ error: "Server misconfiguration: CRON_SECRET not set" });
  }

  const authHeader = req.headers.authorization;
  const providedSecret = (req.headers["x-cron-secret"] as string) || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined);

  if (cronSecret && providedSecret && timingSafeEqualStr(providedSecret, cronSecret)) {
    return next();
  }
  return requireAdmin(req, res, next);
};


async function startServer() {
  const app = express();
  // Set trust proxy to 1 (trust single reverse proxy hop from Nginx / Cloud Run ingress)
  app.set("trust proxy", 1);
  const PORT = Number(process.env.PORT) || 3000;

  const isProd = process.env.NODE_ENV === "production";
  const isAiStudioContainer = Boolean(
    process.env.APPLET_ID ||
    (process.env.K_SERVICE && process.env.K_SERVICE.startsWith("ais-"))
  );

  // Allowed Origins Configuration for Web, PWA, and Preview
  const defaultAllowedOrigins: string[] = isProd
    ? []
    : [
        "http://localhost:3000",
        "http://localhost:5173",
        "https://localhost",
      ];
  const configuredAppOrigins = [process.env.APP_URL, process.env.PUBLIC_APP_URL]
    .map((candidate) => {
      if (!candidate) return null;
      try {
        const parsed = new URL(candidate.trim());
        return parsed.protocol === "https:" || !isProd ? parsed.origin : null;
      } catch {
        return null;
      }
    })
    .filter((origin): origin is string => Boolean(origin));
  const envAllowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim()).filter(Boolean)
    : [];
  const allowedOriginsSet = new Set([
    ...defaultAllowedOrigins,
    ...configuredAppOrigins,
    ...envAllowedOrigins,
  ]);

  // Helper to validate origin strictly without substring hijacking vulnerabilities (e.g. evil-localhost.com)
  const isOriginAllowed = (origin: string, allowedSet: Set<string>): boolean => {
    if (allowedSet.has(origin)) {
      return true;
    }
    try {
      const parsed = new URL(origin);
      if (!isProd) {
        // Strict localhost check: hostname must be exactly localhost, 127.0.0.1, or ::1
        const isStrictLocalhost =
          parsed.hostname === "localhost" ||
          parsed.hostname === "127.0.0.1" ||
          parsed.hostname === "[::1]";
        if (isStrictLocalhost) {
          return true;
        }
      }
      // Preview container origins are permitted ONLY in non-production or AI Studio preview containers,
      // never in standalone production deployments (prevents multi-tenant *.run.app CORS exposure).
      if (
        (!isProd || isAiStudioContainer) &&
        parsed.protocol === "https:" &&
        (
          parsed.hostname.endsWith(".aistudio.google.com") ||
          parsed.hostname.endsWith(".ai.studio") ||
          (isAiStudioContainer && /^ais-(dev|pre)-[a-z0-9-]+\.run\.app$/i.test(parsed.hostname)) ||
          (!isProd && parsed.hostname.endsWith(".run.app"))
        )
      ) {
        return true;
      }
    } catch {
      return false;
    }
    return false;
  };

  // CORS middleware for Web and PWA clients
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      const isAllowed = isOriginAllowed(origin, allowedOriginsSet);

      if (isAllowed) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Vary", "Origin");
      }
    }
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control, Pragma, X-Firebase-AppCheck, stripe-signature"
    );
    
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }
    next();
  });

  // Production Security Headers: Comprehensive CSP, HSTS, Clickjacking Protection, MIME-sniffing defense, Referrer & Permissions Policies
  // Applied globally to all requests (pages, assets, and API endpoints)
  app.use((req, res, next) => {
    // 1. Strict-Transport-Security (HSTS): Enforce HTTPS connections for 1 year with subdomains and preload
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload"
    );

    // 2. Comprehensive Content-Security-Policy (CSP)
    const aiStudioConnectOrigins = (!isProd || isAiStudioContainer)
      ? " https://ais-dev-vumupz44ljjitc6rsqobbz-437256678397.europe-west2.run.app https://ais-pre-vumupz44ljjitc6rsqobbz-437256678397.europe-west2.run.app"
      : "";
    const frameAncestorsDirective = (!isProd || isAiStudioContainer)
      ? "frame-ancestors 'self' https://ais-dev-vumupz44ljjitc6rsqobbz-437256678397.europe-west2.run.app https://ais-pre-vumupz44ljjitc6rsqobbz-437256678397.europe-west2.run.app https://*.google.com https://ai.studio https://*.ai.studio https://studio.google.com https://*.googleusercontent.com https://*.usercontent.goog"
      : "frame-ancestors 'self'";

    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://apis.google.com https://*.googleapis.com https://*.gstatic.com https://js.stripe.com https://maps.googleapis.com https://*.firebaseapp.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "media-src 'self' data: blob: https:",
      `connect-src 'self' https://*.googleapis.com https://*.google.com https://*.firebaseio.com https://api.stripe.com https://*.cloudfunctions.net${aiStudioConnectOrigins} wss://*.firebaseio.com https://api.postcodes.io`,
      "frame-src 'self' https://js.stripe.com https://accounts.google.com https://*.firebaseapp.com https://*.google.com",
      frameAncestorsDirective,
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ');

    res.setHeader("Content-Security-Policy", csp);

    // 3. Clickjacking Protection fallback for legacy clients in standalone production
    // Skip X-Frame-Options in development / AI Studio preview containers where embedded framing is governed by CSP frame-ancestors.
    if (isProd && !isAiStudioContainer) {
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
    }

    // 4. MIME-type sniffing defense
    res.setHeader("X-Content-Type-Options", "nosniff");

    // 5. Referrer Policy
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    // 6. Permissions Policy
    res.setHeader(
      "Permissions-Policy",
      "geolocation=(self), microphone=(self), camera=(self)"
    );

    next();
  });

  // Normalizes client IP address, grouping IPv6 addresses into /64 prefix subnets to prevent rotation bypass
  function normalizeIpForRateLimiting(rawIp?: string): string {
    if (!rawIp) return "unknown-ip";
    const ip = rawIp.trim().replace(/^::ffff:/, ''); // strip IPv4-mapped IPv6 prefix
    if (ip.includes(':')) {
      // Group IPv6 addresses into /64 blocks (first 4 hextets)
      const parts = ip.split(':');
      return parts.slice(0, 4).join(':') + '::/64';
    }
    return ip;
  }

  // Rate limiters (UID first, grouped IPv6/IPv4 fallback)
  const limitKeyGenerator = (req: express.Request) => {
    return (req as any).user?.uid || normalizeIpForRateLimiting(req.ip || req.socket.remoteAddress);
  };

  // Distributed Firestore-backed rate limiters for multi-instance Cloud Run consistency (AT-ADMIN-OPS-06)
  const aiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 50,
    keyGenerator: limitKeyGenerator,
    store: new FirestoreRateLimitStore({ prefix: "ai", windowMs: 60_000, getDb: () => db }),
    validate: false,
    message: { error: "Too many AI requests, please try again after a minute" },
  });
  
  const paymentLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 50,
    keyGenerator: limitKeyGenerator,
    store: new FirestoreRateLimitStore({ prefix: "payment", windowMs: 60_000, getDb: () => db }),
    validate: false,
    message: { error: "Too many payment requests, please try again after a minute" },
  });

  const paymentAttemptAbuseLimiter = AbuseDefenseEngine.createMiddleware("PAYMENT_ATTEMPT");

  const postcodeLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 30,
    keyGenerator: limitKeyGenerator,
    store: new FirestoreRateLimitStore({ prefix: "postcode", windowMs: 60_000, getDb: () => db }),
    validate: false,
    message: { error: "Too many postcode lookups, please try again after a minute" },
  });
  
  // QR handshake PINs are low entropy: constrain release attempts independently of the
  // high-capacity general API limiter. Persistent per-job lockout is an additional control.
  const handshakeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: limitKeyGenerator,
    store: new FirestoreRateLimitStore({ prefix: "handshake", windowMs: 15 * 60_000, getDb: () => db }),
    validate: false,
    message: { error: "Too many escrow release attempts. Please wait 15 minutes." },
  });

  const reviewLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 10,
    keyGenerator: limitKeyGenerator,
    store: new FirestoreRateLimitStore({ prefix: "review", windowMs: 60_000, getDb: () => db }),
    validate: false,
    message: { error: "Too many review submissions, please try again shortly" },
  });

  const generalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 1000, // Bounded capacity for rapid navigation, polling, and iframe reloading
    keyGenerator: limitKeyGenerator,
    store: new FirestoreRateLimitStore({ prefix: "general", windowMs: 60_000, getDb: () => db }),
    validate: false,
    message: { error: "Too many requests, please try again after a minute" },
  });

  // Apply general limiter to all API routes
  app.use('/api/', generalLimiter);

  // Set anti-caching headers on all dynamic API endpoints
  app.use('/api/', (req, res, next) => {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store'
    });
    next();
  });

  // Meta WhatsApp Cloud API Webhook Verification & Inbound Handler (MUST come before express.json() for raw HMAC-SHA256 verification)
  app.get("/api/webhooks/whatsapp", (req, res) => {
    const cfg = getMetaWhatsAppConfig();
    const mode = String(req.query["hub.mode"] || "");
    const token = String(req.query["hub.verify_token"] || "");
    const challenge = String(req.query["hub.challenge"] || "");

    if (!cfg.verifyToken) {
      return res.status(503).send("WhatsApp webhook verification token not configured.");
    }
    const providedBuf = Buffer.from(token, "utf8");
    const expectedBuf = Buffer.from(cfg.verifyToken, "utf8");
    const tokenMatches =
      providedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(providedBuf, expectedBuf);

    if (mode === "subscribe" && tokenMatches && challenge) {
      return res.status(200).type("text/plain").send(challenge);
    }
    return res.status(403).send("Forbidden");
  });

  app.post("/api/webhooks/whatsapp", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const cfg = getMetaWhatsAppConfig();
      if (!cfg.appSecret) {
        return res.status(503).json({ error: "Meta WhatsApp webhook secret is not configured." });
      }
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body || ""), "utf8");
      const signature = req.headers["x-hub-signature-256"] as string | undefined;

      if (!verifyMetaWebhookSignature(rawBody, signature, cfg.appSecret)) {
        return res.status(401).json({ error: "Invalid webhook signature." });
      }

      let parsed: any = {};
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "Malformed JSON payload." });
      }

      const outcome = await handleMetaWhatsAppWebhook(db, parsed, { config: cfg });
      return res.status(200).json({ received: true, ...outcome });
    } catch (error: any) {
      console.error("Meta WhatsApp webhook error:", error);
      return res.status(500).json({ error: "Webhook processing failed." });
    }
  });

  // Stripe Webhook MUST come before express.json()
  app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    let event: Stripe.Event | undefined;
    let claimToken: string | null = null;
    let assignedWorkerId: string | undefined;
    try {
      let stripeClient;
      try {
        stripeClient = getStripe();
      } catch (e) {
        // If Stripe is not configured, we ignore the webhook
        console.warn("Stripe webhook received but Stripe is not configured.");
        return res.status(200).send("Ignored");
      }

      const sig = req.headers['stripe-signature'];
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!webhookSecret || !sig) {
        console.error("Stripe Webhook rejected: missing STRIPE_WEBHOOK_SECRET or stripe-signature header");
        return res.status(400).send("Webhook Error: Missing signature or webhook secret");
      }

      try {
        event = stripeClient.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (err: any) {
        console.error(`Webhook signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      // Handle the event
      if (!db) {
        console.error("[Stripe Webhook] Database unavailable; returning 503 so Stripe retries.");
        return res.status(503).json({ error: "Database service temporarily unavailable" });
      }

      // Idempotency: Use a transaction to atomically claim 'processing' state with stale-worker lease takeover
      const eventRef = db.collection("processed_stripe_events").doc(event.id);
      assignedWorkerId = `worker_${Math.random().toString(36).substring(7)}`;
      claimToken = crypto.randomUUID();
      try {
        const claimResult = await claimStripeEventLease(db, event.id, {
          workerId: assignedWorkerId,
          claimToken,
        });

        if (!claimResult.claimed) {
           return res.status(200).send("Already processed or currently processing");
        }
      } catch (txErr) {
        console.error("Webhook idempotency transaction error:", txErr);
        return res.status(500).send("Internal Error");
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === 'setup') {
          let syncResult = { updated: false, defaultPaymentMethodId: null as string | null };
          try {
            syncResult = await syncDefaultPaymentMethodFromSetupSession({ stripe: stripeClient, session });
          } catch (setupSyncErr) {
            console.warn(`[Webhook Warning] Failed to sync default payment method for setup session ${session.id}:`, setupSyncErr);
          }
          await db.runTransaction(async (tx: any) => {
            const claimSnap = await tx.get(eventRef);
            const claimData = claimSnap.data() || {};
            if (!ownsStripeWebhookClaim(claimData, claimToken)) {
              throw new Error('Webhook claim lost before setup-session completion.');
            }
            tx.update(eventRef, {
              status: 'completed',
              setupDefaultSynced: syncResult.updated,
              defaultPaymentMethodId: syncResult.defaultPaymentMethodId,
              claimToken: admin.firestore.FieldValue.delete()
            });
          });
          return res.status(200).json({ received: true, status: 'setup_completed', defaultUpdated: syncResult.updated });
        }
        if (session.payment_status !== 'paid') {
          console.warn(`[Webhook Warning] Checkout session ${session.id} completed with payment_status '${session.payment_status}'. Skipping fulfillment until paid.`);
          await db.runTransaction(async (tx: any) => {
              const claimSnap = await tx.get(eventRef);
              const claimData = claimSnap.data() || {};
              if (!ownsStripeWebhookClaim(claimData, claimToken)) {
                throw new Error('Webhook claim lost before checkout fulfillment mutation.');
              }
            const latest = await tx.get(eventRef);
            if (latest.data()?.claimToken !== claimToken || latest.data()?.status !== 'processing') throw new Error('Webhook claim lost before unpaid-event completion.');
            tx.update(eventRef, { status: 'completed', skippedReason: 'payment_not_paid', claimToken: admin.firestore.FieldValue.delete() });
          });
          return res.status(200).json({ received: true, status: 'skipped_unpaid' });
        }

        // Checkout fulfillment must be backed by the exact server-created intent.
        // Never fall back to Stripe session metadata when the authoritative record is absent.
        if (!db || !session.metadata?.intentId || !session.client_reference_id) {
          throw new Error("Checkout fulfillment rejected: authoritative intent or database binding is missing.");
        }
        const intentRef = db.collection("payment_intents").doc(session.metadata.intentId);
        const intentDoc = await intentRef.get();
        if (!intentDoc.exists) {
          throw new Error("Checkout fulfillment rejected: payment intent record was not found.");
        }
        const intent = intentDoc.data() || {};
        const bindingState = evaluateCheckoutIntentBinding(intent, session as any);
        if (bindingState === "pending") {
          // Stripe can deliver checkout.session.completed before the checkout route
          // persists the returned Session ID on the intent. Keep this retryable.
          throw new Error("Checkout intent binding is still being finalized; retry webhook processing.");
        }
        if (bindingState === "mismatch") {
          await db.runTransaction(async (tx: any) => {
            const [claimSnap, latestIntent] = await Promise.all([tx.get(eventRef), tx.get(intentRef)]);
            const claimData = claimSnap.data() || {};
            if (!ownsStripeWebhookClaim(claimData, claimToken)) {
              throw new Error('Webhook claim lost before checkout intent review mutation.');
            }
            if (latestIntent.exists) tx.update(intentRef, {
              status: "review_required",
              reviewReason: "checkout_session_intent_binding_mismatch",
              reviewSessionId: session.id,
              reviewAt: admin.firestore.FieldValue.serverTimestamp()
            });
          });
          throw new Error("Checkout fulfillment rejected: Stripe session does not match its authoritative payment intent.");
        }
        await db.runTransaction(async (tx: any) => {
          const [claimSnap, latestIntent] = await Promise.all([tx.get(eventRef), tx.get(intentRef)]);
          const claimData = claimSnap.data() || {};
          if (!ownsStripeWebhookClaim(claimData, claimToken)) {
            throw new Error('Webhook claim lost before checkout intent processing mutation.');
          }
          if (!latestIntent.exists) throw new Error('Checkout intent disappeared before processing.');
          tx.update(intentRef, {
            status: "processing",
            processingStartedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });
        const userId = intent.userId;
        const meta = intent.metadata || {};
          
          if ((meta?.isVideoPro === 'true' || meta?.type === 'video_pro_subscription') && userId && db) {
            if (session.mode !== "subscription" || typeof session.subscription !== "string" || !session.subscription) {
              throw new Error("Subscription fulfilment requires a valid Stripe Subscription ID.");
            }
            const subscriptionId = session.subscription;
            const periodEndIso = await resolveSubscriptionPeriodEndIso(stripeClient, subscriptionId);
            const userRef = db.collection("users").doc(userId);
            const markerRef = db.collection("stripe_fulfillments").doc(`video_pro_${session.id}`);
            await db.runTransaction(async (tx: any) => {
              const claimSnap = await tx.get(eventRef);
              const claimData = claimSnap.data() || {};
              if (!ownsStripeWebhookClaim(claimData, claimToken)) {
                throw new Error('Webhook claim lost before checkout fulfillment mutation.');
              }
              const [userSnap, markerSnap] = await Promise.all([tx.get(userRef), tx.get(markerRef)]);
              if (!userSnap.exists) throw new Error("Video Pro subscription user does not exist.");
              if (markerSnap.exists) return;
              const current = userSnap.data() || {};
              if (!canReplaceLinkedSubscription({
                existingSubscriptionId: current.videoProSubscriptionId,
                incomingSubscriptionId: subscriptionId,
                existingStatus: current.videoProSubscriptionStatus,
                isCurrentlyActive: current.hasVerifiedVideoProSubscription,
              })) {
                throw new Error("A different active Video Pro subscription is already linked; manual reconciliation required.");
              }
              // Video verification credential is strictly moderated by admin; subscription purchase must never bypass review.
              tx.update(userRef, {
                hasVerifiedVideoProSubscription: true,
                videoProSubscriptionStatus: "active",
                videoProCancelAtPeriodEnd: false,
                videoProSubscribedAt: current.videoProSubscribedAt || new Date().toISOString(),
                videoProSubscriptionId: subscriptionId,
                ...(periodEndIso ? { videoProCurrentPeriodEnd: periodEndIso } : {}),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
              tx.create(markerRef, { eventId: event.id, sessionId: session.id, subscriptionId, userId, type: "video_pro_subscription", createdAt: admin.firestore.FieldValue.serverTimestamp() });
            });
            try {
              const pubRef = db.collection("public_profiles").doc(userId);
              const pubSnap = await pubRef.get();
              if (pubSnap.exists) {
                await pubRef.update({
                  hasVerifiedVideoProSubscription: true,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
              }
            } catch { /* non-fatal public profile sync */ }
          }
          else if ((meta?.isExclusiveAddon === 'true' || meta?.type === 'exclusive_leads') && userId && db) {
            if (session.mode !== "subscription" || typeof session.subscription !== "string" || !session.subscription) {
              throw new Error("Subscription fulfilment requires a valid Stripe Subscription ID.");
            }
            const subscriptionId = session.subscription;
            const periodEndIso = await resolveSubscriptionPeriodEndIso(stripeClient, subscriptionId);
            const userRef = db.collection("users").doc(userId);
            const markerRef = db.collection("stripe_fulfillments").doc(`exclusive_leads_${session.id}`);
            await db.runTransaction(async (tx: any) => {
              const claimSnap = await tx.get(eventRef);
              const claimData = claimSnap.data() || {};
              if (!ownsStripeWebhookClaim(claimData, claimToken)) {
                throw new Error('Webhook claim lost before checkout fulfillment mutation.');
              }
              const [userSnap, markerSnap] = await Promise.all([tx.get(userRef), tx.get(markerRef)]);
              if (!userSnap.exists) throw new Error("Exclusive Leads subscription user does not exist.");
              if (markerSnap.exists) return;
              const current = userSnap.data() || {};
              if (!canReplaceLinkedSubscription({
                existingSubscriptionId: current.exclusiveSubscriptionId,
                incomingSubscriptionId: subscriptionId,
                existingStatus: current.exclusiveSubscriptionStatus,
                isCurrentlyActive: current.hasExclusiveAddon,
              })) {
                throw new Error("A different Exclusive Leads subscription is already linked; manual reconciliation required.");
              }
              tx.update(userRef, {
                hasExclusiveAddon: true,
                isExclusiveActive: true,
                exclusiveSubscriptionStatus: "active",
                exclusiveCancelAtPeriodEnd: false,
                exclusiveSubscribedAt: current.exclusiveSubscribedAt || new Date().toISOString(),
                exclusiveSubscriptionId: subscriptionId,
                ...(periodEndIso ? { exclusiveCurrentPeriodEnd: periodEndIso } : {}),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
              tx.create(markerRef, { eventId: event.id, sessionId: session.id, subscriptionId, userId, type: "exclusive_leads", createdAt: admin.firestore.FieldValue.serverTimestamp() });
            });
          }
          else if ((meta?.type === "appointments" || meta?.subscriptionType === "appointments") && userId && db) {
            if (session.mode !== "subscription" || typeof session.subscription !== "string" || !session.subscription) {
              throw new Error("Appointments add-on fulfilment requires a valid Stripe Subscription ID.");
            }
            const subscriptionId = session.subscription;
            const periodEndIso = await resolveSubscriptionPeriodEndIso(stripeClient, subscriptionId);
            const userRef = db.collection("users").doc(userId);
            const markerRef = db.collection("stripe_fulfillments").doc(`appointments_${session.id}`);
            await db.runTransaction(async (tx: any) => {
              const claimSnap = await tx.get(eventRef);
              const claimData = claimSnap.data() || {};
              if (!ownsStripeWebhookClaim(claimData, claimToken)) {
                throw new Error('Webhook claim lost before checkout fulfillment mutation.');
              }
              const [userSnap, markerSnap] = await Promise.all([tx.get(userRef), tx.get(markerRef)]);
              if (!userSnap.exists) throw new Error("Appointments subscription user does not exist.");
              if (markerSnap.exists) return;
              const current = userSnap.data() || {};
              if (!canReplaceLinkedSubscription({
                existingSubscriptionId: current.appointmentsSubscriptionId,
                incomingSubscriptionId: subscriptionId,
                existingStatus: current.appointmentsSubscriptionStatus,
                isCurrentlyActive: current.hasAppointmentsAddon,
              })) {
                throw new Error("A different Appointments subscription is already linked; manual reconciliation required.");
              }
              tx.update(userRef, {
                hasAppointmentsAddon: true,
                appointmentsSubscriptionId: subscriptionId,
                appointmentsSubscriptionStatus: "active",
                appointmentsCancelAtPeriodEnd: false,
                appointmentsSubscribedAt: current.appointmentsSubscribedAt || new Date().toISOString(),
                ...(periodEndIso ? { appointmentsCurrentPeriodEnd: periodEndIso } : {}),
                appointmentSettings: {
                  ...(current.appointmentSettings || {}),
                  enabled: true,
                },
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
              tx.create(markerRef, { eventId: event.id, sessionId: session.id, subscriptionId, userId, type: "appointments", createdAt: admin.firestore.FieldValue.serverTimestamp() });
            });
          }
          else if (meta?.type === "driver_gold" || meta?.subscriptionType === "driver_gold") {
            if (session.mode !== "subscription" || typeof session.subscription !== "string" || !session.subscription) {
              throw new Error("Gold Driver fulfilment requires a valid Stripe Subscription ID.");
            }
            const subscriptionId = session.subscription;
            const userRef = db.collection("users").doc(userId);
            const markerRef = db.collection("stripe_fulfillments").doc(`driver_gold_${session.id}`);
            await db.runTransaction(async (tx: any) => {
              const claimSnap = await tx.get(eventRef);
              const claimData = claimSnap.data() || {};
              if (!ownsStripeWebhookClaim(claimData, claimToken)) {
                throw new Error('Webhook claim lost before checkout fulfillment mutation.');
              }
              const [userSnap, markerSnap] = await Promise.all([tx.get(userRef), tx.get(markerRef)]);
              if (!userSnap.exists) throw new Error("Gold Driver subscription user does not exist.");
              if (markerSnap.exists) return;
              const current = userSnap.data() || {};
              if (current.driverSubscriptionId && current.driverSubscriptionId !== subscriptionId) {
                throw new Error("A different Gold Driver subscription is already linked; manual reconciliation required.");
              }
              tx.update(userRef, {
                isGoldDriver: true,
                driverTier: "gold",
                driverSubscriptionId: subscriptionId,
                driverSubscriptionStatus: "active",
                commissionRate: 0.10,
                destinationFilters: 4,
                advanceBookingDays: 14,
                priorityDispatch: 50,
                driverCancelAtPeriodEnd: false,
                driverSubscribedAt: current.driverSubscribedAt || new Date().toISOString(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
              tx.create(markerRef, { eventId: event.id, sessionId: session.id, subscriptionId, userId, type: "driver_gold", createdAt: admin.firestore.FieldValue.serverTimestamp() });
            });
          }
          else if (meta?.type === "gotham_saas" || meta?.subscriptionType === "gotham_saas") {
            if (session.mode !== "subscription" || typeof session.subscription !== "string" || !session.subscription) {
              throw new Error("Gotham SaaS fulfilment requires a valid Stripe Subscription ID.");
            }
            const subscriptionId = session.subscription;
            const periodEndIso = await resolveSubscriptionPeriodEndIso(stripeClient, subscriptionId);
            const doorsCount = Math.max(1, Math.min(100000, Math.floor(Number(meta.gothamDoorsCount) || 100)));
            const billingCycle = meta.gothamBillingCycle === "annual" ? "annual" : "monthly";
            const gothamTierName = String(meta.gothamTierName || meta.tierName || "Starter Housing Authority");
            const userRef = db.collection("users").doc(userId);
            const markerRef = db.collection("stripe_fulfillments").doc(`gotham_saas_${session.id}`);
            await db.runTransaction(async (tx: any) => {
              const claimSnap = await tx.get(eventRef);
              const claimData = claimSnap.data() || {};
              if (!ownsStripeWebhookClaim(claimData, claimToken)) {
                throw new Error('Webhook claim lost before checkout fulfillment mutation.');
              }
              const [userSnap, markerSnap] = await Promise.all([tx.get(userRef), tx.get(markerRef)]);
              if (!userSnap.exists) throw new Error("Gotham SaaS subscription user does not exist.");
              if (markerSnap.exists) return;
              const current = userSnap.data() || {};
              if (!canReplaceLinkedSubscription({
                existingSubscriptionId: current.gothamSubscriptionId,
                incomingSubscriptionId: subscriptionId,
                existingStatus: current.gothamSubscriptionStatus,
                isCurrentlyActive: current.isGothamSubscriber,
              })) {
                throw new Error("A different active Gotham SaaS subscription is already linked; manual reconciliation required.");
              }
              tx.update(userRef, {
                isGothamSubscriber: true,
                subscriptionType: "gotham_saas",
                tier: "gotham",
                tierId: gothamTierName,
                gothamSubscriptionId: subscriptionId,
                gothamSubscriptionStatus: "active",
                gothamDoorsCount: doorsCount,
                gothamTierName,
                gothamBillingCycle: billingCycle,
                gothamCancelAtPeriodEnd: false,
                gothamSubscribedAt: current.gothamSubscribedAt || new Date().toISOString(),
                ...(periodEndIso ? { gothamCurrentPeriodEnd: periodEndIso } : {}),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
              tx.create(markerRef, { eventId: event.id, sessionId: session.id, subscriptionId, userId, type: "gotham_saas", doorsCount, tierName: gothamTierName, billingCycle, createdAt: admin.firestore.FieldValue.serverTimestamp() });
            });
          }
          else if (session.mode === 'subscription') {
            const subscriptionId = typeof session.subscription === "string" ? session.subscription : "";
            if (!userId || !db || !subscriptionId) throw new Error("Membership subscription fulfillment is missing user or Stripe subscription ID.");
            const rawTier = meta?.tierName || "Pro";
            const lowerTier = String(rawTier).toLowerCase();
            let canonicalTier = 'pro';
            let isLandlord = false;
            if (lowerTier.includes('landlord') || meta?.tier === 'landlord' || meta?.subscriptionType === 'landlord') {
              canonicalTier = 'landlord'; isLandlord = true;
            } else if (lowerTier.includes('platinum') || lowerTier.includes('enterprise powerhouse')) canonicalTier = 'platinum';
            else if (lowerTier.includes('gold') || lowerTier.includes('elite') || lowerTier.includes('premium') || lowerTier.includes('business professional')) canonicalTier = 'premium';
            else if (lowerTier.includes('silver') || lowerTier.includes('pro') || lowerTier.includes('professional')) canonicalTier = 'pro';
            else canonicalTier = 'payg';
            const userRef = db.collection("users").doc(userId);
            const markerRef = db.collection("stripe_fulfillments").doc(`membership_${session.id}`);
            const landlordPatch = isLandlord
              ? buildLandlordCheckoutFulfillmentPatch(
                  subscriptionId,
                  await stripeClient.subscriptions.retrieve(subscriptionId) as any
                )
              : null;
            const membershipPeriodEndIso = !isLandlord
              ? await resolveSubscriptionPeriodEndIso(stripeClient, subscriptionId)
              : undefined;
            await db.runTransaction(async (tx: any) => {
              const claimSnap = await tx.get(eventRef);
              const claimData = claimSnap.data() || {};
              if (!ownsStripeWebhookClaim(claimData, claimToken)) {
                throw new Error('Webhook claim lost before checkout fulfillment mutation.');
              }
              const [userSnap, markerSnap] = await Promise.all([tx.get(userRef), tx.get(markerRef)]);
              if (!userSnap.exists) throw new Error("Membership subscription user does not exist.");
              if (markerSnap.exists) return;
              const current = userSnap.data() || {};
              if (isLandlord) {
                const existingLandlordSubId =
                  current.landlordSubscriptionId ||
                  (current.subscriptionType === "landlord" ? current.subscriptionId : undefined);
                if (existingLandlordSubId && existingLandlordSubId !== subscriptionId) {
                  if (["active", "trialing", "past_due", "incomplete", "paused"].includes(String(current.homeownerSubscriptionStatus || ""))) {
                    throw new Error("A different active Landlord subscription is already linked; manual reconciliation required.");
                  }
                }
              } else {
                const existingTraderSubId =
                  current.subscriptionType === "landlord" ? undefined : current.subscriptionId;
                if (existingTraderSubId && existingTraderSubId !== subscriptionId) {
                  if (["active", "trialing", "past_due", "incomplete", "paused"].includes(String(current.subscriptionStatus || ""))) {
                    throw new Error("A different active subscription is already linked; manual reconciliation required.");
                  }
                }
              }
              if (landlordPatch) {
                tx.update(userRef, {
                  ...landlordPatch,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
              } else {
                tx.update(userRef, {
                  subscriptionStatus: "active",
                  subscriptionId,
                  tierId: rawTier,
                  tier: canonicalTier,
                  cancelAtPeriodEnd: false,
                  subscriptionType: canonicalTier !== 'payg' ? 'tier' : 'standard',
                  isPro: canonicalTier !== 'payg',
                  isProInvoiceSubscriber: canonicalTier !== 'payg',
                  ...(membershipPeriodEndIso ? { currentPeriodEnd: membershipPeriodEndIso } : {}),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
              }
              tx.create(markerRef, { eventId: event.id, sessionId: session.id, subscriptionId, userId, tier: canonicalTier, type: isLandlord ? "landlord_subscription" : "membership_subscription", createdAt: admin.firestore.FieldValue.serverTimestamp() });
            });
            if (!isLandlord) {
              try {
                const pubRef = db.collection("public_profiles").doc(userId);
                const pubSnap = await pubRef.get();
                if (pubSnap.exists) {
                  await pubRef.update({
                    tierId: rawTier,
                    tier: canonicalTier,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                }
              } catch { /* non-fatal public profile sync */ }
            }
          } else if (session.mode === 'payment') {
            if ((meta?.type === 'ad_wallet_topup' || meta?.type === 'banner_ad') && userId && db) {
              const topupAmount = meta?.type === 'banner_ad'
                ? (session.amount_total ? session.amount_total / 100 : Number(meta?.totalPence || 0) / 100)
                : (Number(meta?.topupAmount) || (session.amount_total ? session.amount_total / 100 : 0));
              if (topupAmount > 0) {
                // Event-scoped marker and wallet credit commit atomically. If a later
                // webhook side effect fails and Stripe retries this event, the credit
                // cannot be applied twice.
                const fulfillmentRef = db.collection("stripe_fulfillments").doc(`ad_wallet_${event.id}`);
                const walletRef = db.collection("users").doc(userId);
                await db.runTransaction(async (tx: any) => {
              const claimSnap = await tx.get(eventRef);
              const claimData = claimSnap.data() || {};
              if (!ownsStripeWebhookClaim(claimData, claimToken)) {
                throw new Error('Webhook claim lost before checkout fulfillment mutation.');
              }
                  const fulfillment = await tx.get(fulfillmentRef);
                  if (fulfillment.exists) return;
                  tx.set(walletRef, {
                    adWalletBalance: admin.firestore.FieldValue.increment(topupAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                  }, { merge: true });
                  tx.create(fulfillmentRef, {
                    eventId: event.id,
                    sessionId: session.id,
                    intentId: session.metadata?.intentId || null,
                    userId,
                    type: "ad_wallet_topup",
                    amount: topupAmount,
                    currency: session.currency || "gbp",
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                  });
                });
              }
            } else if (meta?.type === 'mediation_stake' && meta?.jobId && db) {
              const mediationJobRef = db.collection("jobs").doc(meta.jobId);
              const mediationCardRef = db.collection("public_job_cards").doc(meta.jobId);
              const mediationFulfillmentRef = db.collection("stripe_fulfillments").doc(`mediation_stake_${session.id}`);
              await db.runTransaction(async (tx: any) => {
              const claimSnap = await tx.get(eventRef);
              const claimData = claimSnap.data() || {};
              if (!ownsStripeWebhookClaim(claimData, claimToken)) {
                throw new Error('Webhook claim lost before checkout fulfillment mutation.');
              }
                const [jobSnap, cardSnap, fulfillmentSnap] = await Promise.all([
                  tx.get(mediationJobRef), tx.get(mediationCardRef), tx.get(mediationFulfillmentRef)
                ]);
                if (!jobSnap.exists) throw new Error("Mediation stake job does not exist.");
                if (fulfillmentSnap.exists) return;
                const jobData = jobSnap.data() || {};
                const dispute = jobData.dispute || {};
                if (dispute.stakePaymentId && dispute.stakePaymentId !== session.id) {
                  throw new Error("Mediation stake is already bound to a different Checkout Session.");
                }
                if (dispute.mediationStakePaid && dispute.stakePaymentId !== session.id) {
                  throw new Error("Mediation stake is already marked paid; manual reconciliation required.");
                }
                const disputePhotos = Array.isArray(intent?.disputePhotoUrls)
                  ? intent.disputePhotoUrls.filter((u: any) => typeof u === "string" && /^https?:\/\//i.test(u)).slice(0, 8)
                  : [];
                const isPropertyDamageFlag = String(meta.isPropertyDamage || "").toLowerCase() === "true" || dispute.isPropertyDamage === true;
                tx.update(mediationJobRef, {
                  status: "disputed",
                  mediationStakePaid: true,
                  "dispute.status": "pending_arbitration",
                  "dispute.reason": meta.disputeReason || dispute.reason || "Unspecified",
                  "dispute.technicalFaultReport": meta.technicalFaultReport || dispute.technicalFaultReport || "Unspecified",
                  "dispute.isPropertyDamage": isPropertyDamageFlag,
                  "dispute.raisedBy": userId,
                  "dispute.createdAt": dispute.createdAt || admin.firestore.FieldValue.serverTimestamp(),
                  ...(disputePhotos.length > 0 ? { "dispute.photos": disputePhotos } : {}),
                  "dispute.mediationStakePaid": true,
                  "dispute.mediationStakeAmount": Number(session.amount_total || 0) / 100,
                  "dispute.stakePaymentId": session.id,
                  "dispute.paidAt": dispute.paidAt || admin.firestore.FieldValue.serverTimestamp(),
                  disputeReason: meta.disputeReason || "Unspecified",
                  technicalFaultReport: meta.technicalFaultReport || "Unspecified",
                  disputedAt: jobData.disputedAt || admin.firestore.FieldValue.serverTimestamp()
                });
                if (cardSnap.exists) {
                  tx.update(mediationCardRef, {
                    status: "disputed",
                    updatedAt: new Date().toISOString(),
                  });
                }
                tx.create(mediationFulfillmentRef, {
                  eventId: event.id,
                  sessionId: session.id,
                  intentId: session.metadata?.intentId || null,
                  userId,
                  jobId: meta.jobId,
                  amount: Number(session.amount_total || 0),
                  currency: session.currency || "gbp",
                  type: "mediation_stake",
                  createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
                const { ownerIds, traderIds } = getJobParticipantIds(jobData);
                const counterpartIds = [...new Set([...ownerIds, ...traderIds])].filter(
                  (uid) => uid && uid !== userId
                );
                for (const counterpartUid of counterpartIds) {
                  tx.set(
                    db.collection("notifications").doc(`med_stake_sess_${meta.jobId}_${session.id}_${counterpartUid}`),
                    {
                      userId: counterpartUid,
                      title: "Dispute Mediation Stake Confirmed",
                      message: `A £${(Number(session.amount_total || 2500) / 100).toFixed(2)} mediation stake has been confirmed for "${jobData.title || `Job #${meta.jobId}`}". The dispute is queued for arbitration.`,
                      type: "status",
                      read: false,
                      jobId: meta.jobId,
                      link: `/job/${meta.jobId}`,
                      createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    },
                    { merge: true }
                  );
                }
              });
            }
            if (meta?.type === 'boost' && meta?.jobId && db) {
              const jobRef = db.collection("jobs").doc(meta.jobId);
              const publicCardRef = db.collection("public_job_cards").doc(meta.jobId);
              const boostFulfillmentRef = db.collection("stripe_fulfillments").doc(`boost_${session.id}`);
              const isIM = meta.tier === "instant_match";
              const matchId = `im_${session.id}`;
              const matchRef = db.collection("instant_matches").doc(matchId);
              const instantMatchFulfillmentRef = db.collection("stripe_fulfillments").doc(`instant_match_${session.id}`);
              const boostExpiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
              await db.runTransaction(async (tx: any) => {
              const claimSnap = await tx.get(eventRef);
              const claimData = claimSnap.data() || {};
              if (!ownsStripeWebhookClaim(claimData, claimToken)) {
                throw new Error('Webhook claim lost before checkout fulfillment mutation.');
              }
                const [jobSnap, boostMarkerSnap, matchSnap, imMarkerSnap] = await Promise.all([
                  tx.get(jobRef), tx.get(boostFulfillmentRef), ...(isIM ? [tx.get(matchRef), tx.get(instantMatchFulfillmentRef)] : [])
                ]);
                if (!jobSnap.exists) throw new Error("Boost target job does not exist.");
                const jobData = jobSnap.data() || {};
                if (jobData.homeownerId && jobData.homeownerId !== userId) {
                  throw new Error("Boost payment user does not own the target job.");
                }
                if (!boostMarkerSnap.exists) {
                  tx.update(jobRef, {
                    isBoosted: true,
                    boostTier: meta.tier || "emergency_boost",
                    boostExpiresAt,
                    postedDate: admin.firestore.FieldValue.serverTimestamp(),
                    isInstantMatch: isIM,
                    isEmergencyBoost: meta.tier === "emergency_boost",
                    retryCount: 0
                  });
                  tx.create(boostFulfillmentRef, {
                    eventId: event.id, sessionId: session.id,
                    intentId: session.metadata?.intentId || null,
                    userId, jobId: meta.jobId, tier: meta.tier || "emergency_boost",
                    type: "boost", createdAt: admin.firestore.FieldValue.serverTimestamp()
                  });
                }
                if (isIM && !imMarkerSnap.exists) {
                  if (!matchSnap.exists) {
                    const paymentIntentId = resolveInstantMatchPaymentIntentId(session as any, intent);
                    tx.create(matchRef, {
                      id: matchId, jobId: meta.jobId, customerId: userId || "",
                      chargeAmountPence: Number(session.amount_total || 0),
                      currency: String(session.currency || "gbp").toLowerCase(),
                      chargeTier: "instant_match", feeWaived: false,
                      status: paymentIntentId ? "searching" : "refund_review_required",
                      refundStatus: paymentIntentId ? "not_started" : "manual_review",
                      refundReviewReason: paymentIntentId ? null : "missing_or_invalid_payment_intent",
                      stripePaymentIntentId: paymentIntentId,
                      currentAttempt: 0,
                      createdAt: admin.firestore.FieldValue.serverTimestamp(),
                      searchingAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                  }
                  tx.set(jobRef, { instantMatchId: matchId, matchedViaInstantMatch: true }, { merge: true });
                  tx.create(instantMatchFulfillmentRef, {
                    eventId: event.id, sessionId: session.id,
                    intentId: session.metadata?.intentId || null,
                    userId, jobId: meta.jobId, type: "instant_match",
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                  });
                }
              });
              // The projection is a separate transaction because it is not part of
              // the monetary/job fulfillment commit. Still fence it with the event claim:
              // a worker whose lease was taken over must not publish stale projection data.
              await db.runTransaction(async (tx: any) => {
                const claimSnap = await tx.get(eventRef);
                const claimData = claimSnap.data() || {};
                if (!ownsStripeWebhookClaim(claimData, claimToken)) {
                  throw new Error('Webhook claim lost before boost projection mutation.');
                }
                tx.set(publicCardRef, {
                  isBoosted: true,
                  boostTier: meta.tier || "emergency_boost",
                  isInstantMatch: isIM,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
              });
            }
            if (meta?.type === 'taxi_trip' && meta?.rideId && db) {
              await fulfillTaxiTripCheckout({
                db,
                event,
                session,
                intent,
                eventRef,
                claimToken,
              });
            }
            if (meta?.type === 'fee_settlement' && db) {
              await fulfillDriverFeeSettlementWebhook({
                db,
                event,
                session,
                intent,
                eventRef,
                claimToken,
              });
            }
            if (meta?.type === 'milestone_funding' && meta?.jobId && meta?.quoteId && meta?.milestoneId && db) {
              const { jobId, quoteId, milestoneId } = meta;
              const quoteRef = db.collection("jobs").doc(jobId).collection("quotes").doc(quoteId);
              const jobRef = db.collection("jobs").doc(jobId);
              const milestoneFulfillmentRef = db.collection("stripe_fulfillments").doc(`milestone_${session.id}`);
              const paymentIntentId = typeof session.payment_intent === "string"
                ? session.payment_intent
                : typeof (session.payment_intent as any)?.id === "string"
                  ? (session.payment_intent as any).id
                  : session.id;
              const verifiedAmountPence = Number(session.amount_total || meta.milestoneAmountPence || 0);
              const parsedFeePence = meta.platformFeePence !== undefined ? Number(meta.platformFeePence) : undefined;
              const parsedRate = meta.appliedCommissionRate !== undefined ? Number(meta.appliedCommissionRate) : undefined;
              const parsedCapGbp = meta.commissionCapGbp !== undefined ? Number(meta.commissionCapGbp) : undefined;
              let resolvedTraderId = meta.traderId || "";
              let fundedMilestoneTitle = "Milestone";
              let newlyFunded = false;

              await db.runTransaction(async (tx: any) => {
                const claimSnap = await tx.get(eventRef);
                const claimData = claimSnap.data() || {};
                if (!ownsStripeWebhookClaim(claimData, claimToken)) {
                  throw new Error('Webhook claim lost before milestone funding mutation.');
                }
                const [jobSnap, quoteSnap, fulfillmentSnap] = await Promise.all([
                  tx.get(jobRef),
                  tx.get(quoteRef),
                  tx.get(milestoneFulfillmentRef),
                ]);
                if (fulfillmentSnap.exists) return;
                if (!jobSnap.exists || !quoteSnap.exists) {
                  throw new Error("Milestone funding target job or quote does not exist.");
                }
                const jobData = jobSnap.data() || {};
                const quoteData = quoteSnap.data() || {};
                const ownerId = jobData.homeownerId || jobData.userId;
                if (ownerId && userId && ownerId !== userId) {
                  throw new Error("Milestone funding checkout user does not own the target job.");
                }
                resolvedTraderId = meta.traderId || quoteData.tradespersonId || "";
                const milestones = Array.isArray(quoteData.milestones) ? quoteData.milestones : [];
                const targetMs = milestones.find((m: any) => m.id === milestoneId);
                if (!targetMs) {
                  throw new Error("Milestone funding target milestone not found on quote.");
                }
                fundedMilestoneTitle = targetMs.title || "Milestone";
                const updatedMilestones = milestones.map((m: any) => {
                  if (m.id === milestoneId) {
                    const feeVal =
                      parsedFeePence !== undefined && Number.isFinite(parsedFeePence) && parsedFeePence >= 0
                        ? Math.round(parsedFeePence)
                        : undefined;
                    return {
                      ...m,
                      status: m.status === "pending" || !m.status ? "funded" : m.status,
                      fundedAt: m.fundedAt || new Date().toISOString(),
                      stripePaymentIntentId: paymentIntentId,
                      isDestinationCharge: true,
                      ...(feeVal !== undefined ? { platformFeePence: feeVal, netPayoutPence: Math.max(0, verifiedAmountPence - feeVal) } : {}),
                      ...(parsedRate !== undefined && Number.isFinite(parsedRate) ? { appliedCommissionRate: parsedRate } : {}),
                      ...(parsedCapGbp !== undefined && Number.isFinite(parsedCapGbp) ? { commissionCapGbp: parsedCapGbp } : {}),
                    };
                  }
                  return m;
                });
                const allMilestonesFunded =
                  updatedMilestones.length > 0 &&
                  updatedMilestones.every((m: any) => ["funded", "submitted", "approved", "released"].includes(String(m.status || "").toLowerCase()));
                tx.update(quoteRef, { milestones: updatedMilestones, updatedAt: new Date().toISOString() });
                tx.update(jobRef, {
                  paymentStatus: allMilestonesFunded ? "funded" : "partially_funded",
                  updatedAt: new Date().toISOString(),
                });
                tx.create(milestoneFulfillmentRef, {
                  eventId: event.id,
                  sessionId: session.id,
                  paymentIntentId,
                  intentId: session.metadata?.intentId || null,
                  userId,
                  jobId,
                  quoteId,
                  milestoneId,
                  traderId: resolvedTraderId,
                  amountPence: verifiedAmountPence,
                  ...(parsedFeePence !== undefined && Number.isFinite(parsedFeePence) ? { platformFeePence: Math.round(parsedFeePence) } : {}),
                  type: "milestone_funding",
                  createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                newlyFunded = true;
              });

              if (newlyFunded && verifiedAmountPence > 0) {
                await PaymentLedgerEngine.recordEscrowFunding(db, {
                  jobId,
                  milestoneId,
                  paymentIntentId,
                  idempotencyKey: `stripe_fund_${session.id}`,
                  customerId: userId || "",
                  traderId: resolvedTraderId || "trader",
                  verifiedAmount: verifiedAmountPence,
                  currency: String(session.currency || "gbp").toLowerCase(),
                  ...(parsedFeePence !== undefined && Number.isFinite(parsedFeePence) ? { platformFeePence: Math.round(parsedFeePence) } : {}),
                  ...(parsedRate !== undefined && Number.isFinite(parsedRate) ? { appliedCommissionRate: parsedRate } : {}),
                  ...(parsedCapGbp !== undefined && Number.isFinite(parsedCapGbp) ? { commissionCapGbp: parsedCapGbp } : {}),
                });
                if (resolvedTraderId) {
                  await db.collection("notifications").doc(`ms_fund_${session.id}_${resolvedTraderId}`).set({
                    userId: resolvedTraderId,
                    title: "Milestone Funded! 💰",
                    message: `Homeowner funded "${fundedMilestoneTitle}". You can now start work!`,
                    type: "status",
                    link: `/job/${jobId}`,
                    read: false,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                  }, { merge: true });
                }
              }
            }
          }
        await transitionCheckoutIntentState({
          db,
          intentId: session.metadata.intentId,
          nextStatus: "completed",
          eventId: event.id,
          sessionId: session.id,
          paymentIntentId: typeof session.payment_intent === "string"
            ? session.payment_intent
            : typeof (session.payment_intent as any)?.id === "string"
              ? (session.payment_intent as any).id
              : undefined,
          eventRef,
          claimToken,
          ownsClaimFn: ownsStripeWebhookClaim,
        });
      }
      if (event.type === "checkout.session.expired") {
        const session = event.data.object as Stripe.Checkout.Session;
        const intentId = typeof session.metadata?.intentId === "string" ? session.metadata.intentId.trim() : "";
        let resolvedIntentId = intentId;
        if (!resolvedIntentId && session.id && db) {
          const matchedIntent = await db.collection("payment_intents").where("checkoutSessionId", "==", session.id).limit(1).get();
          if (!matchedIntent.empty) {
            resolvedIntentId = matchedIntent.docs[0].id;
          }
        }
        if (resolvedIntentId && db) {
          await transitionCheckoutIntentState({
            db,
            intentId: resolvedIntentId,
            nextStatus: "expired",
            eventId: event.id,
            sessionId: session.id,
            eventRef,
            claimToken,
            ownsClaimFn: ownsStripeWebhookClaim,
          });
        }
      }
      // Reconcile each individual Stripe refund against the original completed ledger entry.
      if (event.type === "charge.refunded" || event.type === "refund.updated") {
        // charge.refunded can arrive while an individual refund is still pending.
        // refund.updated refreshes the Charge; both event types then reconcile the complete Stripe refund list.
        const refundUpdate = event.type === "refund.updated" ? event.data.object as Stripe.Refund : null;
        const charge = refundUpdate
          ? await stripeClient.charges.retrieve(typeof refundUpdate.charge === "string" ? refundUpdate.charge : refundUpdate.charge.id)
          : event.data.object as Stripe.Charge;
        const chargePaymentIntent = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id || null;
        const refundPaymentIntent = refundUpdate
          ? (typeof refundUpdate.payment_intent === "string" ? refundUpdate.payment_intent : refundUpdate.payment_intent?.id || null)
          : null;
        const paymentIntentId = chargePaymentIntent || refundPaymentIntent;
        const eventRefundRef = db.collection("refund_events").doc(`ref_${event.id}`);
        if (!ownsStripeWebhookClaim((await eventRef.get()).data() || {}, claimToken)) throw new Error("Webhook claim lost before refund reconciliation.");
        if (!paymentIntentId) {
          await db.collection("refund_review").doc(`charge_${charge.id}`).set({
            chargeId: charge.id, amountRefunded: charge.amount_refunded, currency: charge.currency,
            reason: "charge_refund_missing_payment_intent_reference", status: "requires_review", sourceEventId: event.id,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          await eventRefundRef.set({ chargeId: charge.id, amountRefunded: charge.amount_refunded, currency: charge.currency,
            status: "requires_review", requiresReview: true, reason: "charge_refund_missing_payment_intent_reference",
            sourceEventId: event.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        } else {
          // Always retrieve the complete Charge refund list; the embedded Charge expansion is only a partial page.
          const { refunds, pagesScanned: refundPagesScanned } = await listAllChargeRefunds(stripeClient, charge.id);
          let requiresReview = false;
          await eventRefundRef.set({ chargeId: charge.id, paymentIntentId, amountRefunded: charge.amount_refunded,
            currency: charge.currency, refundIds: refunds.map(refund => refund.id), status: "reconciliation_started",
            createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          const ledger = await db.collection("payment_ledger").where("transactionId", "==", paymentIntentId).get();
          const preferred = ledger.docs.filter((doc: any) => doc.data()?.status === "completed" && doc.data()?.type === "ESCROW_DEPOSIT");
          const eligible = preferred.length ? preferred : ledger.docs.filter((doc: any) => doc.data()?.status === "completed" && doc.data()?.type === "PLATFORM_COMMISSION");
          if (!refunds.length && charge.amount_refunded > 0) {
            requiresReview = true;
            await db.collection("refund_review").doc(`charge_${charge.id}`).set({ chargeId: charge.id, paymentIntentId,
              amountRefunded: charge.amount_refunded, currency: charge.currency,
              reason: "charge_refunded_event_has_no_individual_refund_objects", status: "requires_review", sourceEventId: event.id,
              updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          }
          for (const refund of refunds) {
            const refundChargeId = typeof refund.charge === "string" ? refund.charge : refund.charge?.id || null;
            const refundPi = typeof refund.payment_intent === "string" ? refund.payment_intent : refund.payment_intent?.id || null;
            const reviewRef = db.collection("refund_review").doc(refund.id);
            if (refundChargeId !== charge.id || refundPi !== paymentIntentId || String(refund.currency || "").toLowerCase() !== String(charge.currency || "").toLowerCase() || eligible.length !== 1) {
              requiresReview = true;
              await reviewRef.set({ refundId: refund.id, chargeId: charge.id, paymentIntentId,
                amountPence: refund.amount, currency: refund.currency,
                candidateLedgerEntryIds: eligible.map((doc: any) => doc.id),
                reason: refundChargeId !== charge.id || refundPi !== paymentIntentId || String(refund.currency || "").toLowerCase() !== String(charge.currency || "").toLowerCase()
                  ? "refund_charge_payment_intent_or_currency_mismatch" : eligible.length === 0
                    ? "no_matching_completed_original_payment_ledger_entry" : "multiple_matching_original_payment_ledger_entries",
                status: "requires_review", sourceEventId: event.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
              continue;
            }
            try {
              await recordConfirmedRefund(db, { refundId: refund.id, chargeId: charge.id, paymentIntentId,
                originalLedgerEntryId: eligible[0].id, amountPence: refund.amount, currency: refund.currency,
                stripeRefundStatus: refund.status || "unknown", operationId: refund.metadata?.refundOperationId || undefined, reason: refund.reason || null });
              await reviewRef.delete().catch(() => undefined);
            } catch (refundError: any) {
              if (![400, 404, 409].includes(Number(refundError?.statusCode))) throw refundError;
              requiresReview = true;
              await reviewRef.set({ refundId: refund.id, chargeId: charge.id, paymentIntentId,
                originalLedgerEntryId: eligible[0].id, amountPence: refund.amount, currency: refund.currency,
                reason: refundError.message || "refund_reconciliation_conflict", status: "requires_review",
                sourceEventId: event.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            }
          }
          // The full Stripe list was retrieved successfully, so clear any stale pagination-only review marker.
          await db.collection("refund_review").doc(`charge_${charge.id}_pagination`).delete().catch(() => undefined);
          const requiresPaginationReview = false;
          if (!ownsStripeWebhookClaim((await eventRef.get()).data() || {}, claimToken)) throw new Error("Webhook claim lost before refund event completion.");
          await eventRefundRef.set({ status: getRefundEventReconciliationStatus(requiresReview, requiresPaginationReview),
            requiresReview, reconciledRefundCount: refunds.length, refundPagesScanned, requiresPaginationReview,
            reconciledAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        }
      }
      // Mediation stake & general Checkout intent terminal transition handling
      if (
        event.type === "payment_intent.succeeded" ||
        event.type === "payment_intent.payment_failed" ||
        event.type === "payment_intent.canceled"
      ) {
        const pi = event.data.object as Stripe.PaymentIntent;
        const meta = pi.metadata || {};
        if (meta.type === "mediation_stake" && event.type !== "payment_intent.canceled") {
          const isSuccess = event.type === "payment_intent.succeeded";
          const cachedGlobalCfg = await getCachedConfig("global").catch(() => null);
          const dynamicStakeGbp = Number(cachedGlobalCfg?.paidAddons?.milestoneEscrow?.homeownerMediationStake);
          const expectedStakePence = Number.isFinite(dynamicStakeGbp) && dynamicStakeGbp > 0
            ? Math.round(dynamicStakeGbp * 100)
            : 2500;
          if (!meta.jobId || !meta.paymentAttemptId || !meta.userId || pi.currency !== "gbp" || pi.amount !== expectedStakePence) {
            await db.runTransaction(async (tx: any) => {
              const claim = await tx.get(eventRef);
              if (!ownsStripeWebhookClaim(claim.data() || {}, claimToken)) throw new Error("Webhook claim lost before rejecting mediation payment.");
              tx.update(eventRef, { status: "rejected", rejectionReason: isSuccess ? "invalid_mediation_stake_success_metadata_or_amount" : "invalid_mediation_stake_failure_metadata_or_amount", rejectedAt: admin.firestore.FieldValue.serverTimestamp() });
            });
            return res.status(400).send("Invalid mediation stake payment");
          }
          if (!ownsStripeWebhookClaim((await eventRef.get()).data() || {}, claimToken)) throw new Error("Webhook claim lost before mediation payment mutation.");
          if (isSuccess) {
            await confirmMediationStakePayment(db, { jobId: meta.jobId, userId: meta.userId, attemptId: meta.paymentAttemptId, paymentIntentId: pi.id, serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp() });
          } else {
            await recordMediationStakePaymentFailure(db, { jobId: meta.jobId, userId: meta.userId, attemptId: meta.paymentAttemptId, paymentIntentId: pi.id, paymentIntentStatus: pi.status, lastPaymentError: pi.last_payment_error?.message || "Payment attempt failed", serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp() });
            await db.collection("failed_payments").doc(`fail_${event.id}`).set({ paymentIntentId: pi.id, lastError: pi.last_payment_error?.message || "Failed", status: "failed", createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          }
        } else if (
          (event.type === "payment_intent.payment_failed" || event.type === "payment_intent.canceled") &&
          db
        ) {
          let resolvedIntentId = typeof meta.intentId === "string" ? meta.intentId.trim() : "";
          if (!resolvedIntentId && pi.id) {
            const matchedIntent = await db.collection("payment_intents").where("paymentIntentId", "==", pi.id).limit(1).get();
            if (!matchedIntent.empty) resolvedIntentId = matchedIntent.docs[0].id;
          }
          if (resolvedIntentId) {
            await transitionCheckoutIntentState({
              db,
              intentId: resolvedIntentId,
              nextStatus: "failed",
              eventId: event.id,
              paymentIntentId: pi.id,
              failureReason:
                pi.last_payment_error?.message ||
                (event.type === "payment_intent.canceled" ? "Payment intent canceled" : "Payment attempt failed"),
              eventRef,
              claimToken,
              ownsClaimFn: ownsStripeWebhookClaim,
            });
          }
          if (event.type === "payment_intent.payment_failed") {
            await db.collection("failed_payments").doc(`fail_${event.id}`).set({
              paymentIntentId: pi.id,
              lastError: pi.last_payment_error?.message || "Failed",
              status: "failed",
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
          }
        }
      }

      // Synchronize product entitlements from the current Stripe subscription state.
      // Invoice events are triggers only: payment events never grant access by themselves.
      if (isStripeSubscriptionLifecycleEventType(event.type)) {
        const payload = event.data.object as any;
        const isSubscriptionDeleted = event.type === "customer.subscription.deleted";
        const subscriptionId = event.type.startsWith("customer.subscription.")
          ? String(payload.id || "")
          : extractInvoiceSubscriptionId(payload);
        if (subscriptionId) {
          // Use Stripe's live state for update/invoice events; the deleted event itself
          // is terminal. A replaced subscription ID is never allowed to update the new one.
          const subscription = isSubscriptionDeleted
            ? payload as Stripe.Subscription
            : await stripeClient.subscriptions.retrieve(subscriptionId);
          const products = [
            { key: "membership", idField: "subscriptionId", lastCreated: "subscriptionLastEventCreated", lastId: "subscriptionLastEventId" },
            { key: "landlord", idField: "landlordSubscriptionId", lastCreated: "homeownerSubscriptionLastEventCreated", lastId: "homeownerSubscriptionLastEventId" },
            { key: "gold_driver", idField: "driverSubscriptionId", lastCreated: "driverSubscriptionLastEventCreated", lastId: "driverSubscriptionLastEventId" },
            { key: "exclusive_leads", idField: "exclusiveSubscriptionId", lastCreated: "exclusiveSubscriptionLastEventCreated", lastId: "exclusiveSubscriptionLastEventId" },
            { key: "video_pro", idField: "videoProSubscriptionId", lastCreated: "videoProSubscriptionLastEventCreated", lastId: "videoProSubscriptionLastEventId" },
            { key: "appointments", idField: "appointmentsSubscriptionId", lastCreated: "appointmentsSubscriptionLastEventCreated", lastId: "appointmentsSubscriptionLastEventId" },
            { key: "gotham_saas", idField: "gothamSubscriptionId", lastCreated: "gothamSubscriptionLastEventCreated", lastId: "gothamSubscriptionLastEventId" }
          ];
          const matches = await Promise.all(products.map(async (product) => {
            const snap = await db.collection("users").where(product.idField, "==", subscriptionId).limit(2).get();
            if (snap.size > 1) {
              throw new Error("Stripe subscription is linked to multiple users for " + product.key + "; manual reconciliation required.");
            }
            return snap.empty ? null : { product, userDoc: snap.docs[0] };
          }));
          const linked = matches.filter((entry: any) => entry !== null) as Array<{ product: any; userDoc: any }>;
          const resolved = resolveSubscriptionProductMatch(linked);
          if (resolved) {
            const { product, userDoc } = resolved;
            const eventCreated = Number(event.created || 0);
            let publicSyncPatch: Record<string, any> | null = null;
            await db.runTransaction(async (tx: any) => {
              const claimSnap = await tx.get(eventRef);
              const claimData = claimSnap.data() || {};
              if (!ownsStripeWebhookClaim(claimData, claimToken)) {
                throw new Error('Webhook claim lost before checkout fulfillment mutation.');
              }
              const latest = await tx.get(userDoc.ref);
              if (!latest.exists) return;
              const current = latest.data() || {};
              if (current[product.idField] !== subscriptionId) return;
              // Event ordering is tracked independently for each product subscription.
              if (Number(current[product.lastCreated] || 0) > eventCreated) return;
              const lifecyclePatch = buildSubscriptionLifecyclePatch(product.key, subscription as any, isSubscriptionDeleted);
              const patch: Record<string, any> = {
                ...lifecyclePatch,
                [product.lastCreated]: eventCreated,
                [product.lastId]: event.id,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              };
              if (product.key === "appointments" && typeof lifecyclePatch.hasAppointmentsAddon === "boolean") {
                patch.appointmentSettings = {
                  ...(current.appointmentSettings || {}),
                  enabled: lifecyclePatch.hasAppointmentsAddon,
                };
              }
              if (product.key === "membership" && lifecyclePatch.tierId) {
                publicSyncPatch = { tierId: lifecyclePatch.tierId, tier: lifecyclePatch.tier || "payg" };
              } else if (product.key === "video_pro" && typeof lifecyclePatch.hasVerifiedVideoProSubscription === "boolean") {
                publicSyncPatch = { hasVerifiedVideoProSubscription: lifecyclePatch.hasVerifiedVideoProSubscription };
              }
              tx.update(userDoc.ref, patch);
            });
            if (publicSyncPatch) {
              try {
                const pubRef = db.collection("public_profiles").doc(userDoc.id);
                const pubSnap = await pubRef.get();
                if (pubSnap.exists) {
                  await pubRef.update({
                    ...publicSyncPatch,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                }
              } catch { /* non-fatal public profile sync */ }
            }
          }
        }
      }

      // Chargeback & card dispute lifecycle (AT-PAY-16)
      if (isStripeChargebackEventType(event.type)) {
        if (!ownsStripeWebhookClaim((await eventRef.get()).data() || {}, claimToken)) {
          throw new Error("Webhook claim lost before chargeback processing.");
        }
        await processStripeChargebackEvent(db, event as any);
      }

      // Stripe Connect capability / payouts_enabled synchronization (AT-PAY-10)
      if (event.type === "account.updated") {
        await reconcileStripeAccountUpdatedWebhook({
          db,
          eventId: event.id,
          eventCreated: Number(event.created || 0),
          account: event.data.object as Stripe.Account,
          eventRef,
          claimToken,
          ownsClaimFn: ownsStripeWebhookClaim,
        });
      }

      // Completion is fenced: an expired worker cannot complete a successor's claim.
      const completionResult = await markStripeEventCompleted(db, event.id, assignedWorkerId, claimToken);
      if (!completionResult.success) {
        throw new Error("Webhook claim lost before completion; reconciliation required.");
      }
      res.status(200).json({ received: true });
    } catch (err: any) {
      console.error("Webhook processing error:", err.message);
      if (db) {
        let rawEventId = event?.id;
        if (!rawEventId && req.body && Buffer.isBuffer(req.body)) {
          try {
            const parsed = JSON.parse(req.body.toString('utf8'));
            rawEventId = parsed.id;
          } catch (_) {}
        }
        if (rawEventId) {
          await markStripeEventFailed(db, rawEventId, err.message, assignedWorkerId, claimToken)
            .catch(e => console.error("Could not update failed status", e));
        }
      }
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  // AT-ADMIN-OPS-07: Do NOT mount 10MB JSON parser before auth/rate-limiting on /api/gemini/call.
  // Skip the default 1MB parser for /api/gemini/call so requireAuth + aiLimiter execute first on that route.
  const defaultJsonParser = express.json({ limit: "1mb" });
  const geminiJsonParser = express.json({ limit: "10mb" });
  app.use((req, res, next) => {
    if (req.path === "/api/gemini/call") {
      return next();
    }
    return defaultJsonParser(req, res, next);
  });

  // API Routes
  app.get("/api/health", (req, res) => {
    if (!isApplicationReady) {
      if (bootstrapError) {
        const isExpectedCredentialBoundary =
          bootstrapError.includes("PERMISSION_DENIED") ||
          bootstrapError.includes("UNAUTHENTICATED") ||
          bootstrapError.includes("Could not load the default credentials");
        if (!isExpectedCredentialBoundary) {
          console.warn("[/api/health] Degraded readiness notice:", bootstrapError);
        }
      }
      return res.status(200).json({
        status: "degraded",
        ready: true,
        bootstrapReady: false,
        message: "AnyTrader UK API running (client SPA mode active)"
      });
    }
    res.json({ status: "ok", ready: true, bootstrapReady: true, message: "AnyTrader UK API is running and ready" });
  });

  app.get("/api/maintenance/status", async (req, res) => {
    const maintenanceMode = await isMaintenanceModeActive({ db });
    res.json({ maintenanceMode });
  });

  app.post("/api/admin/maintenance", requireAdmin, requireAdminTier("super_admin", "toggling maintenance mode"), async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database service unavailable");
      const maintenanceMode = req.body?.maintenanceMode;
      if (typeof maintenanceMode !== "boolean") {
        throw new BadRequestError("maintenanceMode boolean is required.");
      }
      const adminUser = (req as any).user;
      await db.collection("platform_config").doc("global").set({
        maintenanceMode,
        maintenanceModeStartedAt: maintenanceMode ? admin.firestore.FieldValue.serverTimestamp() : null,
        maintenanceModeUpdatedBy: adminUser?.email || adminUser?.uid || "Admin",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: adminUser?.uid || null,
      }, { merge: true });
      invalidateMaintenanceCache(maintenanceMode);

      await db.collection("admin_audit_logs").add({
        action: "toggle_maintenance",
        targetId: "global",
        targetType: "config",
        details: `Turned maintenance mode ${maintenanceMode ? "ON" : "OFF"}`,
        adminUid: adminUser?.uid || null,
        adminEmail: adminUser?.email || null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({ success: true, maintenanceMode });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // Append-only server-authoritative admin audit logging (AT-ADMIN-AUDIT-01)
  app.post("/api/admin/audit-logs", requireAdmin, async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database service unavailable");
      const adminUser = (req as any).user;
      const action = String(req.body?.action || "").trim();
      const targetId = String(req.body?.targetId || "").trim();
      const targetType = String(req.body?.targetType || "").trim();
      const details = String(req.body?.details || "").trim();
      if (!action || !targetId || !targetType) {
        throw new BadRequestError("action, targetId, and targetType are required.");
      }
      const docRef = db.collection("audit_logs").doc();
      await docRef.set({
        id: docRef.id,
        adminId: adminUser?.uid || null,
        adminEmail: adminUser?.email || null,
        action: action.slice(0, 120),
        targetId: targetId.slice(0, 200),
        targetType: targetType.slice(0, 80),
        details: details.slice(0, 2000),
        ipAddress: req.ip || null,
        immutable: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.status(201).json({ success: true, id: docRef.id });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  app.post("/api/admin/login-audit", requireAdmin, async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database service unavailable");
      const adminUser = (req as any).user;
      const docRef = db.collection("admin_login_audits").doc();
      await docRef.set({
        id: docRef.id,
        adminUid: adminUser?.uid || null,
        adminEmail: adminUser?.email || String(req.body?.adminEmail || ""),
        timeZone: String(req.body?.timeZone || "UTC").slice(0, 80),
        userAgent: String(req.headers["user-agent"] || req.body?.userAgent || "").slice(0, 500),
        platform: String(req.body?.platform || "").slice(0, 120),
        ipAddress: req.ip || String(req.body?.clientIp || "").slice(0, 100),
        pinVerified: Boolean(req.body?.pinVerified),
        status: String(req.body?.status || "VERIFIED_UNLOCK").slice(0, 60),
        immutable: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.status(201).json({ success: true, id: docRef.id });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // Global Maintenance / Emergency Stop Gate (AT-ADMIN-OPS-01)
  app.use(
    "/api",
    createMaintenanceEmergencyStopMiddleware({
      getDb: () => db,
      verifyTokenFn: verifyTokenSafely,
      checkIsAdminFn: checkIsAdmin,
    })
  );

  // Free membership selection is server-authoritative; clients cannot write subscription entitlements.
  app.post("/api/select-free-tier", requireAuth, paymentLimiter, async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database service unavailable");
      const userId = String((req as any).user?.uid || "");
      if (!userId) throw new ForbiddenError("Authenticated user is required.");
      const tierName = String(req.body?.tierName || "").trim().toLowerCase();
      const userRef = db.collection("users").doc(userId);
      const userSnap = await userRef.get();
      if (!userSnap.exists) throw new NotFoundError("User profile not found.");
      const userData = userSnap.data() || {};
      const role = String(userData.role || "").toLowerCase();
      const { globalTiers } = await getDynamicFirestoreConfigs(db);

      const terminalStatuses = ["canceled", "unpaid", "incomplete_expired", "free"];
      if (role === "homeowner" || role === "customer") {
        if (!["standard", "standard homeowner"].includes(tierName)) {
          throw new ForbiddenError("Homeowners may select only the Standard free tier without a paid subscription.");
        }
        const configuredPrice = globalTiers?.providerModels?.homeowners?.tiers?.standard?.price;
        if (configuredPrice !== undefined && Number(configuredPrice) !== 0) {
          throw new ForbiddenError("The Standard Homeowner tier is not currently configured as free.");
        }
        const activeLandlordSubId = userData.landlordSubscriptionId || (userData.subscriptionType === "landlord" ? userData.subscriptionId : undefined);
        if (activeLandlordSubId &&
            !terminalStatuses.includes(String(userData.homeownerSubscriptionStatus || ""))) {
          throw new ConflictError("Cancel the active Landlord subscription before selecting the free tier.");
        }
        await db.runTransaction(async (tx: any) => {
          const latest = await tx.get(userRef);
          if (!latest.exists) throw new NotFoundError("User profile not found.");
          const current = latest.data() || {};
          const latestLandlordSubId = current.landlordSubscriptionId || (current.subscriptionType === "landlord" ? current.subscriptionId : undefined);
          if (latestLandlordSubId &&
              !terminalStatuses.includes(String(current.homeownerSubscriptionStatus || ""))) {
            throw new ConflictError("Cancel the active Landlord subscription before selecting the free tier.");
          }
          tx.update(userRef, {
            isLandlord: false,
            homeownerTierId: "standard",
            homeownerSubscriptionStatus: "free",
            homeownerCancelAtPeriodEnd: false,
            homeownerCurrentPeriodEnd: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });
        return res.json({ success: true, fields: {
          isLandlord: false,
          homeownerTierId: "standard",
          homeownerSubscriptionStatus: "free",
          homeownerCancelAtPeriodEnd: false
        }});
      }

      if (!["tradesperson", "business"].includes(role) || !["payg", "free explorer", "free explorer plan"].includes(tierName)) {
        throw new ForbiddenError("This account cannot select the requested free tier.");
      }
      if (userData.subscriptionType !== "landlord" && userData.subscriptionId &&
          !terminalStatuses.includes(String(userData.subscriptionStatus || ""))) {
        throw new ConflictError("Cancel the active membership subscription before selecting the free tier.");
      }
      await db.runTransaction(async (tx: any) => {
        const latest = await tx.get(userRef);
        if (!latest.exists) throw new NotFoundError("User profile not found.");
        const current = latest.data() || {};
        if (current.subscriptionType !== "landlord" && current.subscriptionId &&
            !terminalStatuses.includes(String(current.subscriptionStatus || ""))) {
          throw new ConflictError("Cancel the active membership subscription before selecting the free tier.");
        }
        tx.update(userRef, {
          tierId: "Free Explorer",
          tier: "payg",
          subscriptionStatus: "free",
          subscriptionType: "standard",
          isPro: false,
          isProInvoiceSubscriber: false,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      try {
        const pubRef = db.collection("public_profiles").doc(userId);
        const pubSnap = await pubRef.get();
        if (pubSnap.exists) {
          await pubRef.update({
            tierId: "Free Explorer",
            tier: "payg",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      } catch { /* non-fatal public profile sync */ }
      res.json({ success: true, fields: {
        tierId: "Free Explorer",
        tier: "payg",
        subscriptionStatus: "free",
        isPro: false,
        isProInvoiceSubscriber: false,
        cancelAtPeriodEnd: false
      }});
    } catch (error: any) {
      console.error("Select Free Tier Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Stripe Checkout Session (Server-Authoritative Pricing & Stripe Connect Routing)
  app.post("/api/create-checkout-session", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter, async (req, res) => {
    try {
      const authUid = (req as any).user.uid;
      const { successUrl, cancelUrl } = req.body;
      const userId = authUid; // Derive strictly from verified Firebase token
      const appUrl = getAuthoritativeAppUrl();

      const finalSuccessUrl = sanitizeRedirectUrl(successUrl, appUrl, `/profile?session_id={CHECKOUT_SESSION_ID}`);
      const finalCancelUrl = sanitizeRedirectUrl(cancelUrl, appUrl, `/profile`);

      // 1. Resolve strictly server-authoritative pricing and Stripe Connect routing
      // Completely bypasses and ignores client-provided price_data to prevent price manipulation
      const authoritativeResult = await resolveAuthoritativeLineItem(req.body, authUid, db);
      
      // CREATE PRE-CHECKOUT INTENT (Fixes C-01 and C-03 by never trusting Stripe metadata)
      const intentId = `chk_intent_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const sanitizedDisputePhotoUrls =
        authoritativeResult.metadata?.type === "mediation_stake" && Array.isArray(req.body?.disputePhotoUrls)
          ? req.body.disputePhotoUrls
              .filter((u: any) => typeof u === "string" && /^https?:\/\//i.test(u))
              .slice(0, 8)
          : [];
      if (db) {
         await db.collection("payment_intents").doc(intentId).set({
            intentId,
            userId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            metadata: authoritativeResult.metadata,
            mode: authoritativeResult.mode,
            amount: authoritativeResult.authoritativeAmountPence || 0,
            ...(sanitizedDisputePhotoUrls.length > 0 ? { disputePhotoUrls: sanitizedDisputePhotoUrls } : {}),
            status: "pending"
         });
      }

      let stripe;
      try {
        stripe = getStripe();
      } catch (e) {
        if (process.env.NODE_ENV === 'production' || process.env.ALLOW_MOCK_PAYMENTS !== 'true') {
          console.error("Stripe is not configured in production/live environment. Refusing mock checkout bypass.");
          return res.status(503).json({ error: "Payment processing is currently unavailable: Stripe gateway is unconfigured." });
        }
        console.warn("Stripe is not configured. Mocking successful checkout flow for development testing.");
        
        // Authoritative Mock Fulfillment for local dev/testing
        if (db) {
          const meta = authoritativeResult.metadata;
          if (meta.isVideoPro === 'true' || meta.type === 'video_pro_subscription') {
            await db.collection("users").doc(userId).set({
              hasVerifiedVideoProSubscription: true,
              videoProSubscriptionStatus: "active",
              videoProCancelAtPeriodEnd: false,
              videoProSubscribedAt: new Date().toISOString(),
              videoProSubscriptionId: "mock_sub_vpro_" + Math.random().toString(36).substring(7),
              videoProCurrentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
          } else if (meta.isExclusiveAddon === 'true' || meta.type === 'exclusive_leads') {
            await db.collection("users").doc(userId).set({
              hasExclusiveAddon: true,
              isExclusiveActive: true,
              exclusiveSubscriptionStatus: "active",
              exclusiveCancelAtPeriodEnd: false,
              exclusiveSubscribedAt: new Date().toISOString(),
              exclusiveSubscriptionId: "mock_sub_excl_" + Math.random().toString(36).substring(7),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
          } else if (meta.type === 'appointments' || meta.subscriptionType === 'appointments') {
            const existingSnap = await db.collection("users").doc(userId).get();
            const existingApptSettings = existingSnap.exists ? (existingSnap.data()?.appointmentSettings || {}) : {};
            await db.collection("users").doc(userId).set({
              hasAppointmentsAddon: true,
              appointmentsSubscriptionStatus: "active",
              appointmentsCancelAtPeriodEnd: false,
              appointmentsSubscribedAt: new Date().toISOString(),
              appointmentsSubscriptionId: "mock_sub_appt_" + Math.random().toString(36).substring(7),
              appointmentsCurrentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              appointmentSettings: { ...existingApptSettings, enabled: true },
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
          } else if (meta.subscriptionType === 'gotham_saas' || meta.type === 'gotham_saas') {
            const mockGothamSubscriptionId = "mock_sub_gotham_" + Math.random().toString(36).substring(7);
            const mockGothamPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
            await db.collection("users").doc(userId).set({
              tierId: meta.gothamTierName || "Gotham Enterprise",
              tier: "gotham",
              subscriptionType: "gotham_saas",
              isGothamSubscriber: true,
              gothamSubscriptionId: mockGothamSubscriptionId,
              gothamSubscriptionStatus: "active",
              gothamDoorsCount: Number(meta.gothamDoorsCount) || 100,
              gothamTierName: meta.gothamTierName || "Gotham Enterprise",
              gothamBillingCycle: meta.gothamBillingCycle || "monthly",
              gothamCancelAtPeriodEnd: false,
              gothamCurrentPeriodEnd: mockGothamPeriodEnd,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
          } else if (meta.subscriptionType === 'driver_gold' || meta.type === 'driver_gold') {
            const mockDriverSubscriptionId = "mock_sub_gold_driver_" + Math.random().toString(36).substring(7);
            const mockDriverPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
            await db.collection("users").doc(userId).set({
              tierId: "Gold Driver",
              tier: "gold",
              driverTier: "gold",
              subscriptionType: "driver_gold",
              isGoldDriver: true,
              driverSubscriptionId: mockDriverSubscriptionId,
              driverSubscriptionStatus: "active",
              commissionRate: 0.10,
              destinationFilters: 4,
              advanceBookingDays: 14,
              priorityDispatch: 50,
              driverCancelAtPeriodEnd: false,
              driverCurrentPeriodEnd: mockDriverPeriodEnd,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
          } else if (authoritativeResult.mode === 'subscription' && (meta.subscriptionType === 'landlord' || meta.tier === 'landlord')) {
            const mockLandlordSubscriptionId = "mock_sub_landlord_" + Math.random().toString(36).substring(7);
            const mockLandlordPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            await db.collection("users").doc(userId).set({
              ...buildLandlordCheckoutFulfillmentPatch(
                mockLandlordSubscriptionId,
                { status: "active", cancel_at_period_end: false, current_period_end: Math.floor(mockLandlordPeriodEnd.getTime() / 1000) }
              ),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
          } else if (authoritativeResult.mode === 'subscription') {
            const canonicalTier = meta.tier || 'pro';
            await db.collection("users").doc(userId).set({
              tierId: meta.tierName || "Pro",
              tier: canonicalTier,
              subscriptionType: canonicalTier !== 'payg' ? 'tier' : 'standard',
              isPro: canonicalTier !== 'payg',
              isProInvoiceSubscriber: canonicalTier !== 'payg',
              subscriptionStatus: "active",
              cancelAtPeriodEnd: false,
              subscriptionId: "mock_sub_" + Math.random().toString(36).substring(7),
              currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
          } else if (authoritativeResult.mode === 'payment') {
            if (meta.type === 'ad_wallet_topup' || meta.type === 'banner_ad') {
              const topupAmount = meta.type === 'banner_ad'
                ? Number(meta.totalPence || 0) / 100
                : (Number(meta.topupAmount) || 0);
              if (topupAmount > 0) {
                await db.collection("users").doc(userId).set({
                  adWalletBalance: admin.firestore.FieldValue.increment(topupAmount),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
              }
            } else if (meta.type === 'milestone_funding' && meta.jobId && meta.quoteId && meta.milestoneId) {
              const { jobId, quoteId, milestoneId } = meta;
              const quoteRef = db.collection("jobs").doc(jobId).collection("quotes").doc(quoteId);
              const quoteDoc = await quoteRef.get();
              if (quoteDoc.exists) {
                const quoteData = quoteDoc.data();
                const milestones = quoteData?.milestones || [];
                const platformFeePence = meta.platformFeePence !== undefined ? Number(meta.platformFeePence) : undefined;
                const netPayoutPence = meta.netPayoutPence !== undefined ? Number(meta.netPayoutPence) : undefined;
                const appliedCommissionRate = meta.appliedCommissionRate !== undefined ? Number(meta.appliedCommissionRate) : undefined;
                const commissionCapGbp = meta.commissionCapGbp !== undefined ? Number(meta.commissionCapGbp) : undefined;
                const updatedMilestones = milestones.map((m: any) => {
                  if (m.id === milestoneId) {
                    return {
                      ...m,
                      status: 'funded',
                      fundedAt: new Date().toISOString(),
                      stripePaymentIntentId: intentId,
                      isDestinationCharge: Boolean(authoritativeResult.paymentIntentData),
                      ...(platformFeePence !== undefined && Number.isFinite(platformFeePence) ? { platformFeePence } : {}),
                      ...(netPayoutPence !== undefined && Number.isFinite(netPayoutPence) ? { netPayoutPence } : {}),
                      ...(appliedCommissionRate !== undefined && Number.isFinite(appliedCommissionRate) ? { appliedCommissionRate } : {}),
                      ...(commissionCapGbp !== undefined && Number.isFinite(commissionCapGbp) ? { commissionCapGbp } : {}),
                    };
                  }
                  return m;
                });
                await quoteRef.update({ milestones: updatedMilestones });
                const allMilestonesFunded =
                  updatedMilestones.length > 0 &&
                  updatedMilestones.every((m: any) => ["funded", "submitted", "approved", "released"].includes(String(m.status || "").toLowerCase()));
                await db.collection("jobs").doc(jobId).update({
                  paymentStatus: allMilestonesFunded ? "funded" : "partially_funded",
                  updatedAt: new Date().toISOString(),
                });

                // Record to immutable payment ledger with exact authoritative commission from pricingCatalog
                await PaymentLedgerEngine.recordEscrowFunding(db, {
                  jobId,
                  milestoneId,
                  paymentIntentId: intentId,
                  idempotencyKey: `mock_fund_${jobId}_${milestoneId}`,
                  customerId: userId,
                  traderId: meta.traderId || quoteData?.tradespersonId || "trader",
                  verifiedAmount: authoritativeResult.authoritativeAmountPence,
                  currency: "gbp",
                  ...(platformFeePence !== undefined && Number.isFinite(platformFeePence) ? { platformFeePence } : {}),
                  ...(appliedCommissionRate !== undefined && Number.isFinite(appliedCommissionRate) ? { appliedCommissionRate } : {}),
                  ...(commissionCapGbp !== undefined && Number.isFinite(commissionCapGbp) ? { commissionCapGbp } : {}),
                });

                await db.collection("notifications").add({
                  userId: quoteData?.tradespersonId,
                  title: "Milestone Funded! 💰",
                  message: `Homeowner funded "${milestones.find((m: any) => m.id === milestoneId)?.title || 'Milestone'}". You can now start work!`,
                  type: "status",
                  link: `/job/${jobId}`,
                  read: false,
                  createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
              }
            } else if (meta.type === 'mediation_stake' && meta.jobId) {
              const isPropertyDamageFlag = String(meta.isPropertyDamage || "").toLowerCase() === "true";
              await db.collection("jobs").doc(meta.jobId).update({
                status: "disputed",
                mediationStakePaid: true,
                "dispute.status": "pending_arbitration",
                "dispute.reason": meta.disputeReason || "Unspecified",
                "dispute.technicalFaultReport": meta.technicalFaultReport || "Unspecified",
                "dispute.isPropertyDamage": isPropertyDamageFlag,
                "dispute.raisedBy": userId,
                "dispute.createdAt": admin.firestore.FieldValue.serverTimestamp(),
                "dispute.mediationStakePaid": true,
                ...(sanitizedDisputePhotoUrls.length > 0 ? { "dispute.photos": sanitizedDisputePhotoUrls } : {}),
                disputeReason: meta.disputeReason || "Unspecified",
                technicalFaultReport: meta.technicalFaultReport || "Unspecified",
                disputedAt: admin.firestore.FieldValue.serverTimestamp()
              });
              try {
                const pubCardSnap = await db.collection("public_job_cards").doc(meta.jobId).get();
                if (pubCardSnap.exists) {
                  await db.collection("public_job_cards").doc(meta.jobId).update({
                    status: "disputed",
                    updatedAt: new Date().toISOString(),
                  });
                }
              } catch { /* non-blocking public card sync */ }
            } else if (meta.jobId && meta.type === 'boost') {
              const boostExpiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
              const isIM = meta.tier === 'instant_match';
              await db.collection("jobs").doc(meta.jobId).set({
                isBoosted: true,
                boostTier: meta.tier || 'emergency_boost',
                boostExpiresAt,
                postedDate: admin.firestore.FieldValue.serverTimestamp(),
                isInstantMatch: isIM,
                isEmergencyBoost: meta.tier === 'emergency_boost',
                retryCount: 0
              }, { merge: true });

              try {
                await db.collection("public_job_cards").doc(meta.jobId).set({
                  isBoosted: true,
                  boostTier: meta.tier || 'emergency_boost',
                  isInstantMatch: isIM,
                  updatedAt: new Date().toISOString()
                }, { merge: true });
              } catch (pubErr) {
                console.warn("Could not sync public_job_cards for mock boost:", pubErr);
              }

              if (isIM) {
                const matchRef = db.collection("instant_matches").doc();
                await matchRef.set({
                  id: matchRef.id,
                  jobId: meta.jobId,
                  customerId: userId,
                  chargeAmountPence: 299,
                  chargeTier: "instant_match",
                  feeWaived: false,
                  status: "searching",
                  currentAttempt: 0,
                  createdAt: admin.firestore.FieldValue.serverTimestamp(),
                  searchingAt: admin.firestore.FieldValue.serverTimestamp()
                });
                await db.collection("jobs").doc(meta.jobId).set({
                  instantMatchId: matchRef.id,
                  matchedViaInstantMatch: true
                }, { merge: true });
              }
            }
          }
        }
        return res.json({ url: finalSuccessUrl.replace("{CHECKOUT_SESSION_ID}", "mock_session_success") });
      }

      // Real Stripe Flow (AT-PAY-24: transactional customerId reservation)
      let customerId: string | undefined;
      if (userId && db) {
        customerId = await ensureStripeCustomerIdForUser({ db, stripe, userId });
      }

      // Guard against accidental duplicate active subscriptions & support seamless in-place Trader Tier upgrades
      if (authoritativeResult.mode === "subscription" && userId && db) {
        const userSnap = await db.collection("users").doc(userId).get();
        const userData = userSnap.exists ? (userSnap.data() || {}) : {};
        const meta = authoritativeResult.metadata || {};
        const activeStatuses = new Set(["active", "trialing"]);

        if (meta.subscriptionType === "tier" && userData.subscriptionType !== "landlord") {
          const existingSubId = typeof userData.subscriptionId === "string" ? userData.subscriptionId.trim() : "";
          if (existingSubId && existingSubId.startsWith("sub_")) {
            try {
              const liveSub = await stripe.subscriptions.retrieve(existingSubId);
              const liveCustomer = typeof liveSub.customer === "string" ? liveSub.customer : liveSub.customer?.id;
              if ((!customerId || liveCustomer === customerId) && activeStatuses.has(String(liveSub.status || ""))) {
                const firstItem = liveSub.items?.data?.[0];
                const existingProductId = typeof firstItem?.price?.product === "string"
                  ? firstItem.price.product
                  : firstItem?.price?.product?.id;
                if (firstItem?.id && existingProductId) {
                  const updatedSub = await stripe.subscriptions.update(existingSubId, {
                    items: [{
                      id: firstItem.id,
                      price_data: {
                        currency: "gbp",
                        product: existingProductId,
                        unit_amount: authoritativeResult.authoritativeAmountPence,
                        recurring: { interval: "month" },
                      },
                    }],
                    cancel_at_period_end: false,
                    proration_behavior: "create_prorations",
                    metadata: {
                      tier: meta.tier || "pro",
                      tierName: meta.tierName || "Silver Pro Subscription",
                      userId,
                    },
                  });
                  const canonicalTier = meta.tier || "pro";
                  const tierName = meta.tierName || "Silver Pro Subscription";
                  const periodEndIso = updatedSub.current_period_end
                    ? new Date(updatedSub.current_period_end * 1000).toISOString()
                    : undefined;
                  await db.collection("users").doc(userId).update({
                    tier: canonicalTier,
                    tierId: tierName,
                    subscriptionStatus: updatedSub.status || "active",
                    subscriptionType: "tier",
                    isPro: true,
                    isProInvoiceSubscriber: true,
                    cancelAtPeriodEnd: false,
                    ...(periodEndIso ? { currentPeriodEnd: periodEndIso } : {}),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                  try {
                    const pubRef = db.collection("public_profiles").doc(userId);
                    const pubSnap = await pubRef.get();
                    if (pubSnap.exists) {
                      await pubRef.update({
                        tier: canonicalTier,
                        tierId: tierName,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                      });
                    }
                  } catch { /* non-fatal public profile sync */ }
                  await db.collection("payment_intents").doc(intentId).update({
                    status: "completed",
                    upgradedInPlace: true,
                    subscriptionId: updatedSub.id,
                    completedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                  return res.json({
                    upgraded: true,
                    tier: canonicalTier,
                    tierName,
                    subscriptionId: updatedSub.id,
                    currentPeriodEnd: periodEndIso,
                    message: `Successfully switched to ${tierName} on your existing Stripe subscription with automatic proration.`,
                  });
                }
              }
            } catch (subErr: any) {
              // If the old subscription no longer exists in Stripe (404), fall through to fresh Checkout
              if (Number(subErr?.statusCode) !== 404 && subErr?.code !== "resource_missing") {
                throw subErr;
              }
            }
          }
        } else {
          // Prevent duplicate active subscriptions for single-instance add-ons & plans
          const duplicateChecks: Array<{ match: boolean; label: string; subId?: string; status?: string }> = [
            {
              match: meta.subscriptionType === "landlord" || meta.tier === "landlord",
              label: "Landlord Pro",
              subId: userData.landlordSubscriptionId || (userData.subscriptionType === "landlord" ? userData.subscriptionId : undefined),
              status: userData.homeownerSubscriptionStatus,
            },
            {
              match: meta.isExclusiveAddon === "true" || meta.type === "exclusive_leads",
              label: "Priority Exclusive Leads",
              subId: userData.exclusiveSubscriptionId,
              status: userData.exclusiveSubscriptionStatus || (userData.hasExclusiveAddon ? "active" : undefined),
            },
            {
              match: meta.isVideoPro === "true" || meta.type === "video_pro_subscription",
              label: "Verified Video Pro",
              subId: userData.videoProSubscriptionId,
              status: userData.videoProSubscriptionStatus || (userData.hasVerifiedVideoProSubscription ? "active" : undefined),
            },
            {
              match: meta.type === "appointments" || meta.subscriptionType === "appointments",
              label: "Automated Appointments",
              subId: userData.appointmentsSubscriptionId,
              status: userData.appointmentsSubscriptionStatus || (userData.hasAppointmentsAddon ? "active" : undefined),
            },
            {
              match: meta.type === "gotham_saas" || meta.subscriptionType === "gotham_saas",
              label: "Gotham B2B SaaS",
              subId: userData.gothamSubscriptionId,
              status: userData.gothamSubscriptionStatus || (userData.isGothamSubscriber ? "active" : undefined),
            },
          ];
          for (const check of duplicateChecks) {
            if (check.match && check.subId && activeStatuses.has(String(check.status || "").toLowerCase())) {
              throw new ConflictError(`You already have an active ${check.label} subscription. Manage or resume it in Billing.`);
            }
          }
        }
      }

      const sessionOptions: any = {
        mode: authoritativeResult.mode as any,
        payment_method_types: ['card'],
        line_items: [authoritativeResult.lineItem],
        success_url: finalSuccessUrl,
        cancel_url: finalCancelUrl,
        client_reference_id: userId,
        // C-03: Pass ONLY the intent ID to Stripe. Do not expose or trust free-form metadata.
        metadata: { intentId },
      };

      // Direct Stripe Connect destination charge for client funds:
      // Platform never holds client money; only platform fee goes to platform account
      if (authoritativeResult.paymentIntentData) {
        sessionOptions.payment_intent_data = authoritativeResult.paymentIntentData;
      }

      if (customerId) {
        sessionOptions.customer = customerId;
        if (authoritativeResult.mode === 'payment') {
          sessionOptions.saved_payment_method_options = {
            payment_method_save: "enabled",
          };
        }
      }

      const session = await stripe.checkout.sessions.create(sessionOptions);
      if (!db) throw new Error("Checkout intent database binding is unavailable.");
      const sessionPaymentIntentId = typeof session.payment_intent === "string"
        ? session.payment_intent
        : typeof (session.payment_intent as any)?.id === "string"
          ? (session.payment_intent as any).id
          : null;
      await db.collection("payment_intents").doc(intentId).update({
        checkoutSessionId: session.id,
        currency: String(session.currency || "gbp").toLowerCase(),
        paymentIntentId: sessionPaymentIntentId,
        status: "session_created",
        sessionCreatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      res.json({ url: session.url });
    } catch (error: any) {
      console.error("Stripe Checkout Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Stripe Setup Session (Save Card)
  app.post("/api/create-setup-session", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter, async (req, res) => {
    try {
      const authUid = (req as any).user.uid;
      const { successUrl, cancelUrl } = req.body;
      const userId = authUid; // Derive strictly from verified token
      const appUrl = getAuthoritativeAppUrl();

      const finalSuccessUrl = sanitizeRedirectUrl(successUrl, appUrl, `/profile?setup=success`);
      const finalCancelUrl = sanitizeRedirectUrl(cancelUrl, appUrl, `/profile`);

      let stripe;
      try {
        stripe = getStripe();
      } catch (e) {
        if (process.env.NODE_ENV === 'production' || process.env.ALLOW_MOCK_PAYMENTS !== 'true') {
          console.error("Stripe is not configured in production/live environment. Refusing mock setup bypass.");
          return res.status(503).json({ error: "Card setup is currently unavailable: Stripe gateway is unconfigured." });
        }
        console.warn("Stripe is not configured. Mocking successful setup flow for development testing.");
        return res.json({ url: finalSuccessUrl });
      }

      if (!db) {
        return res.status(503).json({ error: "Database service unavailable" });
      }

      const customerId = await ensureStripeCustomerIdForUser({ db, stripe, userId });

      if (!customerId) {
        return res.status(400).json({ error: "Could not identify or create Stripe customer." });
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'setup',
        payment_method_types: ['card'],
        customer: customerId,
        success_url: finalSuccessUrl,
        cancel_url: finalCancelUrl,
        client_reference_id: userId,
      });

      res.json({ url: session.url });
    } catch (error: any) {
      console.error("Stripe Setup Error:", error);
      res.status(500).json({ error: error.message || "Failed to create setup session" });
    }
  });

  // List Saved Cards (with real Stripe default_payment_method status)
  app.get("/api/payment-methods/:userId", requireAuth, async (req, res) => {
    try {
      const { userId } = req.params;
      if (!db) return res.json({ paymentMethods: [], defaultPaymentMethodId: null, mock: true });

      if ((req as any).user.uid !== userId) {
        return res.status(403).json({ error: "Forbidden: Not your payment methods" });
      }

      const userDoc = await db.collection("users").doc(userId).get();
      if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

      const stripeCustomerId = userDoc.data()?.stripeCustomerId;
      if (!stripeCustomerId) return res.json({ paymentMethods: [], defaultPaymentMethodId: null });

      let stripe;
      try {
        stripe = getStripe();
      } catch (e) {
        return res.json({ paymentMethods: [], defaultPaymentMethodId: null, mock: true });
      }

      const { paymentMethods, defaultPaymentMethodId } = await listCustomerPaymentMethods({
        stripe,
        stripeCustomerId,
      });

      res.json({ paymentMethods, defaultPaymentMethodId });
    } catch (error: any) {
      console.error("Fetch Payment Methods Error:", error);
      const status = error instanceof PaymentMethodRouteError ? error.statusCode : 500;
      res.status(status).json({ error: error.message || "Failed to fetch payment methods" });
    }
  });

  // Set Real Stripe Default Payment Method
  app.post("/api/payment-methods/:userId/:paymentMethodId/default", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter, async (req, res) => {
    try {
      const { userId, paymentMethodId } = req.params;
      if ((req as any).user.uid !== userId) {
        return res.status(403).json({ error: "Forbidden: Not your payment method" });
      }

      if (!db) {
        return res.status(503).json({ error: "Database service unavailable" });
      }

      const userDoc = await db.collection("users").doc(userId).get();
      if (!userDoc.exists) {
        return res.status(404).json({ error: "User profile not found" });
      }

      const stripeCustomerId = userDoc.data()?.stripeCustomerId;
      if (!stripeCustomerId) {
        return res.status(400).json({ error: "No Stripe customer found for this profile" });
      }

      let stripe;
      try {
        stripe = getStripe();
      } catch (e) {
        if (process.env.NODE_ENV === "production" || process.env.ALLOW_MOCK_PAYMENTS !== "true") {
          return res.status(503).json({ error: "Stripe gateway is unconfigured." });
        }
        return res.json({ success: true, defaultPaymentMethodId: paymentMethodId, mock: true });
      }

      const result = await setCustomerDefaultPaymentMethod({
        stripe,
        stripeCustomerId,
        paymentMethodId,
      });

      res.json({ success: true, defaultPaymentMethodId: result.defaultPaymentMethodId });
    } catch (error: any) {
      console.error("Set Default Payment Method Error:", error);
      const status = error instanceof PaymentMethodRouteError ? error.statusCode : 500;
      res.status(status).json({ error: error.message || "Failed to update default payment method" });
    }
  });

  // Delete Saved Card (with ownership verification and automatic default promotion)
  app.delete("/api/payment-methods/:userId/:paymentMethodId", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter, async (req, res) => {
    try {
      const { userId, paymentMethodId } = req.params;
      if ((req as any).user.uid !== userId) {
        return res.status(403).json({ error: "Forbidden: Not your payment method" });
      }

      if (!db) {
        return res.status(503).json({ error: "Database service unavailable" });
      }

      const userDoc = await db.collection("users").doc(userId).get();
      if (!userDoc.exists) {
        return res.status(404).json({ error: "User profile not found" });
      }

      const stripeCustomerId = userDoc.data()?.stripeCustomerId;
      if (!stripeCustomerId) {
        return res.status(400).json({ error: "No Stripe customer found for this profile" });
      }

      let stripe;
      try {
        stripe = getStripe();
      } catch (e) {
        if (process.env.NODE_ENV === "production" || process.env.ALLOW_MOCK_PAYMENTS !== "true") {
          return res.status(503).json({ error: "Stripe gateway is unconfigured." });
        }
        return res.json({ success: true, defaultPaymentMethodId: null, mock: true });
      }

      const result = await detachCustomerPaymentMethod({
        stripe,
        stripeCustomerId,
        paymentMethodId,
      });

      res.json({ success: true, detachedId: result.detachedId, defaultPaymentMethodId: result.defaultPaymentMethodId });
    } catch (error: any) {
      console.error("Delete Payment Method Error:", error);
      const status = error instanceof PaymentMethodRouteError ? error.statusCode : 500;
      res.status(status).json({ error: error.message || "Failed to delete payment method" });
    }
  });

  // Stripe Customer Portal Session (Manage subscriptions, cancel, update cards, invoices)
  app.post("/api/create-customer-portal-session", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter, async (req, res) => {
    try {
      const authUid = (req as any).user.uid;
      const appUrl = getAuthoritativeAppUrl();
      const { returnUrl } = req.body;
      const finalReturnUrl = sanitizeRedirectUrl(returnUrl, appUrl, `/billing`);

      if (!db) {
        return res.status(503).json({ error: "Database service unavailable" });
      }

      const userDoc = await db.collection("users").doc(authUid).get();
      if (!userDoc.exists) {
        return res.status(404).json({ error: "User profile not found" });
      }

      const userData = userDoc.data();
      let customerId = typeof userData?.stripeCustomerId === "string" ? userData.stripeCustomerId.trim() : "";

      let stripe;
      try {
        stripe = getStripe();
      } catch (e) {
        return res.status(503).json({
          error: "Billing portal is currently unavailable: Stripe gateway is unconfigured.",
          code: "STRIPE_UNCONFIGURED"
        });
      }

      if (!customerId) {
        customerId = await ensureStripeCustomerIdForUser({
          db,
          stripe,
          userId: authUid,
        });
      }

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: finalReturnUrl,
      });

      if (!portalSession?.url) {
        return res.status(502).json({
          error: "Stripe did not return a billing portal URL. Please retry or contact support."
        });
      }

      res.json({ url: portalSession.url });
    } catch (error: any) {
      console.error("Customer Portal Session Error:", error);
      const stripeStatus = Number(error?.statusCode);
      const status =
        stripeStatus >= 400 && stripeStatus < 500
          ? stripeStatus
          : stripeStatus === 503
          ? 503
          : 502;
      res.status(status).json({ error: error.message || "Failed to create Stripe billing portal session" });
    }
  });

  // Cancel Subscription at Next Renewal Date (Cancel at Period End)
  app.post("/api/cancel-subscription", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter, async (req, res) => {
    try {
      const authUid = (req as any).user.uid;
      const { subscriptionType: requestedType = "tier", subscriptionId: requestedSubscriptionId } = req.body || {};

      if (!db) {
        return res.status(503).json({ error: "Database service unavailable" });
      }

      const userDoc = await db.collection("users").doc(authUid).get();
      if (!userDoc.exists) {
        return res.status(404).json({ error: "User profile not found" });
      }

      const userData = userDoc.data() || {};
      const verifiedTarget = resolveVerifiedSubscriptionTarget({
        userData,
        requestedType,
        requestedSubscriptionId,
        action: "cancel",
      });
      const subscriptionType = verifiedTarget.subscriptionType;
      const subId = verifiedTarget.subscriptionId;

      let fieldUpdates: any = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      if (subscriptionType === "landlord") {
        fieldUpdates.homeownerCancelAtPeriodEnd = true;
        if (userData.homeownerCurrentPeriodEnd) fieldUpdates.homeownerCurrentPeriodEnd = userData.homeownerCurrentPeriodEnd;
      } else if (subscriptionType === "exclusive_leads") {
        const currentEnd = userData.exclusiveCurrentPeriodEnd;
        fieldUpdates.exclusiveCancelAtPeriodEnd = true;
        if (currentEnd) fieldUpdates.exclusiveCurrentPeriodEnd = currentEnd;
      } else if (subscriptionType === "video_pro") {
        const currentEnd = userData.videoProCurrentPeriodEnd;
        fieldUpdates.videoProCancelAtPeriodEnd = true;
        if (currentEnd) fieldUpdates.videoProCurrentPeriodEnd = currentEnd;
      } else if (subscriptionType === "appointments") {
        const currentEnd = userData.appointmentsCurrentPeriodEnd;
        fieldUpdates.appointmentsCancelAtPeriodEnd = true;
        if (currentEnd) fieldUpdates.appointmentsCurrentPeriodEnd = currentEnd;
      } else if (subscriptionType === "gotham_saas") {
        fieldUpdates.gothamCancelAtPeriodEnd = true;
        const currentEnd = userData.gothamCurrentPeriodEnd || userData.currentPeriodEnd;
        if (currentEnd) {
          fieldUpdates.gothamCurrentPeriodEnd = currentEnd;
        }
      } else if (subscriptionType === "driver_gold") {
        const currentEnd = userData.driverCurrentPeriodEnd || userData.currentPeriodEnd;
        fieldUpdates.driverCancelAtPeriodEnd = true;
        if (currentEnd) {
          fieldUpdates.driverCurrentPeriodEnd = currentEnd;
        }
      } else {
        const currentEnd = userData.currentPeriodEnd;
        fieldUpdates.cancelAtPeriodEnd = true;
        if (currentEnd) fieldUpdates.currentPeriodEnd = currentEnd;
      }

      const hasMockSubscriptionId = isMockSubscriptionId(subId);
      const isExplicitMockSubscription = isExplicitMockSubscriptionAllowed(
        subId,
        process.env.NODE_ENV,
        process.env.ALLOW_MOCK_PAYMENTS
      );
      if (hasMockSubscriptionId && !isExplicitMockSubscription) {
        return res.status(409).json({ error: "Mock subscription IDs are only valid in non-production with ALLOW_MOCK_PAYMENTS=true." });
      }

      let stripe;
      try {
        stripe = getStripe();
      } catch (e) {
        if (!isExplicitMockSubscription) {
          return res.status(503).json({ error: "Stripe is unavailable; cancellation was not changed." });
        }
        await db.collection("users").doc(authUid).update(fieldUpdates);
        return res.json({
          success: true,
          mock: true,
          cancelAtPeriodEnd: true,
          currentPeriodEnd: fieldUpdates.currentPeriodEnd || fieldUpdates.homeownerCurrentPeriodEnd || fieldUpdates.exclusiveCurrentPeriodEnd || fieldUpdates.videoProCurrentPeriodEnd || fieldUpdates.gothamCurrentPeriodEnd || fieldUpdates.driverCurrentPeriodEnd,
          message: "Subscription set to cancel at the end of the current billing cycle without renewing."
        });
      }

      if (!isExplicitMockSubscription) {
        const liveSub = await stripe.subscriptions.retrieve(subId);
        const liveCustomer = typeof liveSub.customer === "string" ? liveSub.customer : liveSub.customer?.id;
        if (userData.stripeCustomerId && liveCustomer && liveCustomer !== userData.stripeCustomerId) {
          return res.status(403).json({ error: "Forbidden: Stripe subscription customer does not match the caller account." });
        }
        if (liveSub.status === "canceled") {
          return res.status(409).json({ error: "Subscription is already canceled in Stripe." });
        }

        const updatedSub = await stripe.subscriptions.update(subId, {
          cancel_at_period_end: true
        });

        const periodEndIso = new Date(updatedSub.current_period_end * 1000).toISOString();
        if (subscriptionType === "landlord") {
          fieldUpdates.homeownerCancelAtPeriodEnd = true;
          fieldUpdates.homeownerCurrentPeriodEnd = periodEndIso;
        } else if (subscriptionType === "exclusive_leads") {
          fieldUpdates.exclusiveCancelAtPeriodEnd = true;
          fieldUpdates.exclusiveCurrentPeriodEnd = periodEndIso;
        } else if (subscriptionType === "video_pro") {
          fieldUpdates.videoProCancelAtPeriodEnd = true;
          fieldUpdates.videoProCurrentPeriodEnd = periodEndIso;
        } else if (subscriptionType === "appointments") {
          fieldUpdates.appointmentsCancelAtPeriodEnd = true;
          fieldUpdates.appointmentsCurrentPeriodEnd = periodEndIso;
        } else if (subscriptionType === "gotham_saas") {
          fieldUpdates.gothamCancelAtPeriodEnd = true;
          fieldUpdates.gothamCurrentPeriodEnd = periodEndIso;
        } else if (subscriptionType === "driver_gold") {
          fieldUpdates.driverCancelAtPeriodEnd = true;
          fieldUpdates.driverCurrentPeriodEnd = periodEndIso;
        } else {
          fieldUpdates.cancelAtPeriodEnd = true;
          fieldUpdates.currentPeriodEnd = periodEndIso;
        }
      }

      await db.collection("users").doc(authUid).update(fieldUpdates);

      res.json({
        success: true,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: fieldUpdates.currentPeriodEnd || fieldUpdates.homeownerCurrentPeriodEnd || fieldUpdates.exclusiveCurrentPeriodEnd || fieldUpdates.videoProCurrentPeriodEnd || fieldUpdates.appointmentsCurrentPeriodEnd || fieldUpdates.gothamCurrentPeriodEnd || fieldUpdates.driverCurrentPeriodEnd,
        message: "Subscription will cancel at the end of the current billing cycle. You will retain all benefits until your renewal date."
      });
    } catch (error: any) {
      console.error("Cancel Subscription Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Reactivate / Resume Subscription Before Period End
  app.post("/api/reactivate-subscription", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter, async (req, res) => {
    try {
      const authUid = (req as any).user.uid;
      const { subscriptionType: requestedType = "tier", subscriptionId: requestedSubscriptionId } = req.body || {};

      if (!db) {
        return res.status(503).json({ error: "Database service unavailable" });
      }

      const userDoc = await db.collection("users").doc(authUid).get();
      if (!userDoc.exists) {
        return res.status(404).json({ error: "User profile not found" });
      }

      const userData = userDoc.data() || {};
      const verifiedTarget = resolveVerifiedSubscriptionTarget({
        userData,
        requestedType,
        requestedSubscriptionId,
        action: "reactivate",
      });
      const subscriptionType = verifiedTarget.subscriptionType;
      const subId = verifiedTarget.subscriptionId;

      let fieldUpdates: any = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      if (subscriptionType === "landlord") {
        fieldUpdates.homeownerCancelAtPeriodEnd = false;
      } else if (subscriptionType === "exclusive_leads") {
        fieldUpdates.exclusiveCancelAtPeriodEnd = false;
      } else if (subscriptionType === "video_pro") {
        fieldUpdates.videoProCancelAtPeriodEnd = false;
      } else if (subscriptionType === "appointments") {
        fieldUpdates.appointmentsCancelAtPeriodEnd = false;
      } else if (subscriptionType === "gotham_saas") {
        fieldUpdates.gothamCancelAtPeriodEnd = false;
      } else if (subscriptionType === "driver_gold") {
        fieldUpdates.driverCancelAtPeriodEnd = false;
      } else {
        fieldUpdates.cancelAtPeriodEnd = false;
      }

      const hasMockSubscriptionId = isMockSubscriptionId(subId);
      const isExplicitMockSubscription = isExplicitMockSubscriptionAllowed(
        subId,
        process.env.NODE_ENV,
        process.env.ALLOW_MOCK_PAYMENTS
      );
      if (hasMockSubscriptionId && !isExplicitMockSubscription) {
        return res.status(409).json({ error: "Mock subscription IDs are only valid in non-production with ALLOW_MOCK_PAYMENTS=true." });
      }

      let stripe;
      try {
        stripe = getStripe();
      } catch (e) {
        if (!isExplicitMockSubscription) {
          return res.status(503).json({ error: "Stripe is unavailable; reactivation was not changed." });
        }
        await db.collection("users").doc(authUid).update(fieldUpdates);
        return res.json({
          success: true,
          mock: true,
          cancelAtPeriodEnd: false,
          message: "Subscription successfully reactivated and will auto-renew normally."
        });
      }

      if (!isExplicitMockSubscription) {
        const liveSub = await stripe.subscriptions.retrieve(subId);
        const liveCustomer = typeof liveSub.customer === "string" ? liveSub.customer : liveSub.customer?.id;
        if (userData.stripeCustomerId && liveCustomer && liveCustomer !== userData.stripeCustomerId) {
          return res.status(403).json({ error: "Forbidden: Stripe subscription customer does not match the caller account." });
        }
        if (liveSub.status === "canceled") {
          return res.status(409).json({ error: "Subscription has already ended in Stripe and cannot be reactivated." });
        }
        await stripe.subscriptions.update(subId, {
          cancel_at_period_end: false
        });
      }

      await db.collection("users").doc(authUid).update(fieldUpdates);

      res.json({
        success: true,
        cancelAtPeriodEnd: false,
        message: "Subscription successfully reactivated! Auto-renewal is resumed."
      });
    } catch (error: any) {
      console.error("Reactivate Subscription Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Dispute Mediation Stake Stripe PaymentIntent (£25.00); never simulate payment success.
  app.post("/api/disputes/create-stake-intent", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter, async (req, res) => {
    const authUid = (req as any).user.uid;
    const { jobId, disputeReason, technicalFaultReport, isPropertyDamage = false, photos = [] } = req.body || {};
    if (!jobId || typeof jobId !== "string") return res.status(400).json({ error: "jobId is required" });
    if (!db) return res.status(503).json({ error: "Database service unavailable" });
    try {
      let stripe;
      try { stripe = getStripe(); }
      catch (stripeError: any) {
        console.error("Stripe unavailable for mediation stake:", stripeError?.message || stripeError);
        return res.status(503).json({ error: "Payment service temporarily unavailable. Please try again shortly." });
      }
      let stakeAmountPence = 2500;
      try {
        const globalCfgSnap = await db.collection("platform_config").doc("global").get();
        const dynamicStake = Number(globalCfgSnap.exists ? globalCfgSnap.data()?.paidAddons?.milestoneEscrow?.homeownerMediationStake : NaN);
        if (Number.isFinite(dynamicStake) && dynamicStake > 0) {
          stakeAmountPence = Math.round(dynamicStake * 100);
        }
      } catch { /* fallback to canonical £25.00 */ }
      const result = await createMediationStakePaymentIntent(db, stripe, {
        jobId, userId: authUid, candidateAttemptId: db.collection("payment_attempts").doc().id,
        disputeReason, technicalFaultReport, isPropertyDamage, photos,
        stakeAmountPence,
        serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp()
      });
      return res.json({
        success: true,
        clientSecret: result.paymentIntent.client_secret,
        paymentIntentId: result.paymentIntent.id,
        amount: Math.round(result.stakeAmountPence) / 100,
      });
    } catch (error: any) {
      console.error("Create Dispute Stake Intent Error:", error);
      const status = Number(error?.httpStatus) || 500;
      return res.status(status).json({ error: status === 500 ? "Failed to initiate mediation stake" : error.message });
    }
  });

  // =========================================================================
  // ADVERTISEMENTS SERVER-AUTHORITATIVE MANAGEMENT (H2 + Batch 7 Remediated)
  // =========================================================================

  // Server-Authoritative Toggle Active (Pause / Resume)
  app.post("/api/ads/:id/toggle-active", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const authUid = (req as any).user.uid;
      const isAdminUser = await checkIsAdmin((req as any).user);
      const result = await toggleAdActiveCommand({
        db,
        authUid,
        isAdminUser,
        adId: id,
      });
      return res.json(result);
    } catch (err: any) {
      console.error("Toggle ad active status error:", err);
      return sendHttpError(res, err, req);
    }
  });

  // Server-Authoritative Ad Top-Up from User Ad Wallet (preserves paused state unless resumeAfterTopup=true)
  app.post("/api/ads/:id/topup", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter, async (req, res) => {
    try {
      const { id } = req.params;
      const authUid = (req as any).user.uid;
      const { amount, resumeAfterTopup } = req.body || {};
      const result = await topUpAdCampaignCommand({
        db,
        authUid,
        adId: id,
        amount,
        resumeAfterTopup: resumeAfterTopup === true,
      });
      return res.json(result);
    } catch (err: any) {
      console.error("Ad topup error:", err);
      return sendHttpError(res, err, req);
    }
  });

  // Server-Authoritative Banner Campaign Creation (£2.00/day canonical + pending_review moderation)
  app.post("/api/ads/create-banner", requireAuth, async (req, res) => {
    try {
      const authUid = (req as any).user.uid;
      const { headline, durationDays, targetCategories } = req.body || {};
      const result = await createBannerAdCommand({
        db,
        authUid,
        headline,
        durationDays,
        targetCategories,
      });
      return res.json(result);
    } catch (err: any) {
      console.error("Create banner campaign error:", err);
      return sendHttpError(res, err, req);
    }
  });

  // Server-Authoritative CPC Campaign Creation (AT-ADS-05, AT-ADS-13)
  app.post("/api/ads/create-cpc", requireAuth, async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const authUid = (req as any).user.uid;
      const result = await createCpcCampaignCommand({
        db,
        authUid,
        ...(req.body || {}),
      });
      return res.status(201).json(result);
    } catch (err: any) {
      console.error("Create CPC campaign error:", err);
      return sendHttpError(res, err, req);
    }
  });

  // Server-Authoritative Smart Auto Top-Up Settings (AT-ADS-05)
  app.post("/api/ads/:id/auto-topup-settings", requireAuth, async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const { id } = req.params;
      const authUid = (req as any).user.uid;
      const { autoTopUpEnabled, autoTopUpThreshold, autoTopUpAmount, autoTopUpMaxMonthlyCapGbp, lowBalanceAlertsEnabled } = req.body || {};
      const result = await updateAdAutoTopUpSettingsCommand({
        db,
        authUid,
        adId: id,
        autoTopUpEnabled: Boolean(autoTopUpEnabled),
        autoTopUpThreshold,
        autoTopUpAmount,
        autoTopUpMaxMonthlyCapGbp,
        lowBalanceAlertsEnabled,
      });
      return res.json(result);
    } catch (err: any) {
      console.error("Update ad auto top-up settings error:", err);
      return sendHttpError(res, err, req);
    }
  });

  // Server-Authoritative Scheduled / On-Demand Smart Auto Top-Up Execution (AT-ADS-05)
  app.post("/api/ads/:id/process-auto-topup", requireAuth, paymentLimiter, async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const { id } = req.params;
      const authUid = (req as any).user.uid;
      const isAdminUser = await checkIsAdmin((req as any).user);
      const adSnap = await db.collection("advertisements").doc(id).get();
      if (!adSnap.exists) throw new NotFoundError("Advertisement not found");
      const adData = adSnap.data() || {};
      if (!isAdminUser && adData.advertiserUid !== authUid && adData.advertiserId !== authUid) {
        throw new ForbiddenError("Unauthorized to process auto top-up for this advertisement");
      }
      let stripeClient: any = null;
      try {
        stripeClient = getStripe();
      } catch {
        stripeClient = null;
      }
      const result = await processAdAutoTopUpCommand({ db, adId: id, stripeClient });
      return res.json(result);
    } catch (err: any) {
      console.error("Process ad auto top-up error:", err);
      return sendHttpError(res, err, req);
    }
  });

  // Server-Authoritative Creative Edit (resets approvalStatus to pending_review & retracts public_ads)
  app.post("/api/ads/:id/edit", requireAuth, async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const { id } = req.params;
      const authUid = (req as any).user.uid;
      const { description, title } = req.body || {};
      const result = await editAdCreativeCommand({
        db,
        authUid,
        adId: id,
        description,
        title,
      });
      return res.json(result);
    } catch (err: any) {
      console.error("Edit ad creative error:", err);
      return sendHttpError(res, err, req);
    }
  });

  // Admin Moderation Endpoint for Advertisements (Approve / Reject)
  app.post("/api/ads/:id/moderate", requireAdmin, requireAdminTier("financial_operator", "moderating advertisements"), async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const { id } = req.params;
      const adminUid = (req as any).user.uid;
      const { decision, reason } = req.body || {};
      const result = await moderateAdCommand({
        db,
        adminUid,
        adId: id,
        decision,
        reason,
      });
      return res.json(result);
    } catch (err: any) {
      console.error("Moderate ad error:", err);
      return sendHttpError(res, err, req);
    }
  });

  // Server-Authoritative Sponsored CPC Click & Impression Tracker (AT-ADS-11)
  app.post("/api/ads/:id/track", generalLimiter, async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const { id } = req.params;
      const { eventType = "click", placement = "banner_ad" } = req.body || {};
      let viewerUid: string | null = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        try {
          const decoded = await verifyTokenSafely(authHeader.split("Bearer ")[1]);
          viewerUid = decoded?.uid || null;
        } catch {
          viewerUid = null;
        }
      }
      const rawIp = String(req.headers["x-forwarded-for"] || req.ip || "unknown").split(",")[0].trim();
      const rawUa = String(req.headers["user-agent"] || "unknown").slice(0, 120);
      const viewerFingerprint = crypto.createHash("sha256").update(`${rawIp}|${rawUa}`).digest("hex").slice(0, 24);
      const result = await trackSponsoredAdEventCommand({
        db,
        adId: id,
        eventType: eventType === "impression" ? "impression" : "click",
        placement: placement === "search_feed" ? "search_feed" : "banner_ad",
        viewerUid,
        viewerFingerprint,
      });
      return res.json(result);
    } catch (err: any) {
      console.error("Track ad event error:", err);
      return sendHttpError(res, err, req);
    }
  });

  // Admin Public Ads Backfill Sync (AT-ADS-13, AT-PROJ-03)
  app.post("/api/admin/sync-public-ads", requireAdmin, requireAdminTier("financial_operator", "syncing public ads projection"), async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable" });
      }
      const result = await backfillPublicAds(db);
      return res.json({ success: true, ...result });
    } catch (err: any) {
      console.error("Sync Public Ads Error:", err);
      return sendHttpError(res, err, req);
    }
  });

  // In-memory cache for live demand zones (15s TTL) to prevent excessive database read spikes
  let demandZonesCache: { timestamp: number; zones: any[] } | null = null;

  app.get("/api/rides/demand-zones", generalLimiter, async (req, res) => {
    try {
      if (!db) {
        return res.json({ success: true, zones: [] });
      }

      const now = Date.now();
      if (demandZonesCache && (now - demandZonesCache.timestamp) < 15000) {
        return res.json({ success: true, zones: demandZonesCache.zones });
      }

      let rules: any = {
        lowWaitMins: 5, mediumWaitMins: 10, highWaitMins: 20,
        lowFee: 1.0, mediumFee: 2.0, highFee: 3.5,
        lowMultiplier: 1.1, mediumMultiplier: 1.3, highMultiplier: 1.6,
        lowColor: "green", mediumColor: "amber", highColor: "red",
        surgeOpacity: 40
      };
      let isFixedModel = true;
      let autoSurgeEnabled = true;

      try {
        const configSnap = await db.collection("platform_config").doc("rides").get();
        if (configSnap.exists) {
          const cd = configSnap.data() || {};
          if (cd.surgeRules) rules = { ...rules, ...cd.surgeRules };
          if (cd.surgeModel !== undefined) isFixedModel = cd.surgeModel === "fixed";
          if (cd.surgeEnabled !== undefined) autoSurgeEnabled = cd.surgeEnabled;
        }
      } catch (err: any) {
        if (err?.code === 7 || err?.message?.includes("PERMISSION_DENIED")) {
          // Cross-project container environment: server Firestore credentials restricted
        } else {
          console.warn("Could not read platform_config/rides:", err);
        }
      }

      if (!autoSurgeEnabled) {
        demandZonesCache = { timestamp: now, zones: [] };
        return res.json({ success: true, zones: [] });
      }

      let ridesSnap: any;
      let driversSnap: any;
      try {
        ridesSnap = await db.collection("ride_requests")
          .where("status", "in", ["pending", "searching", "offered"])
          .limit(200)
          .get();
        driversSnap = await db.collection("live_tracking")
          .where("isOnline", "==", true)
          .limit(200)
          .get();
      } catch (queryErr: any) {
        if (queryErr?.code === 7 || queryErr?.message?.includes("PERMISSION_DENIED")) {
          demandZonesCache = { timestamp: now, zones: [] };
          return res.json({ success: true, zones: [] });
        }
        throw queryErr;
      }
      const pendingRides = ridesSnap.docs.map((d: any) => d.data());
      const onlineDrivers = driversSnap.docs.map((d: any) => d.data());

      const hotSpots = new Map<string, { rideCount: number; lat: number; lng: number; rides: any[] }>();
      pendingRides.forEach(ride => {
        const lat = ride.pickupLat;
        const lng = ride.pickupLng;
        if (lat && lng && typeof lat === "number" && typeof lng === "number") {
          const gridLat = Math.round(lat * 50) / 50;
          const gridLng = Math.round(lng * 50) / 50;
          const key = `${gridLat},${gridLng}`;
          if (!hotSpots.has(key)) {
            hotSpots.set(key, { rideCount: 0, lat, lng, rides: [] });
          }
          const spot = hotSpots.get(key)!;
          spot.rideCount += 1;
          spot.rides.push(ride);
        }
      });

      const getDistanceMiles = (lat1: number, lon1: number, lat2: number, lon2: number) => {
        const R = 3958.8;
        const dLat = (lat2 - lat1) * (Math.PI / 180);
        const dLon = (lon2 - lon1) * (Math.PI / 180);
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
      };

      const zones: any[] = [];
      hotSpots.forEach(spot => {
        let nearbyDrivers = 0;
        onlineDrivers.forEach(driver => {
          if (driver.lat && driver.lng && typeof driver.lat === "number" && typeof driver.lng === "number") {
            const dist = getDistanceMiles(spot.lat, spot.lng, driver.lat, driver.lng);
            if (dist <= 3) nearbyDrivers++;
          }
        });

        let maxWaitTimeMins = 0;
        spot.rides.forEach(r => {
          let createdAtMs = 0;
          if (r.createdAt?.toMillis) {
            createdAtMs = r.createdAt.toMillis();
          } else if (r.createdAt instanceof Date) {
            createdAtMs = r.createdAt.getTime();
          } else if (typeof r.createdAt === "string") {
            createdAtMs = new Date(r.createdAt).getTime();
          } else if (typeof r.createdAt === "number") {
            createdAtMs = r.createdAt;
          }
          if (createdAtMs > 0) {
            const waitMins = (now - createdAtMs) / 60000;
            if (waitMins > maxWaitTimeMins) maxWaitTimeMins = waitMins;
          }
        });

        const ratio = nearbyDrivers > 0 ? (spot.rideCount / nearbyDrivers) : spot.rideCount;

        let intensity: "high" | "medium" | "low" | null = null;
        let multiplier = 1.0;
        let extraFee = 0.0;

        if (spot.rideCount > 1 || maxWaitTimeMins >= rules.lowWaitMins) {
          if (maxWaitTimeMins >= rules.highWaitMins || ratio > 3) {
            intensity = "high";
            multiplier = rules.highMultiplier;
            extraFee = rules.highFee;
          } else if (maxWaitTimeMins >= rules.mediumWaitMins || ratio > 2) {
            intensity = "medium";
            multiplier = rules.mediumMultiplier;
            extraFee = rules.mediumFee;
          } else if (maxWaitTimeMins >= rules.lowWaitMins || ratio >= 1) {
            intensity = "low";
            multiplier = rules.lowMultiplier;
            extraFee = rules.lowFee;
          }
        }

        if (intensity) {
          zones.push({
            lat: spot.lat,
            lng: spot.lng,
            radius: intensity === "high" ? 800 : intensity === "medium" ? 600 : 400,
            intensity,
            label: isFixedModel ? `£${Number(extraFee).toFixed(2)} Surge` : `${multiplier}x Surge`,
            surgeMultiplier: multiplier,
            maxWaitTimeMins,
            waitWarning: maxWaitTimeMins >= rules.highWaitMins,
            extraFee,
            isFixedModel,
            uiColor: intensity === "high" ? (rules.highColor || "red") : intensity === "medium" ? (rules.mediumColor || "amber") : (rules.lowColor || "green"),
            uiOpacity: rules.surgeOpacity
          });
        }
      });

      zones.sort((a, b) => b.surgeMultiplier - a.surgeMultiplier);
      demandZonesCache = { timestamp: now, zones };
      res.json({ success: true, zones });
    } catch (error: any) {
      if (error?.code === 7 || error?.message?.includes("PERMISSION_DENIED")) {
        demandZonesCache = { timestamp: Date.now(), zones: [] };
      } else {
        console.error("Error computing demand zones on server:", error);
      }
      res.json({ success: true, zones: [] });
    }
  });

  // Privacy-safe nearby online drivers for passenger map (no driver UIDs, names, or PII)
  app.get("/api/rides/nearby-drivers", requireAuth, generalLimiter, async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database backend unavailable" });
      const caller = (req as any).user;
      const lat = Number(req.query.lat);
      const lng = Number(req.query.lng);
      const radiusMiles = req.query.radiusMiles !== undefined ? Number(req.query.radiusMiles) : undefined;
      const vehicleCategory =
        typeof req.query.vehicleCategory === "string" ? req.query.vehicleCategory : undefined;

      const result = await getSanitizedNearbyDrivers({
        db,
        lat,
        lng,
        radiusMiles,
        vehicleCategory,
        excludeUid: caller?.uid,
      });
      res.json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Ride Offer FCM Push Dispatch (wakes backgrounded native Android AnyRoller Drivers)
  app.post(
    "/api/rides/:rideId/dispatch-offers",
    requireAuth,
    AbuseDefenseEngine.createMiddleware("NOTIFICATION_SEND"),
    async (req, res) => {
      try {
        if (!db) return res.status(503).json({ error: "Database backend unavailable" });
        const caller = (req as any).user;
        const result = await dispatchRideOffersCommand({
          db,
          caller,
          rideId: req.params.rideId,
          messagingClient: getFirebaseMessagingClient(),
          radiusMiles: req.body?.radiusMiles,
          maxDrivers: req.body?.maxDrivers,
          force: req.body?.force === true,
        });
        res.json(result);
      } catch (error: any) {
        console.error("Dispatch Ride Offers Error:", error);
        sendHttpError(res, error, req);
      }
    }
  );

  // Server-Authoritative Ride Acceptance (V8.3 Task 35-B Hardened against Driver Privilege Escalation & Impersonation)
  app.post("/api/rides/accept", requireAuth, async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database not initialized");
      const caller = (req as any).user;

      const result = await executeAcceptRideCommand({
        db,
        caller,
        body: req.body || {},
      });

      if (result.passengerId) {
        void notifyRideCounterpartyPush({
          db,
          messagingClient: getFirebaseMessagingClient(),
          rideId: result.rideId,
          recipientId: result.passengerId,
          title: "Driver On The Way",
          body: "A driver has accepted your ride request and is heading to your pickup.",
          eventType: "ride_accepted",
          channelId: RIDE_UPDATES_CHANNEL_ID,
          extraData: { driverId: result.driverId },
        });
      }

      res.json(result);
    } catch (error: any) {
      console.error("Accept Ride Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Direct-to-Driver Taxi Payment (V8.3 Task 35-C Recipient Integrity)
  app.post("/api/rides/create-trip-payment", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter, async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({ error: "Database backend unavailable" });
      }

      const caller = (req as any).user;
      let stripe: Stripe | null = null;
      try {
        stripe = getStripe();
      } catch (e) {
        if (process.env.NODE_ENV === "production" || process.env.ALLOW_MOCK_PAYMENTS !== "true") {
          console.error("Stripe is not configured in production. Refusing mock trip payment bypass.");
          return res.status(503).json({ error: "Trip payment processing is currently unavailable: Stripe gateway is unconfigured." });
        }
        console.warn("Stripe missing. Mocking Trip QR link for development testing.");
      }

      const appUrl = getAuthoritativeAppUrl();

      const result = await executeCreateTripPaymentCommand({
        db,
        caller,
        body: req.body || {},
        stripeClient: stripe,
        appUrl,
      });

      res.json({
        success: true,
        url: result.url,
        intentId: result.intentId,
        reused: result.reused === true,
        effectiveBaseFare: result.effectiveBaseFare,
        sanitizedTip: result.sanitizedTip,
        totalAmount: result.totalAmount,
      });
    } catch (error: any) {
      console.error("Trip Payment Creation Error:", error);
      sendHttpError(res, error, req);
    }
  });

  app.post("/api/rides/transition", requireAuth, generalLimiter, async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database backend unavailable" });
      const caller = (req as any).user;
      const result: any = await executeTransitionRideCommand({
        db,
        caller,
        rideId: req.body?.rideId,
        action: req.body?.action,
        paidWaitSeconds: req.body?.paidWaitSeconds,
        currentStopIndex: req.body?.currentStopIndex,
        earlyCompletionReason: req.body?.earlyCompletionReason,
        liveEtaSeconds: req.body?.liveEtaSeconds,
        stackedDriverDelay: req.body?.stackedDriverDelay,
      });

      if (result?.success && result.passengerId) {
        const action = req.body?.action;
        const messaging = getFirebaseMessagingClient();
        if (action === "arrived") {
          void notifyRideCounterpartyPush({
            db,
            messagingClient: messaging,
            rideId: result.rideId,
            recipientId: result.passengerId,
            title: "Your Driver Has Arrived",
            body: "Your AnyRoller driver is waiting at the pickup point.",
            eventType: "ride_arrived",
            channelId: RIDE_UPDATES_CHANNEL_ID,
          });
        } else if (action === "in_progress") {
          void notifyRideCounterpartyPush({
            db,
            messagingClient: messaging,
            rideId: result.rideId,
            recipientId: result.passengerId,
            title: "Trip Started",
            body: "You are on your way. Have a safe journey!",
            eventType: "ride_started",
            channelId: RIDE_UPDATES_CHANNEL_ID,
          });
        } else if (action === "stop_progress") {
          void notifyRideCounterpartyPush({
            db,
            messagingClient: messaging,
            rideId: result.rideId,
            recipientId: result.passengerId,
            title: "Stop Completed",
            body: "Continuing onward to your next destination.",
            eventType: "ride_stop_progress",
            channelId: RIDE_UPDATES_CHANNEL_ID,
          });
        }
      }

      res.json(result);
    } catch (error: any) {
      console.error("Ride Transition Error:", error);
      sendHttpError(res, error, req);
    }
  });

  app.post("/api/rides/complete", requireAuth, paymentLimiter, async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database backend unavailable" });
      const caller = (req as any).user;
      const result: any = await executeCompleteRideCommand({
        db,
        caller,
        rideId: req.body?.rideId,
        action: req.body?.action,
        paidWaitSeconds: req.body?.paidWaitSeconds,
        cashCollected: req.body?.cashCollected,
        forceComplete: req.body?.forceComplete === true,
        forceCompleteReason: req.body?.forceCompleteReason,
        earlyCompletionReason: req.body?.earlyCompletionReason,
        paymentUrl: req.body?.paymentUrl,
        abandonmentFee: req.body?.abandonmentFee,
      });

      if (result?.success && !result.idempotent) {
        const messaging = getFirebaseMessagingClient();
        const action = req.body?.action;
        const fareLabel = typeof result.totalFarePaid === "number" ? `£${result.totalFarePaid.toFixed(2)}` : "";
        if (result.status === "awaiting_payment" && result.passengerId) {
          void notifyRideCounterpartyPush({
            db,
            messagingClient: messaging,
            rideId: result.rideId,
            recipientId: result.passengerId,
            title: "Trip Finished — Payment Due",
            body: fareLabel
              ? `Your total fare is ${fareLabel}. Please complete payment.`
              : "Your trip is finished. Please complete payment.",
            eventType: "ride_payment_required",
            channelId: RIDE_UPDATES_CHANNEL_ID,
          });
        } else if (result.status === "awaiting_cash_confirm" && result.passengerId) {
          void notifyRideCounterpartyPush({
            db,
            messagingClient: messaging,
            rideId: result.rideId,
            recipientId: result.passengerId,
            title: "Confirm Cash Payment",
            body: "Your driver reported a cash balance difference. Please confirm in the app.",
            eventType: "ride_cash_confirm",
            channelId: RIDE_UPDATES_CHANNEL_ID,
          });
        } else if (result.status === "rider_abandoned" && result.passengerId) {
          void notifyRideCounterpartyPush({
            db,
            messagingClient: messaging,
            rideId: result.rideId,
            recipientId: result.passengerId,
            title: "Ride Marked Abandoned",
            body: "Your driver ended the ride as abandoned. View your receipt in AnyRoller.",
            eventType: "ride_abandoned",
            channelId: RIDE_UPDATES_CHANNEL_ID,
          });
        } else if (result.status === "completed") {
          const isPassengerTriggered =
            action === "cash_confirm_passenger" || action === "force_complete_passenger";
          if (isPassengerTriggered && result.assignedDriverId) {
            void notifyRideCounterpartyPush({
              db,
              messagingClient: messaging,
              rideId: result.rideId,
              recipientId: result.assignedDriverId,
              title: "Cash Balance Confirmed",
              body: "The passenger confirmed the cash payment. Your trip is now closed.",
              eventType: "ride_completed",
              channelId: RIDE_UPDATES_CHANNEL_ID,
            });
          } else if (!isPassengerTriggered && result.passengerId) {
            void notifyRideCounterpartyPush({
              db,
              messagingClient: messaging,
              rideId: result.rideId,
              recipientId: result.passengerId,
              title: "Trip Completed",
              body: fareLabel
                ? `Thanks for riding with AnyRoller! Final fare: ${fareLabel}.`
                : "Thanks for riding with AnyRoller!",
              eventType: "ride_completed",
              channelId: RIDE_UPDATES_CHANNEL_ID,
            });
          }
        }
      }

      res.json(result);
    } catch (error: any) {
      console.error("Ride Completion Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // P1-2: Explicit server-authoritative ride offer decline (instant re-dispatch)
  app.post("/api/rides/decline", requireAuth, generalLimiter, async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database backend unavailable" });
      const caller = (req as any).user;
      const result = await executeDeclineRideOfferCommand({
        db,
        caller,
        rideId: req.body?.rideId,
      });
      res.json(result);
    } catch (error: any) {
      console.error("Ride Decline Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // P1-4: Server-authoritative driver-to-passenger rating after ride completion
  app.post("/api/rides/rate-passenger", requireAuth, generalLimiter, async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database backend unavailable" });
      const caller = (req as any).user;
      const result = await executeRatePassengerCommand({
        db,
        caller,
        rideId: req.body?.rideId,
        rating: req.body?.rating,
        tags: req.body?.tags,
        comment: req.body?.comment,
      });
      res.json(result);
    } catch (error: any) {
      console.error("Rate Passenger Error:", error);
      sendHttpError(res, error, req);
    }
  });

  app.post("/api/rides/cancel", requireAuth, generalLimiter, async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database backend unavailable" });
      const caller = (req as any).user;
      const result: any = await executeCancelRideCommand({
        db,
        caller,
        rideId: req.body?.rideId,
        cancelledBy: req.body?.cancelledBy,
      });

      if (result?.success && !result.alreadyCancelled) {
        const messaging = getFirebaseMessagingClient();
        if (result.cancelledBy === "passenger" && result.assignedDriverId) {
          void notifyRideCounterpartyPush({
            db,
            messagingClient: messaging,
            rideId: result.rideId,
            recipientId: result.assignedDriverId,
            title: "Ride Cancelled by Passenger",
            body: "The passenger cancelled your assigned ride.",
            eventType: "ride_cancelled",
            channelId: RIDE_UPDATES_CHANNEL_ID,
            extraData: { cancelledBy: "passenger" },
          });
        } else if (result.cancelledBy === "driver" && result.passengerId) {
          void notifyRideCounterpartyPush({
            db,
            messagingClient: messaging,
            rideId: result.rideId,
            recipientId: result.passengerId,
            title: "Ride Cancelled by Driver",
            body: "Your assigned driver cancelled the ride. Please request another driver.",
            eventType: "ride_cancelled",
            channelId: RIDE_UPDATES_CHANNEL_ID,
            extraData: { cancelledBy: "driver" },
          });
        } else if (result.cancelledBy === "admin") {
          if (result.assignedDriverId) {
            void notifyRideCounterpartyPush({
              db,
              messagingClient: messaging,
              rideId: result.rideId,
              recipientId: result.assignedDriverId,
              title: "Ride Cancelled",
              body: "This ride was cancelled by support.",
              eventType: "ride_cancelled",
              channelId: RIDE_UPDATES_CHANNEL_ID,
              extraData: { cancelledBy: "admin" },
            });
          }
          if (result.passengerId) {
            void notifyRideCounterpartyPush({
              db,
              messagingClient: messaging,
              rideId: result.rideId,
              recipientId: result.passengerId,
              title: "Ride Cancelled",
              body: "This ride was cancelled by support.",
              eventType: "ride_cancelled",
              channelId: RIDE_UPDATES_CHANNEL_ID,
              extraData: { cancelledBy: "admin" },
            });
          }
        }
      }

      res.json(result);
    } catch (error: any) {
      console.error("Ride Cancel Error:", error);
      sendHttpError(res, error, req);
    }
  });

  app.post("/api/driver/metrics/heartbeat", requireAuth, generalLimiter, async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database backend unavailable" });
      const caller = (req as any).user;
      const result = await recordDriverOnlineHeartbeat({ db, caller });
      res.json(result);
    } catch (error: any) {
      console.error("Driver Metrics Heartbeat Error:", error);
      sendHttpError(res, error, req);
    }
  });
  
  app.post("/api/driver/stripe-payout/:driverId", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter, async (req, res) => {
    try {
      const { driverId } = req.params;
      const { amount } = req.body; // Optional amount
      const user = (req as any).user;

      // Enforce authorization with admin bypass
      assertResourceOwner(user, driverId);

      if (!db) throw new BadRequestError("Database not connected");

      const idempotencyKey = (req.headers["x-idempotency-key"] as string) || 
        (req.headers["idempotency-key"] as string) || 
        req.body.idempotencyKey;

      if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
        throw new BadRequestError("Idempotency-Key header is required for payout operations.");
      }

      // Resolve the payout destination before checking/replaying the idempotency key.
      // A driver reconnecting Stripe must not replay a payout bound to the previous account.
      const driverDoc = await db.collection("users").doc(driverId).get();
      if (!driverDoc.exists) throw new BadRequestError("Driver not found");

      const stripeAccountId = driverDoc.data()?.stripeAccountId;
      if (typeof stripeAccountId !== "string" || stripeAccountId.trim() === "") {
        throw new BadRequestError("No Stripe account connected");
      }

      const hasFixedAmount = amount !== undefined && amount !== null && amount !== "";
      const requestedAmountPence = hasFixedAmount ? Math.round(Number(amount) * 100) : null;
      if (hasFixedAmount && (!Number.isSafeInteger(requestedAmountPence) || requestedAmountPence! <= 0)) {
        throw new BadRequestError("Invalid payout amount. Must be a positive amount in pounds.");
      }

      const { result, wasReplayed } = await PaymentLedgerEngine.executeIdempotentOperation(
        db,
        idempotencyKey,
        "DRIVER_STRIPE_PAYOUT",
        {
          version: 1,
          driverId,
          stripeAccountId,
          currency: "gbp",
          amountMode: hasFixedAmount ? "fixed" : "full_available_balance",
          amountPence: requestedAmountPence,
        },
        async () => {
          const stripe = getStripe();

          // Get available balance first
          const balance = await stripe.balance.retrieve({
            stripeAccount: stripeAccountId,
          });

          const available = balance.available.find(b => b.currency === 'gbp')?.amount || 0;

          if (available <= 0) {
            throw new BadRequestError("No available balance for payout");
          }

          // Create a payout
          const payoutAmount = hasFixedAmount
            ? requestedAmountPence!
            : available; // Default to full available balance

          if (!Number.isSafeInteger(payoutAmount) || payoutAmount <= 0) {
            throw new BadRequestError("Invalid payout amount. Must be a positive number.");
          }

          if (payoutAmount > available) {
            throw new BadRequestError(`Requested payout (£${(payoutAmount / 100).toFixed(2)}) exceeds available balance (£${(available / 100).toFixed(2)})`);
          }
          
          const payout = await stripe.payouts.create({
            amount: payoutAmount,
            currency: 'gbp',
          }, {
            stripeAccount: stripeAccountId,
            idempotencyKey: `stripe_payout_${idempotencyKey}`
          });

          await domainEvents.dispatch("DRIVER_PAYOUT_INITIATED", payout.id, driverId, {
            amount: payoutAmount,
            currency: 'gbp',
            initiatedByUid: user.uid,
            initiatedByEmail: user.email || "",
            isAdminOverride: user.uid !== driverId,
          }, idempotencyKey, db);

          // AT-ADMIN-AUDIT-02: Persist initiating admin context for manual admin-triggered payouts
          if (user.uid !== driverId) {
            const nowIso = new Date().toISOString();
            const auditReason = typeof req.body?.reason === "string" && req.body.reason.trim()
              ? req.body.reason.trim()
              : "Admin manual driver Stripe payout";
            await db.collection("driver_payout_batches").doc(`manual_${payout.id}`).set({
              batchId: `manual_${payout.id}`,
              payoutId: payout.id,
              driverId,
              stripeAccountId,
              amountPence: payoutAmount,
              currency: "gbp",
              initiatedByUid: user.uid,
              initiatedByEmail: user.email || "",
              triggerSource: "manual_admin",
              reason: auditReason,
              initiatedAt: nowIso,
              status: "completed",
            });
            await db.collection("admin_audit_logs").add({
              action: "MANUAL_DRIVER_STRIPE_PAYOUT",
              adminUid: user.uid,
              adminEmail: user.email || "",
              targetDriverId: driverId,
              payoutId: payout.id,
              amountPence: payoutAmount,
              reason: auditReason,
              timestamp: nowIso,
            });
          }

          return { success: true, payout };
        }
      );

      res.json({ ...result, replayed: wasReplayed });
    } catch (error: any) {
      console.error("Stripe Payout Error:", error);
      sendHttpError(res, error, req);
    }
  });

  app.get("/api/driver/stripe-balance/:driverId", requireAuth, async (req, res) => {
    try {
      const { driverId } = req.params;
      const user = (req as any).user;

      assertResourceOwner(user, driverId);

      if (!db) return res.json({ available: 0, pending: 0, currency: 'gbp', mock: true });

      let driverDoc;
      try {
        driverDoc = await db.collection("users").doc(driverId).get();
      } catch (dbErr) {
         return res.json({ available: 0, pending: 0, currency: 'gbp', mock: true });
      }
      
      if (!driverDoc.exists) return res.status(404).json({ error: "Driver not found" });

      const stripeAccountId = driverDoc.data()?.stripeAccountId;
      if (!stripeAccountId) return res.status(400).json({ error: "No Stripe account connected" });

      let stripe;
      try {
        stripe = getStripe();
      } catch (e) {
        return res.json({ available: 0, pending: 0, currency: 'gbp', mock: true });
      }

      const balance = await stripe.balance.retrieve({
        stripeAccount: stripeAccountId,
      });

      const available = balance.available.find(b => b.currency === 'gbp')?.amount || 0;
      const pending = balance.pending.find(b => b.currency === 'gbp')?.amount || 0;

      res.json({
        available: available / 100,
        pending: pending / 100,
        currency: 'gbp'
      });
    } catch (error: any) {
      console.error("Stripe Balance Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // =========================================================================
  // PUBLIC JOB CARD PROJECTION SYNCHRONIZATION
  // =========================================================================
  app.post("/api/admin/sync-public-job-cards", requireAdmin, requireAdminTier("financial_operator", "syncing public job cards projection"), async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable" });
      }

      const result = await backfillPublicJobCards(db);
      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error("Sync Public Job Cards Error:", error);
      sendHttpError(res, error, req);
    }
  });

  app.post("/api/jobs/:id/sync-public-card", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const user = (req as any).user;

      if (!db) {
        return res.status(503).json({ error: "Database service unavailable" });
      }

      const jobDoc = await db.collection("jobs").doc(id).get();
      if (!jobDoc.exists) {
        throw new NotFoundError("Job not found");
      }

      const data = jobDoc.data()!;
      const isOwner = data.homeownerId === user.uid || data.userId === user.uid;
      const isAdmin = await checkIsAdmin(user);
      if (!isOwner && !isAdmin) {
        throw new ForbiddenError("Unauthorized to sync this job projection.");
      }

      const isActive =
        ["posted", "quoting", "in_bidding", "open"].includes(String(data.status || "").toLowerCase()) &&
        !data.clientDeleted &&
        !isDirectJob(data);
      if (isActive) {
        const publicCard = sanitizeJobToPublicCard(id, data);
        await db.collection("public_job_cards").doc(id).set(publicCard, { merge: true });
      } else {
        await db.collection("public_job_cards").doc(id).delete();
      }

      res.json({ success: true, id, status: data.status });
    } catch (error: any) {
      console.error("Sync Single Public Job Card Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // =========================================================================
  // PUBLIC PROPERTY PROJECTION SYNCHRONIZATION
  // =========================================================================
  app.post("/api/admin/sync-public-properties", requireAdmin, requireAdminTier("financial_operator", "syncing public properties projection"), async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable" });
      }

      const result = await backfillPublicProperties(db);
      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error("Sync Public Properties Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // All property creation is server-authoritative so Gotham door entitlements
  // cannot be bypassed by writing directly to Firestore from a client.
  app.post("/api/properties", requireAuth, async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const userId = String((req as any).user?.uid || "");
      if (!userId) throw new ForbiddenError("Authenticated user is required.");

      const body = req.body || {};
      const allowedFields = [
        "name", "address", "postcode", "city", "propertyType", "status", "association",
        "contactName", "contactPhone", "accessInstructions", "era", "heatingType",
        "boilerInfo", "roofCondition", "epcRating", "gasSafetyExpiry", "eicrExpiry",
        "totalAreaSqFt", "unitCount", "photos"
      ];
      const protectedFields = [
        "id", "ownerId", "userId", "homeownerId", "landlordId", "tenantId",
        "gothamDoorsCount", "gothamSubscriptionStatus", "subscriptionStatus",
        "usage", "propertyCount", "createdAt", "transferClaimedByUid", "verifiedByAdmin"
      ];
      if (Object.keys(body).some((key) => protectedFields.includes(key))) {
        throw new BadRequestError("Property payload contains server-managed fields.");
      }
      if (Object.keys(body).some((key) => !allowedFields.includes(key))) {
        throw new BadRequestError("Property payload contains unsupported fields.");
      }
      if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 160) {
        throw new BadRequestError("A property name of 1–160 characters is required.");
      }
      if (typeof body.propertyType !== "string" || body.propertyType.length > 80) {
        throw new BadRequestError("A valid property type is required.");
      }
      if (!body.address || typeof body.address !== "object" || Array.isArray(body.address)) {
        throw new BadRequestError("A structured property address is required.");
      }
      const address = {
        line1: typeof body.address.line1 === "string" ? body.address.line1.slice(0, 200) : "",
        city: typeof body.address.city === "string" ? body.address.city.slice(0, 100) : "",
        postcode: typeof body.address.postcode === "string" ? body.address.postcode.slice(0, 20).toUpperCase() : "",
        country: typeof body.address.country === "string" ? body.address.country.slice(0, 80) : "UK"
      };
      const propertyData: Record<string, any> = {
        name: body.name.trim(),
        address,
        postcode: typeof body.postcode === "string" ? body.postcode.slice(0, 20).toUpperCase() : address.postcode,
        city: typeof body.city === "string" ? body.city.slice(0, 100) : address.city,
        propertyType: body.propertyType.trim(),
        status: "active",
        isPublicPassport: false,
        publicConsent: false,
        ownerId: userId,
        userId,
        homeownerId: userId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      for (const key of ["association", "contactName", "contactPhone", "accessInstructions", "era", "heatingType", "roofCondition", "epcRating", "gasSafetyExpiry", "eicrExpiry"]) {
        if (typeof body[key] === "string") propertyData[key] = body[key].slice(0, key === "accessInstructions" ? 2000 : 200);
      }
      if (body.totalAreaSqFt !== undefined && body.totalAreaSqFt !== "") {
        const parsedArea = Number(body.totalAreaSqFt);
        if (!Number.isFinite(parsedArea) || parsedArea <= 0 || parsedArea > 1_000_000) {
          throw new BadRequestError("totalAreaSqFt must be a positive number.");
        }
        propertyData.totalAreaSqFt = Math.round(parsedArea);
      }
      if (body.unitCount !== undefined && body.unitCount !== "") {
        const parsedUnits = Number(body.unitCount);
        if (!Number.isInteger(parsedUnits) || parsedUnits < 1 || parsedUnits > 5000) {
          throw new BadRequestError("unitCount must be an integer between 1 and 5000.");
        }
        propertyData.unitCount = parsedUnits;
      }
      if (Array.isArray(body.photos)) {
        const safePhotos = body.photos
          .filter((p: unknown): p is string => typeof p === "string" && (p.startsWith("https://") || p.startsWith("data:image/")) && p.length <= 200_000)
          .slice(0, 8);
        propertyData.photos = safePhotos;
      }
      if (body.boilerInfo && typeof body.boilerInfo === "object" && !Array.isArray(body.boilerInfo)) {
        propertyData.boilerInfo = {
          brand: typeof body.boilerInfo.brand === "string" ? body.boilerInfo.brand.slice(0, 100) : "",
          model: typeof body.boilerInfo.model === "string" ? body.boilerInfo.model.slice(0, 100) : "",
          age: typeof body.boilerInfo.age === "string" ? body.boilerInfo.age.slice(0, 20) : "",
          lastServiced: typeof body.boilerInfo.lastServiced === "string" ? body.boilerInfo.lastServiced.slice(0, 40) : ""
        };
      }

      // AT-PROP-07: Deterministic SHA-256 hash of canonical creation payload bound to Idempotency-Key
      const canonicalForHash = {
        name: propertyData.name,
        address: propertyData.address,
        postcode: propertyData.postcode,
        city: propertyData.city,
        propertyType: propertyData.propertyType,
        totalAreaSqFt: propertyData.totalAreaSqFt ?? null,
        unitCount: propertyData.unitCount ?? null,
        photosCount: Array.isArray(propertyData.photos) ? propertyData.photos.length : 0,
        epcRating: propertyData.epcRating ?? null,
        roofCondition: propertyData.roofCondition ?? null,
      };
      const payloadHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(canonicalForHash))
        .digest("hex");

      const rawKey = String(req.headers["idempotency-key"] || "");
      const idempotencyKey = /^[A-Za-z0-9_-]{12,100}$/.test(rawKey) ? rawKey : "";
      if (rawKey && !idempotencyKey) {
        throw new BadRequestError("Invalid Idempotency-Key header format.");
      }
      const propertyRef = db.collection("properties").doc();
      const userRef = db.collection("users").doc(userId);
      const usageRef = db.collection("gotham_property_usage").doc(userId);
      const requestRef = idempotencyKey
        ? db.collection("property_creation_requests").doc(userId + "_" + idempotencyKey)
        : null;
      if (requestRef) {
        const previousRequest = await requestRef.get();
        if (previousRequest.exists) {
          const previous = previousRequest.data() || {};
          if (previous.payloadHash && previous.payloadHash !== payloadHash) {
            throw new ConflictError("Idempotency-Key was already used with a different property payload.");
          }
          const previousPropertyId = String(previous.propertyId || "");
          if (!previousPropertyId) throw new Error("Property creation idempotency record is invalid.");
          return res.status(200).json({ success: true, id: previousPropertyId, duplicate: true });
        }
      }
      const entitlementSnap = await userRef.get();
      // An authenticated ordinary homeowner may predate profile bootstrap; absence
      // of a server-owned Gotham subscription record means no Gotham quota applies.
      const entitlementProfile = entitlementSnap.exists ? (entitlementSnap.data() || {}) : {};
      const isGothamAccount = entitlementProfile.subscriptionType === "gotham_saas" || entitlementProfile.isGothamSubscriber === true;
      let verifiedGothamSubscriptionId = "";
      let verifiedGothamStatus = "";
      if (isGothamAccount) {
        verifiedGothamSubscriptionId = String(entitlementProfile.gothamSubscriptionId || "");
        if (!verifiedGothamSubscriptionId) {
          throw new ForbiddenError("No verified Gotham subscription is linked to this account.");
        }
        if (verifiedGothamSubscriptionId.startsWith("mock_")) {
          if (process.env.NODE_ENV === "production" || process.env.ALLOW_MOCK_PAYMENTS !== "true") {
            return res.status(503).json({ error: "Gotham subscription verification is unavailable." });
          }
          verifiedGothamStatus = String(entitlementProfile.gothamSubscriptionStatus || "");
        } else {
          let stripeClient;
          try {
            stripeClient = getStripe();
          } catch (_) {
            return res.status(503).json({ error: "Stripe is unavailable; Gotham entitlement could not be verified." });
          }
          let liveSubscription: Stripe.Subscription;
          try {
            liveSubscription = await stripeClient.subscriptions.retrieve(verifiedGothamSubscriptionId);
          } catch (_) {
            return res.status(503).json({ error: "Gotham subscription could not be verified with Stripe." });
          }
          verifiedGothamStatus = String(liveSubscription.status || "");
          const paidThrough = Number((liveSubscription as any).current_period_end || 0);
          const paidPeriodExpired = Boolean((liveSubscription as any).cancel_at_period_end) &&
            (!paidThrough || Date.now() >= paidThrough * 1000);
          if (!["active", "trialing"].includes(verifiedGothamStatus) || paidPeriodExpired) {
            throw new ForbiddenError("Gotham subscription is not currently entitled to add properties.");
          }
        }
        if (!["active", "trialing"].includes(verifiedGothamStatus)) {
          throw new ForbiddenError("Gotham subscription is not currently entitled to add properties.");
        }
      }
      const result = await db.runTransaction(async (tx: any) => {
        const [userSnap, usageSnap, requestSnap] = await Promise.all([
          tx.get(userRef),
          tx.get(usageRef),
          requestRef ? tx.get(requestRef) : Promise.resolve(null)
        ]);
        if (requestSnap?.exists) {
          const prior = requestSnap.data() || {};
          if (prior.payloadHash && prior.payloadHash !== payloadHash) {
            throw new ConflictError("Idempotency-Key was already used with a different property payload.");
          }
          return { id: String(prior.propertyId || ""), duplicate: true };
        }
        const profile = userSnap.exists ? (userSnap.data() || {}) : {};
        const isGothamAccount = profile.subscriptionType === "gotham_saas" || profile.isGothamSubscriber === true;
        const isGothamEntitled = isGothamAccount &&
          Boolean(verifiedGothamSubscriptionId) &&
          profile.gothamSubscriptionId === verifiedGothamSubscriptionId &&
          ["active", "trialing"].includes(verifiedGothamStatus.toLowerCase());
        if (isGothamAccount && !isGothamEntitled) {
          throw new ForbiddenError("Gotham subscription is not active. Property creation is unavailable until billing is restored.");
        }
        const doorsAllowed = isGothamEntitled ? Number(profile.gothamDoorsCount) : 0;
        // Once a Gotham usage document exists, keep it current even while the
        // account is on another plan so a later Gotham renewal starts accurately.
        if (isGothamEntitled || usageSnap.exists) {
          let currentUsage: number;
          if (usageSnap.exists) {
            currentUsage = Number(usageSnap.data()?.propertyCount);
          } else {
            // One-time legacy backfill. The usage document then becomes the
            // serialization point for all later creates and deletes.
            const [ownerQuery, userQuery, landlordQuery] = await Promise.all([
              tx.get(db.collection("properties").where("ownerId", "==", userId)),
              tx.get(db.collection("properties").where("userId", "==", userId)),
              tx.get(db.collection("properties").where("landlordId", "==", userId))
            ]);
            const existingIds = new Set<string>();
            for (const snap of [ownerQuery, userQuery, landlordQuery]) {
              snap.docs.forEach((doc: any) => existingIds.add(doc.id));
            }
            currentUsage = existingIds.size;
          }
          const quotaDecision = evaluateGothamPropertyQuota(currentUsage, doorsAllowed, isGothamEntitled);
          if (!quotaDecision.allowed) {
            if ("reason" in quotaDecision && quotaDecision.reason === "invalid_usage") {
              throw new ForbiddenError("Gotham property usage is invalid. Please contact support.");
            }
            if ("reason" in quotaDecision && quotaDecision.reason === "invalid_allowance") {
              throw new ForbiddenError("Gotham door allowance is invalid. Please contact support.");
            }
            throw new ForbiddenError("Your Gotham subscription has reached its purchased property limit.");
          }
          const usagePatch: Record<string, any> = {
            userId,
            propertyCount: quotaDecision.nextUsage,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          };
          if (isGothamEntitled) {
            usagePatch.allowance = doorsAllowed;
            usagePatch.reconciledAt = admin.firestore.FieldValue.serverTimestamp();
          }
          tx.set(usageRef, usagePatch, { merge: true });
        }
        tx.create(propertyRef, propertyData);
        if (requestRef) {
          tx.create(requestRef, {
            userId,
            propertyId: propertyRef.id,
            payloadHash,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
        return { id: propertyRef.id, duplicate: false };
      });
      if (!result.id) throw new Error("Property creation idempotency record is invalid.");
      res.status(result.duplicate ? 200 : 201).json({ success: true, id: result.id, duplicate: result.duplicate });
    } catch (error: any) {
      console.error("Create Property Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Transfer initiation is server-authoritative; clients cannot mint or mutate transfer metadata.
  app.post("/api/properties/:id/transfer", requireAuth, paymentLimiter, async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database service unavailable");
      const userId = String((req as any).user?.uid || "");
      if (!userId) throw new ForbiddenError("Authenticated user is required.");
      const propertyId = String(req.params.id || "").trim();
      if (!propertyId) throw new BadRequestError("Property ID is required.");
      const buyerName = typeof req.body?.buyerName === "string" ? req.body.buyerName.trim().slice(0, 120) : "";
      const buyerEmail = typeof req.body?.buyerEmail === "string" ? req.body.buyerEmail.trim().toLowerCase() : "";
      const validityDays = Number(req.body?.validityDays);
      if (![14, 30, 60].includes(validityDays)) throw new BadRequestError("Transfer validity must be 14, 30, or 60 days.");
      if (buyerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) {
        throw new BadRequestError("A valid buyer email address is required.");
      }

      const propertyRef = db.collection("properties").doc(propertyId);
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const code = "TRF-" + Array.from({ length: 6 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join("");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000).toISOString();
      await db.runTransaction(async (tx: any) => {
        const propertySnap = await tx.get(propertyRef);
        if (!propertySnap.exists) throw new NotFoundError("Property not found.");
        const property = propertySnap.data() || {};
        const currentOwnerId = String(property.ownerId || property.userId || "");
        if (currentOwnerId !== userId) throw new ForbiddenError("Only the current property owner can initiate a transfer.");
        const duplicateCode = await tx.get(db.collection("properties")
          .where("transferCode", "==", code)
          .where("transferStatus", "==", "pending")
          .limit(1));
        if (!duplicateCode.empty) throw new ConflictError("Could not generate a unique transfer code. Please try again.");
        tx.update(propertyRef, {
          transferStatus: "pending",
          transferCode: code,
          transferExpiresAt: expiresAt,
          transferTargetName: buyerName || null,
          transferTargetEmail: buyerEmail || null,
          transferInitiatedAt: now.toISOString(),
          transferInitiatorUid: userId,
          updatedAt: now.toISOString()
        });
      });
      res.status(201).json({ success: true, code, expiresAt });
    } catch (error: any) {
      console.error("Initiate Property Transfer Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Revocation is also owner-authorized and server-only.
  app.post("/api/properties/:id/transfer/revoke", requireAuth, paymentLimiter, async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database service unavailable");
      const userId = String((req as any).user?.uid || "");
      if (!userId) throw new ForbiddenError("Authenticated user is required.");
      const propertyId = String(req.params.id || "").trim();
      if (!propertyId) throw new BadRequestError("Property ID is required.");
      const propertyRef = db.collection("properties").doc(propertyId);
      await db.runTransaction(async (tx: any) => {
        const propertySnap = await tx.get(propertyRef);
        if (!propertySnap.exists) throw new NotFoundError("Property not found.");
        const property = propertySnap.data() || {};
        const currentOwnerId = String(property.ownerId || property.userId || "");
        if (currentOwnerId !== userId) throw new ForbiddenError("Only the current property owner can revoke a transfer.");
        if (property.transferStatus !== "pending") throw new ConflictError("There is no pending transfer to revoke.");
        tx.update(propertyRef, {
          transferStatus: "none",
          transferCode: null,
          transferExpiresAt: null,
          transferTargetName: null,
          transferTargetEmail: null,
          transferInitiatedAt: null,
          transferInitiatorUid: null,
          updatedAt: new Date().toISOString()
        });
      });
      res.json({ success: true });
    } catch (error: any) {
      console.error("Revoke Property Transfer Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Property deletion also flows through the server so Gotham usage counters stay exact.
  app.delete("/api/properties/:id", requireAuth, async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database service unavailable");
      const authUid = String((req as any).user?.uid || "");
      if (!authUid) throw new ForbiddenError("Authenticated user is required.");
      const user = (req as any).user;
      const isAdmin = await checkIsAdmin(user);
      const propertyRef = db.collection("properties").doc(req.params.id);
      const result = await db.runTransaction(async (tx: any) => {
        const propertySnap = await tx.get(propertyRef);
        if (!propertySnap.exists) throw new NotFoundError("Property not found.");
        const property = propertySnap.data() || {};
        const ownerIds = [property.ownerId, property.userId, property.landlordId].filter((value: any) => typeof value === "string" && value.length > 0);
        const isOwner = ownerIds.includes(authUid);
        if (!isOwner && !isAdmin) throw new ForbiddenError("You are not authorized to delete this property.");
        const quotaOwnerId = isOwner ? authUid : String(ownerIds[0] || "");
        const quotaOwnerRef = quotaOwnerId ? db.collection("users").doc(quotaOwnerId) : null;
        const usageRef = quotaOwnerId ? db.collection("gotham_property_usage").doc(quotaOwnerId) : null;
        const [quotaOwnerSnap, usageSnap] = quotaOwnerRef && usageRef
          ? await Promise.all([tx.get(quotaOwnerRef), tx.get(usageRef)])
          : [null, null];
        if (quotaOwnerSnap?.exists || usageSnap?.exists) {
          const ownerProfile = quotaOwnerSnap?.exists ? (quotaOwnerSnap.data() || {}) : {};
          const isGothamAccount = ownerProfile.subscriptionType === "gotham_saas" || ownerProfile.isGothamSubscriber === true;
          if ((isGothamAccount || usageSnap?.exists) && usageRef) {
            let currentUsage: number;
            if (usageSnap?.exists) {
              const decrement = decrementGothamPropertyUsage(Number(usageSnap.data()?.propertyCount));
              if (!decrement.allowed) {
                if ("reason" in decrement && decrement.reason === "invalid_usage") {
                  throw new ForbiddenError("Gotham property usage is invalid; deletion requires reconciliation.");
                }
                throw new ForbiddenError("Gotham property usage is inconsistent; deletion requires reconciliation.");
              }
              currentUsage = decrement.nextUsage;
            } else {
              // If no reservation counter exists yet, backfill after excluding the
              // property being deleted so the delete and first create serialize.
              const [ownerQuery, userQuery, landlordQuery] = await Promise.all([
                tx.get(db.collection("properties").where("ownerId", "==", quotaOwnerId)),
                tx.get(db.collection("properties").where("userId", "==", quotaOwnerId)),
                tx.get(db.collection("properties").where("landlordId", "==", quotaOwnerId))
              ]);
              const existingIds = new Set<string>();
              for (const snap of [ownerQuery, userQuery, landlordQuery]) {
                snap.docs.forEach((doc: any) => {
                  if (doc.id !== propertyRef.id) existingIds.add(doc.id);
                });
              }
              currentUsage = existingIds.size;
            }
            tx.set(usageRef, {
              userId: quotaOwnerId,
              propertyCount: currentUsage,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
          }
        }
        tx.delete(propertyRef);
        tx.delete(db.collection("public_properties").doc(propertyRef.id));
        return { id: propertyRef.id };
      });
      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error("Delete Property Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Public transfer-code verification returns only the preview fields shown to a buyer.
  app.get("/api/properties/transfer/:code", paymentLimiter, async (req, res) => {
    try {
      const code = String(req.params.code || "").trim().toUpperCase();
      if (!/^TRF-[A-HJ-NP-Z2-9]{6}$/.test(code)) {
        return res.status(400).json({ error: "Invalid transfer code." });
      }
      if (!db) return res.status(503).json({ error: "Property transfer verification is unavailable." });
      const matches = await db.collection("properties")
        .where("transferCode", "==", code)
        .where("transferStatus", "==", "pending")
        .limit(2)
        .get();
      if (matches.size !== 1) return res.status(404).json({ error: "Invalid or expired transfer code." });
      const propertyDoc = matches.docs[0];
      const property = propertyDoc.data() || {};
      // AT-PASS-06: Require an explicit valid future expiration timestamp on pending transfer codes
      const rawExpiry = property.transferExpiresAt || property.expiresAt;
      if (!rawExpiry) {
        return res.status(410).json({ error: "This transfer code has expired or is missing an expiration timestamp." });
      }
      const expiry = new Date(rawExpiry).getTime();
      if (!Number.isFinite(expiry) || expiry <= Date.now()) {
        return res.status(410).json({ error: "This transfer code has expired or is invalid." });
      }
      // AT-PASS-05: Never fabricate synthetic defaults ("C", "Standard", "Good") when attributes are missing
      res.json({
        success: true,
        expiresAt: new Date(expiry).toISOString(),
        property: {
          id: propertyDoc.id,
          name: property.name || "Residential Property",
          propertyType: property.propertyType || null,
          address: {
            line1: property.address?.line1 || "",
            postcode: property.address?.postcode || property.postcode || "",
            city: property.address?.city || property.city || ""
          },
          epcRating: property.epcRating || null,
          boilerInfo: property.boilerInfo?.brand
            ? { brand: property.boilerInfo.brand, model: property.boilerInfo.model || null }
            : null,
          roofCondition: property.roofCondition || null,
          transferExpiresAt: new Date(expiry).toISOString()
        }
      });
    } catch (error: any) {
      console.error("Verify Property Transfer Code Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Ownership claim updates both owners' Gotham counters atomically with the transfer.
  app.post("/api/properties/claim-transfer", requireAuth, paymentLimiter, async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database service unavailable");
      const user = (req as any).user;
      const userId = String(user?.uid || "");
      const code = String(req.body?.code || "").trim().toUpperCase();
      if (!userId) throw new ForbiddenError("Authenticated user is required.");
      if (!/^TRF-[A-HJ-NP-Z2-9]{6}$/.test(code)) throw new BadRequestError("A valid transfer code is required.");

      const claimRef = db.collection("property_transfer_claims").doc(userId + "_" + code);
      const priorClaim = await claimRef.get();
      if (priorClaim.exists) {
        const prior = priorClaim.data() || {};
        const priorPropertyId = String(prior.propertyId || "");
        if (!priorPropertyId) throw new Error("Property transfer idempotency record is invalid.");
        return res.json({ success: true, id: priorPropertyId, duplicate: true });
      }

      const newOwnerRef = db.collection("users").doc(userId);
      const newOwnerSnap = await newOwnerRef.get();
      const newOwnerProfile = newOwnerSnap.exists ? (newOwnerSnap.data() || {}) : {};
      const newOwnerIsGotham = newOwnerProfile.subscriptionType === "gotham_saas" || newOwnerProfile.isGothamSubscriber === true;
      let verifiedGothamSubscriptionId = "";
      let verifiedGothamStatus = "";
      if (newOwnerIsGotham) {
        verifiedGothamSubscriptionId = String(newOwnerProfile.gothamSubscriptionId || "");
        if (!verifiedGothamSubscriptionId) throw new ForbiddenError("No verified Gotham subscription is linked to this account.");
        if (verifiedGothamSubscriptionId.startsWith("mock_")) {
          if (process.env.NODE_ENV === "production" || process.env.ALLOW_MOCK_PAYMENTS !== "true") {
            return res.status(503).json({ error: "Gotham subscription verification is unavailable." });
          }
          verifiedGothamStatus = String(newOwnerProfile.gothamSubscriptionStatus || "");
        } else {
          let stripeClient;
          try { stripeClient = getStripe(); } catch (_) {
            return res.status(503).json({ error: "Stripe is unavailable; Gotham entitlement could not be verified." });
          }
          let liveSubscription: Stripe.Subscription;
          try { liveSubscription = await stripeClient.subscriptions.retrieve(verifiedGothamSubscriptionId); } catch (_) {
            return res.status(503).json({ error: "Gotham subscription could not be verified with Stripe." });
          }
          verifiedGothamStatus = String(liveSubscription.status || "");
          const paidThrough = Number((liveSubscription as any).current_period_end || 0);
          const expiredCancellation = Boolean((liveSubscription as any).cancel_at_period_end) &&
            (!paidThrough || Date.now() >= paidThrough * 1000);
          if (!["active", "trialing"].includes(verifiedGothamStatus) || expiredCancellation) {
            throw new ForbiddenError("Gotham subscription is not currently entitled to receive another property.");
          }
        }
        if (!["active", "trialing"].includes(verifiedGothamStatus)) {
          throw new ForbiddenError("Gotham subscription is not currently entitled to receive another property.");
        }
      }

      const transferQuery = db.collection("properties")
        .where("transferCode", "==", code)
        .where("transferStatus", "==", "pending")
        .limit(2);
      const result = await db.runTransaction(async (tx: any) => {
        const matches = await tx.get(transferQuery);
        if (matches.size !== 1) throw new NotFoundError("Invalid, expired, or already claimed transfer code.");
        const propertyDoc = matches.docs[0];
        const propertyRef = propertyDoc.ref;
        const property = propertyDoc.data() || {};
        // AT-PASS-06: Reject missing or expired transfer expiration timestamps server-side
        const rawExpiry = property.transferExpiresAt || property.expiresAt;
        if (!rawExpiry) {
          throw new ForbiddenError("This property transfer code is missing an expiration timestamp and cannot be claimed.");
        }
        const expiry = new Date(rawExpiry).getTime();
        if (!Number.isFinite(expiry) || expiry <= Date.now()) {
          throw new ForbiddenError("This property transfer code has expired or is invalid.");
        }
        if (property.transferTargetEmail) {
          const expectedEmail = String(property.transferTargetEmail).trim().toLowerCase();
          const claimantEmail = String(user.email || "").trim().toLowerCase();
          if (!user.email_verified || !claimantEmail || claimantEmail !== expectedEmail) {
            throw new ForbiddenError("This transfer code is restricted to the verified buyer email specified by the owner.");
          }
        }
        const previousOwnerId = String(property.ownerId || property.userId || property.landlordId || "");
        if (!previousOwnerId) throw new ForbiddenError("Property has no verifiable previous owner.");
        if (previousOwnerId === userId) throw new BadRequestError("This property is already owned by your account.");

        const previousOwnerRef = db.collection("users").doc(previousOwnerId);
        const previousUsageRef = db.collection("gotham_property_usage").doc(previousOwnerId);
        const newUsageRef = db.collection("gotham_property_usage").doc(userId);
        const [previousOwnerSnap, latestNewOwnerSnap, previousUsageSnap, newUsageSnap, claimSnap] = await Promise.all([
          tx.get(previousOwnerRef), tx.get(newOwnerRef), tx.get(previousUsageRef), tx.get(newUsageRef), tx.get(claimRef)
        ]);
        if (claimSnap.exists) {
          const prior = claimSnap.data() || {};
          const priorPropertyId = String(prior.propertyId || "");
          if (!priorPropertyId) throw new Error("Property transfer idempotency record is invalid.");
          return { id: priorPropertyId, duplicate: true };
        }
        const previousProfile = previousOwnerSnap.exists ? (previousOwnerSnap.data() || {}) : {};
        const currentNewProfile = latestNewOwnerSnap.exists ? (latestNewOwnerSnap.data() || {}) : {};
        const previousIsGotham = previousProfile.subscriptionType === "gotham_saas" || previousProfile.isGothamSubscriber === true || previousUsageSnap.exists;
        const currentNewIsGotham = currentNewProfile.subscriptionType === "gotham_saas" || currentNewProfile.isGothamSubscriber === true;
        if (currentNewIsGotham && (
          currentNewProfile.gothamSubscriptionId !== verifiedGothamSubscriptionId ||
          !["active", "trialing"].includes(verifiedGothamStatus.toLowerCase())
        )) throw new ForbiddenError("Gotham subscription changed during the property transfer. Please retry.");

        let previousCount: number | null = null;
        let newCount: number | null = null;
        if (previousIsGotham) {
          if (previousUsageSnap.exists) {
            const decrement = decrementGothamPropertyUsage(Number(previousUsageSnap.data()?.propertyCount));
            if (!decrement.allowed) {
              if ("reason" in decrement && decrement.reason === "invalid_usage") {
                throw new ForbiddenError("Previous owner's Gotham usage requires reconciliation.");
              }
              throw new ForbiddenError("Previous owner's Gotham usage is inconsistent; transfer requires reconciliation.");
            }
            previousCount = decrement.nextUsage;
          } else {
            const [ownerQ, userQ, landlordQ] = await Promise.all([
              tx.get(db.collection("properties").where("ownerId", "==", previousOwnerId)),
              tx.get(db.collection("properties").where("userId", "==", previousOwnerId)),
              tx.get(db.collection("properties").where("landlordId", "==", previousOwnerId))
            ]);
            const ids = new Set<string>();
            for (const snap of [ownerQ, userQ, landlordQ]) snap.docs.forEach((doc: any) => {
              if (doc.id !== propertyRef.id) ids.add(doc.id);
            });
            previousCount = ids.size;
          }
        }
        if (currentNewIsGotham || newUsageSnap.exists) {
          const allowance = currentNewIsGotham ? Number(currentNewProfile.gothamDoorsCount) : 0;
          let currentNewCount: number;
          if (newUsageSnap.exists) {
            currentNewCount = Number(newUsageSnap.data()?.propertyCount);
          } else {
            const [ownerQ, userQ, landlordQ] = await Promise.all([
              tx.get(db.collection("properties").where("ownerId", "==", userId)),
              tx.get(db.collection("properties").where("userId", "==", userId)),
              tx.get(db.collection("properties").where("landlordId", "==", userId))
            ]);
            const ids = new Set<string>();
            for (const snap of [ownerQ, userQ, landlordQ]) snap.docs.forEach((doc: any) => ids.add(doc.id));
            currentNewCount = ids.size;
          }
          const quotaDecision = evaluateGothamPropertyQuota(currentNewCount, allowance, currentNewIsGotham);
          if (!quotaDecision.allowed) {
            if ("reason" in quotaDecision && quotaDecision.reason === "invalid_usage") {
              throw new ForbiddenError("New owner's Gotham usage requires reconciliation.");
            }
            if ("reason" in quotaDecision && quotaDecision.reason === "invalid_allowance") {
              throw new ForbiddenError("New owner's Gotham door allowance is invalid.");
            }
            throw new ForbiddenError("Your Gotham subscription has reached its purchased property limit.");
          }
          newCount = quotaDecision.nextUsage;
        }

        tx.update(
          propertyRef,
          buildClaimPropertyTransferUpdate({
            property,
            newOwnerId: userId,
            newOwnerEmail: user.email || null,
            transferCode: code,
          })
        );
        // Remove previous owner's public passport projection atomically upon ownership transfer
        tx.delete(db.collection("public_properties").doc(propertyRef.id));
        if (previousCount !== null) tx.set(previousUsageRef, {
          userId: previousOwnerId, propertyCount: previousCount,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        if (newCount !== null) tx.set(newUsageRef, {
          userId, propertyCount: newCount,
          ...(currentNewIsGotham ? { allowance: Number(currentNewProfile.gothamDoorsCount) } : {}),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        tx.create(claimRef, {
          userId, propertyId: propertyRef.id,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return { id: propertyRef.id, duplicate: false };
      });
      if (!result.id) throw new Error("Property transfer idempotency record is invalid.");
      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error("Claim Property Transfer Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // AT-PASS-02 & AT-PASS-07: Canonical Public QR Passport & Buyer Pack Snapshot Endpoint
  app.get("/api/properties/:id/public-passport", generalLimiter, async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable" });
      }
      const propertyId = String(req.params.id || "").trim();
      if (!propertyId) throw new BadRequestError("Property ID is required.");

      const propDoc = await db.collection("properties").doc(propertyId).get();
      if (!propDoc.exists) {
        throw new NotFoundError("Property passport not found.");
      }
      const propData = propDoc.data() || {};

      // Allow authenticated owner/admin to preview even before public consent; otherwise require explicit publicConsent === true
      let isOwnerOrAdmin = false;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        try {
          const decoded = await verifyTokenSafely(authHeader.split("Bearer ")[1]);
          if (decoded?.uid) {
            const ownerMatch = propData.ownerId === decoded.uid || propData.userId === decoded.uid || propData.landlordId === decoded.uid;
            isOwnerOrAdmin = ownerMatch || (await checkIsAdmin(decoded));
          }
        } catch {
          isOwnerOrAdmin = false;
        }
      }

      const isConsentedPublic = isPropertyEligibleForPublicPassport(propData);
      if (!isConsentedPublic && !isOwnerOrAdmin) {
        return res.status(403).json({ error: "This property passport is private or public sharing consent has not been granted." });
      }

      const [passportSnap, publicPropSnap] = await Promise.all([
        db.collection("property_passports").doc(propertyId).get(),
        db.collection("public_properties").doc(propertyId).get(),
      ]);

      const canonicalPassport = passportSnap.exists ? (passportSnap.data() || null) : null;
      const sanitizedProperty = publicPropSnap.exists
        ? { id: propertyId, ...(publicPropSnap.data() || {}) }
        : sanitizePropertyToPublicPassport(propertyId, propData);

      // Load completed public jobs associated with this property without exposing private homeowner PII
      let completedJobs: any[] = [];
      try {
        const jobsSnap = await db.collection("public_job_cards").where("propertyId", "==", propertyId).limit(50).get();
        completedJobs = jobsSnap.docs
          .map((d: any) => ({ id: d.id, ...(d.data() || {}) }))
          .filter((j: any) => String(j.status || "").toLowerCase() === "completed");
      } catch {
        completedJobs = [];
      }

      return res.json({
        success: true,
        property: sanitizedProperty,
        canonicalPassport,
        provenance: canonicalPassport
          ? {
              snapshotId: canonicalPassport.snapshotId || canonicalPassport.latestSnapshotId || canonicalPassport.id || propertyId,
              schemaVersion: canonicalPassport.schemaVersion || "v8.2-passport-v1",
              pipelineVersion: canonicalPassport.pipelineVersion || "v8.2.0",
              contentHash: canonicalPassport.contentHash || canonicalPassport.provenance?.contentHash || null,
              generatedAt: canonicalPassport.generatedAt || canonicalPassport.updatedAt || null,
              evidenceCount: Array.isArray(canonicalPassport.provenance?.evidenceIds)
                ? canonicalPassport.provenance.evidenceIds.length
                : 0,
            }
          : null,
        completedJobs,
      });
    } catch (error: any) {
      console.error("Get Public Property Passport Error:", error);
      sendHttpError(res, error, req);
    }
  });

  app.post("/api/properties/:id/sync-public-passport", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const user = (req as any).user;

      if (!db) {
        return res.status(503).json({ error: "Database service unavailable" });
      }

      const propRef = db.collection("properties").doc(id);
      const propDoc = await propRef.get();
      if (!propDoc.exists) {
        throw new NotFoundError("Property not found");
      }

      const existing = propDoc.data()!;
      const isOwner = existing.ownerId === user.uid || existing.userId === user.uid || existing.landlordId === user.uid;
      const isAdmin = await checkIsAdmin(user);
      if (!isOwner && !isAdmin) {
        throw new ForbiddenError("Unauthorized to sync this property passport projection.");
      }

      // Allow owner/admin to explicitly toggle public sharing consent atomically in this endpoint
      const body = req.body || {};
      const nextIsPublic = typeof body.isPublicPassport === "boolean" ? body.isPublicPassport : existing.isPublicPassport === true;
      const nextConsent = typeof body.publicConsent === "boolean" ? body.publicConsent : existing.publicConsent === true;

      const updatedData = {
        ...existing,
        isPublicPassport: nextIsPublic,
        publicConsent: nextConsent,
      };

      if (typeof body.isPublicPassport === "boolean" || typeof body.publicConsent === "boolean") {
        await propRef.update({
          isPublicPassport: nextIsPublic,
          publicConsent: nextConsent,
          publicConsentUpdatedAt: new Date().toISOString(),
          publicConsentUpdatedBy: user.uid,
          updatedAt: new Date().toISOString(),
        });
      }

      // AT-PASS-07 & AT-PROP-08: Require explicit affirmative isPublicPassport === true && publicConsent === true
      const published = isPropertyEligibleForPublicPassport(updatedData);
      if (published) {
        const publicPassport = sanitizePropertyToPublicPassport(id, updatedData);
        await db.collection("public_properties").doc(id).set(publicPassport, { merge: true });
      } else {
        await db.collection("public_properties").doc(id).delete();
      }

      res.json({
        success: true,
        id,
        status: (updatedData as Record<string, any>).status || "active",
        published,
        isPublicPassport: nextIsPublic,
        publicConsent: nextConsent,
      });
    } catch (error: any) {
      console.error("Sync Single Public Property Passport Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Privacy-safe property context lookup for Tenant Repair Portal links (/tenant-report?propertyId=...)
  app.get("/api/properties/:id/tenant-context", generalLimiter, async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable" });
      }
      const propertyId = String(req.params.id || "").trim();
      if (!propertyId || propertyId === "manual") {
        throw new BadRequestError("Valid Property ID is required.");
      }
      const propDoc = await db.collection("properties").doc(propertyId).get();
      if (!propDoc.exists) {
        throw new NotFoundError("Property not found.");
      }
      const context = sanitizePropertyTenantContext(propDoc.id, propDoc.data() || {});
      return res.json({ success: true, property: context });
    } catch (error: any) {
      console.error("Get Tenant Property Context Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // AT-TENANT-02: Server-authoritative tenant issue creation deriving landlordOwnerId from authoritative property doc
  app.post("/api/tenant-issues", generalLimiter, async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable" });
      }
      const body = req.body || {};
      const rawPropertyId = typeof body.propertyId === "string" ? body.propertyId.trim().slice(0, 128) : "";

      let reporterUid: string | null = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        try {
          const decoded = await verifyTokenSafely(authHeader.split("Bearer ")[1]);
          reporterUid = decoded?.uid || null;
        } catch {
          reporterUid = null;
        }
      }

      let linkedPropDoc: { id: string; data: Record<string, any> } | null = null;
      if (rawPropertyId && rawPropertyId !== "manual") {
        const propDoc = await db.collection("properties").doc(rawPropertyId).get();
        if (!propDoc.exists) {
          throw new NotFoundError("Referenced property was not found.");
        }
        linkedPropDoc = { id: propDoc.id, data: propDoc.data() || {} };
      }

      let resolved;
      try {
        resolved = resolveTenantIssueCreationPayload(body, linkedPropDoc);
      } catch (err: any) {
        if (err instanceof TenantIssueValidationError) {
          throw new BadRequestError(err.message);
        }
        throw err;
      }

      const nowIso = new Date().toISOString();
      const docRef = await db.collection("tenant_issues").add({
        propertyId: resolved.propertyId,
        propertyName: resolved.propertyName,
        address: resolved.address,
        postcode: resolved.postcode,
        landlordOwnerId: resolved.landlordOwnerId,
        reporterUid,
        tenantName: resolved.tenantName,
        tenantPhone: resolved.tenantPhone,
        tenantEmail: resolved.tenantEmail,
        flatUnit: resolved.flatUnit,
        category: resolved.category,
        urgency: resolved.urgency,
        title: resolved.title,
        description: resolved.description,
        status: "open",
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      if (resolved.landlordOwnerId) {
        try {
          await db.collection("notifications").add({
            userId: resolved.landlordOwnerId,
            title: `New ${resolved.urgency.toUpperCase()} Tenant Repair Report`,
            message: `${resolved.tenantName} reported "${resolved.title}" at ${resolved.propertyName}.`,
            type: "tenant_issue",
            propertyId: resolved.propertyId,
            issueId: docRef.id,
            link: "/portfolio",
            read: false,
            createdAt: nowIso,
          });
        } catch {
          // Non-fatal
        }
      }

      return res.status(201).json({
        success: true,
        id: docRef.id,
        propertyId: resolved.propertyId,
        linkedToLandlord: resolved.linkedToLandlord,
        status: "open",
      });
    } catch (error: any) {
      console.error("Create Tenant Issue Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // AT-PROFILE-02: Server-authoritative Profile Coach acknowledgment & dismissal persistence
  app.get("/api/profile/coach/state", requireAuth, async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const uid = String((req as any).user?.uid || "");
      const stateSnap = await db.collection("users").doc(uid).collection("profile_coach_state").doc("current").get();
      const data = stateSnap.exists ? (stateSnap.data() || {}) : {};
      return res.json({
        success: true,
        acknowledgedSuggestionIds: Array.isArray(data.acknowledgedSuggestionIds) ? data.acknowledgedSuggestionIds : [],
        dismissedSuggestionIds: Array.isArray(data.dismissedSuggestionIds) ? data.dismissedSuggestionIds : [],
        lastNotifiedAt: data.lastNotifiedAt || null,
        lastAuditedAt: data.lastAuditedAt || null,
      });
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  app.post("/api/profile/coach/acknowledge", requireAuth, async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const uid = String((req as any).user?.uid || "");
      const { suggestionId, action = "acknowledge", auditSummary } = req.body || {};
      const cleanId = typeof suggestionId === "string" ? suggestionId.trim().slice(0, 120) : "";
      if (!cleanId && action !== "record_audit") {
        throw new BadRequestError("suggestionId is required.");
      }

      const stateRef = db.collection("users").doc(uid).collection("profile_coach_state").doc("current");
      const nowIso = new Date().toISOString();
      let nextState: any = null;

      await db.runTransaction(async (tx: any) => {
        const snap = await tx.get(stateRef);
        const existing = snap.exists ? (snap.data() || {}) : {};
        const ackSet = new Set<string>(Array.isArray(existing.acknowledgedSuggestionIds) ? existing.acknowledgedSuggestionIds : []);
        const dismissSet = new Set<string>(Array.isArray(existing.dismissedSuggestionIds) ? existing.dismissedSuggestionIds : []);

        if (cleanId) {
          ackSet.add(cleanId);
          if (action === "dismiss") {
            dismissSet.add(cleanId);
          }
        }

        nextState = {
          acknowledgedSuggestionIds: Array.from(ackSet).slice(0, 200),
          dismissedSuggestionIds: Array.from(dismissSet).slice(0, 200),
          lastAuditedAt: action === "record_audit" ? nowIso : (existing.lastAuditedAt || nowIso),
          lastAuditSummary: typeof auditSummary === "string" ? auditSummary.slice(0, 300) : (existing.lastAuditSummary || null),
          updatedAt: nowIso,
        };
        tx.set(stateRef, nextState, { merge: true });
      });

      return res.json({ success: true, ...nextState });
    } catch (error: any) {
      console.error("Profile Coach Acknowledge Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // AT-ACCOUNT-03: Atomic Admin Trader Verification & Public Discovery Sync
  app.post("/api/admin/traders/:uid/verify", requireAdmin, requireAdminTier("financial_operator", "verifying trader accounts"), async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const targetUid = String(req.params.uid || "").trim();
      const adminUser = (req as any).user;
      const { status, reason } = req.body || {};
      const result = await verifyTraderAccountWithProjection({
        db,
        adminUid: adminUser.uid,
        adminEmail: adminUser.email || undefined,
        targetUid,
        verificationStatus: status,
        reason: typeof reason === "string" ? reason.slice(0, 300) : undefined,
      });
      return res.json(result);
    } catch (error: any) {
      console.error("Admin Verify Trader Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // AT-ACCOUNT-04: Atomic Admin Verification Document Review & Public Discovery Sync
  app.post("/api/admin/traders/:uid/documents/review", requireAdmin, requireAdminTier("financial_operator", "reviewing trader verification documents"), async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const targetUid = String(req.params.uid || "").trim();
      const adminUser = (req as any).user;
      const { docType, decision, reason } = req.body || {};
      const result = await reviewTraderVerificationDocument({
        db,
        adminUid: adminUser.uid,
        adminEmail: adminUser.email || undefined,
        targetUid,
        docType,
        decision,
        reason: typeof reason === "string" ? reason.slice(0, 300) : undefined,
      });
      return res.json(result);
    } catch (error: any) {
      console.error("Admin Review Verification Document Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // AT-ADMIN-DISPUTE-01: Authoritative Admin Dispute Resolution with Projection Sync & Participant Notifications
  app.post(
    "/api/admin/disputes/:jobId/resolve",
    requireAdmin,
    requireAdminTier("financial_operator", "resolving disputes"),
    async (req, res) => {
      try {
        if (!db) return res.status(503).json({ error: "Database service unavailable" });
        const jobId = String(req.params.jobId || "").trim();
        const adminUser = (req as any).user;
        const { resolution, notes } = req.body || {};
        const result = await executeAdminResolveDisputeCommand({
          db,
          admin: { uid: adminUser.uid, email: adminUser.email || null },
          jobId,
          resolution,
          notes,
          stripe: getOptionalStripeClient(),
        });
        return res.json(result);
      } catch (error: any) {
        console.error("Admin Resolve Dispute Error:", error);
        sendHttpError(res, error, req);
      }
    }
  );

  // AT-ADMIN-VIDEO-KYC-01: Authoritative Admin Video Credential Verification Review
  app.post("/api/admin/traders/:uid/video-verification", requireAdmin, requireAdminTier("financial_operator", "reviewing trader video credentials"), async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const targetUid = String(req.params.uid || "").trim();
      const adminUser = (req as any).user;
      const { decision, reason } = req.body || {};
      const result = await executeAdminVideoVerificationCommand({
        db,
        admin: { uid: adminUser.uid, email: adminUser.email || null },
        targetUid,
        decision,
        reason,
      });
      return res.json(result);
    } catch (error: any) {
      console.error("Admin Video Verification Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // AT-ADMIN-PROVISIONAL-01: Per-Trader Provisional Grace Extension & Duplicate-Phone Override
  app.post(
    "/api/admin/traders/:uid/provisional-override",
    requireAdmin,
    requireAdminTier("super_admin", "overriding provisional trader status"),
    async (req, res) => {
      try {
        if (!db) return res.status(503).json({ error: "Database service unavailable" });
        const targetUid = String(req.params.uid || "").trim();
        const adminUser = (req as any).user;
        const { action, extendDays, reason } = req.body || {};
        const result = await executeAdminProvisionalOverrideCommand({
          db,
          admin: { uid: adminUser.uid, email: adminUser.email || null },
          targetUid,
          action,
          extendDays,
          reason,
        });
        return res.json(result);
      } catch (error: any) {
        console.error("Admin Provisional Override Error:", error);
        sendHttpError(res, error, req);
      }
    }
  );

  // AT-ADMIN-REVIEW-01: Authoritative Review Moderation & Atomic Rating Recalculation
  app.post("/api/admin/reviews/:reviewId/moderate", requireAdmin, requireAdminTier("financial_operator", "moderating reviews"), async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const reviewId = String(req.params.reviewId || "").trim();
      const adminUser = (req as any).user;
      const { action, reason } = req.body || {};
      const result = await executeAdminModerateReviewCommand({
        db,
        admin: { uid: adminUser.uid, email: adminUser.email || null },
        reviewId,
        action,
        reason,
      });
      return res.json(result);
    } catch (error: any) {
      console.error("Admin Review Moderation Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // =========================================================================
  // UNIFIED STRIPE CONNECT ONBOARDING & PAYOUTS (TRADERS, DRIVERS, PROVIDERS)
  // Ensures direct money routing to providers: Platform NEVER holds client funds.
  // =========================================================================

  // 1. Create or Resume Stripe Connect Express Onboarding (AT-PAY-19, AT-PAY-20, AT-STRIPE-CONNECT-01)
  app.post("/api/stripe/create-connect-account", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter, async (req, res) => {
    try {
      const authUid = (req as any).user.uid;
      if (!db) throw new BadRequestError("Database not connected");

      const userDoc = await db.collection("users").doc(authUid).get();
      if (!userDoc.exists) throw new NotFoundError("User profile not found");
      const userData = userDoc.data() || {};

      // Enforce payout-eligible provider/driver role before initializing Connect onboarding
      assertPayoutEligibleRole(userData);

      const rawReturnTarget = typeof req.body?.returnTarget === "string" ? req.body.returnTarget.trim().toLowerCase() : "";
      const safeReturnBasePath =
        rawReturnTarget === "profile"
          ? "/profile"
          : rawReturnTarget === "driver-terminal"
            ? "/driver-terminal"
            : rawReturnTarget === "driver-dashboard"
              ? "/driver-dashboard"
              : rawReturnTarget === "driver-return"
                ? "/driver-return"
                : "/billing";
      const safeHashSuffix = rawReturnTarget === "profile" ? "#payments" : "";

      const appUrl = getAuthoritativeAppUrl();
      let stripe;
      try {
        stripe = getStripe();
      } catch (e) {
        if (process.env.NODE_ENV === 'production' || process.env.ALLOW_MOCK_PAYMENTS !== 'true') {
          console.error("Stripe is not configured in production/live environment. Refusing mock Connect onboarding bypass.");
          return res.status(503).json({ error: "Stripe Connect onboarding is currently unavailable: Stripe gateway is unconfigured." });
        }
        // Fallback for dev / mock testing ONLY when ALLOW_MOCK_PAYMENTS === "true"
        const mockAccountId = userData.stripeAccountId || `acct_mock_${authUid.substring(0, 12)}`;
        await db.collection("users").doc(authUid).set({
          stripeAccountId: mockAccountId,
          stripeOnboardingComplete: true,
          payoutsEnabled: true,
          chargesEnabled: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return res.json({
          success: true,
          mock: true,
          stripeAccountId: mockAccountId,
          url: `${appUrl}${safeReturnBasePath}?stripe_connect=success&account_id=${mockAccountId}${safeHashSuffix}`
        });
      }

      const { accountId } = await ensureStripeAccountForProvider({
        db,
        stripe,
        authUid,
        userData,
        requestedBusinessType: req.body?.businessType,
      });

      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${appUrl}${safeReturnBasePath}?stripe_connect=refresh${safeHashSuffix}`,
        return_url: `${appUrl}${safeReturnBasePath}?stripe_connect=success&account_id=${accountId}${safeHashSuffix}`,
        type: "account_onboarding",
      });

      res.json({
        success: true,
        url: accountLink.url,
        stripeAccountId: accountId
      });
    } catch (error: any) {
      console.error("Create Connect Account Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // 2. Query Stripe Connect Status & Sync with Firestore
  app.get("/api/stripe/account-status", requireAuth, async (req, res) => {
    try {
      const authUid = (req as any).user.uid;
      if (!db) return res.json({ connected: false, payoutsEnabled: false, chargesEnabled: false, detailsSubmitted: false });

      const userDoc = await db.collection("users").doc(authUid).get();
      if (!userDoc.exists) return res.json({ connected: false, payoutsEnabled: false, chargesEnabled: false, detailsSubmitted: false });
      const userData = userDoc.data() || {};
      const accountId = userData.stripeAccountId;

      if (!accountId) {
        return res.json({ connected: false, payoutsEnabled: false, chargesEnabled: false, detailsSubmitted: false });
      }

      const isMockDisallowed = process.env.NODE_ENV === 'production' || process.env.ALLOW_MOCK_PAYMENTS !== 'true';

      if (accountId.startsWith("acct_mock_")) {
        if (isMockDisallowed) {
          return res.json({
            connected: false,
            stripeAccountId: accountId,
            payoutsEnabled: false,
            chargesEnabled: false,
            detailsSubmitted: false,
            error: "Mock Stripe account is invalid in live environments."
          });
        }
        return res.json({
          connected: true,
          mock: true,
          stripeAccountId: accountId,
          payoutsEnabled: true,
          chargesEnabled: true,
          detailsSubmitted: true
        });
      }

      let stripe;
      try {
        stripe = getStripe();
      } catch (e) {
        if (isMockDisallowed) {
          return res.status(503).json({
            connected: false,
            payoutsEnabled: false,
            chargesEnabled: false,
            detailsSubmitted: false,
            error: "Stripe service is unavailable: Gateway is unconfigured."
          });
        }
        return res.json({
          connected: true,
          mock: true,
          stripeAccountId: accountId,
          payoutsEnabled: true,
          chargesEnabled: true,
          detailsSubmitted: true
        });
      }

      const account = await stripe.accounts.retrieve(accountId);
      const payoutsEnabled = Boolean(account.payouts_enabled);
      const chargesEnabled = Boolean(account.charges_enabled);
      const detailsSubmitted = Boolean(account.details_submitted);

      if (payoutsEnabled !== userData.payoutsEnabled || chargesEnabled !== userData.chargesEnabled) {
        await db.collection("users").doc(authUid).set({
          payoutsEnabled,
          chargesEnabled,
          stripeOnboardingComplete: detailsSubmitted,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }

      res.json({
        connected: true,
        stripeAccountId: accountId,
        payoutsEnabled,
        chargesEnabled,
        detailsSubmitted
      });
    } catch (error: any) {
      console.error("Stripe Account Status Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // 3. Create Login Link to Stripe Express Dashboard (AT-PAY-22, AT-PAY-23)
  app.post("/api/stripe/create-login-link", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter, async (req, res) => {
    try {
      const authUid = (req as any).user.uid;
      if (!db) throw new BadRequestError("Database not connected");

      const userDoc = await db.collection("users").doc(authUid).get();
      const userData = userDoc.data() || {};
      const accountId = userData.stripeAccountId;

      if (!accountId) {
        throw new BadRequestError("No connected Stripe account found for this user");
      }

      const isMockDisallowed = process.env.NODE_ENV === 'production' || process.env.ALLOW_MOCK_PAYMENTS !== 'true';

      if (accountId.startsWith("acct_mock_")) {
        if (isMockDisallowed) {
          return res.status(400).json({ error: "Mock Stripe accounts do not have an Express Dashboard in live environments." });
        }
        const appUrl = getAuthoritativeAppUrl();
        return res.json({ url: `${appUrl}/billing?dashboard=mock_express` });
      }

      let stripe;
      try {
        stripe = getStripe();
      } catch (e) {
        if (isMockDisallowed) {
          return res.status(503).json({ error: "Stripe service is unavailable: Gateway is unconfigured." });
        }
        const appUrl = getAuthoritativeAppUrl();
        return res.json({ url: `${appUrl}/billing?dashboard=mock_express` });
      }

      const loginLink = await stripe.accounts.createLoginLink(accountId);
      res.json({ url: loginLink.url });
    } catch (error: any) {
      console.error("Create Login Link Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // 4. Unified Provider Balance (Traders & Drivers)
  app.get("/api/stripe/balance", requireAuth, async (req, res) => {
    try {
      const authUid = (req as any).user.uid;
      if (!db) return res.status(503).json({ error: "Database backend unavailable" });

      const userDoc = await db.collection("users").doc(authUid).get();
      if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

      const stripeAccountId = userDoc.data()?.stripeAccountId;
      if (!stripeAccountId) return res.status(400).json({ error: "No Stripe account connected" });

      const isMockDisallowed = process.env.NODE_ENV === 'production' || process.env.ALLOW_MOCK_PAYMENTS !== 'true';

      if (stripeAccountId.startsWith("acct_mock_")) {
        if (isMockDisallowed) {
          return res.status(400).json({ error: "Mock Stripe accounts are not supported in live environments." });
        }
        return res.json({ available: 150.00, pending: 45.00, currency: 'gbp', mock: true });
      }

      let stripe;
      try {
        stripe = getStripe();
      } catch (e) {
        if (isMockDisallowed) {
          return res.status(503).json({ error: "Stripe service is unavailable: Gateway is unconfigured." });
        }
        return res.json({ available: 0, pending: 0, currency: 'gbp', mock: true });
      }

      const balance = await stripe.balance.retrieve({
        stripeAccount: stripeAccountId,
      });

      const available = balance.available.find(b => b.currency === 'gbp')?.amount || 0;
      const pending = balance.pending.find(b => b.currency === 'gbp')?.amount || 0;

      res.json({
        available: available / 100,
        pending: pending / 100,
        currency: 'gbp'
      });
    } catch (error: any) {
      console.error("Stripe Balance Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // 5. Unified Provider Payout Request (Traders & Drivers — AT-PAY-09 Idempotent + Locked)
  app.post("/api/stripe/request-payout", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter, async (req, res) => {
    try {
      const authUid = (req as any).user.uid;
      const { amount, idempotencyKey: bodyIdempotencyKey } = req.body || {};
      const headerIdempotencyKey =
        req.header("Idempotency-Key") ||
        req.header("x-idempotency-key") ||
        (typeof bodyIdempotencyKey === "string" ? bodyIdempotencyKey : "");

      const isMockDisallowed =
        process.env.NODE_ENV === "production" || process.env.ALLOW_MOCK_PAYMENTS !== "true";
      const stripe = getOptionalStripeClient();

      const result = await executeProviderPayoutCommand({
        db,
        stripe,
        authUid,
        idempotencyKey: headerIdempotencyKey,
        amountGbp: amount,
        isMockDisallowed,
      });

      return res.json(result);
    } catch (error: any) {
      console.error("Provider Payout Error:", error);
      if (error?.status === 503) {
        return res.status(503).json({ error: error.message });
      }
      sendHttpError(res, error, req);
    }
  });

  // Manual Driver Payouts Trigger (Admin: financial_operator+ with audit context & optional dual-control gate)
  app.post("/api/admin/trigger-payouts", requireAdmin, requireAdminTier("financial_operator", "triggering driver payouts"), async (req, res) => {
    try {
      const actor: AdminActor = (req as any).adminActor;
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "Manual admin driver payout batch";
      const approvalRequestId = typeof req.body?.approvalRequestId === "string" ? req.body.approvalRequestId.trim() : "";
      const estimatedAmountGbp = Number(req.body?.estimatedAmountGbp) || 0;
      const requireDualControl =
        req.body?.requireDualControl === true || estimatedAmountGbp >= DUAL_CONTROL_THRESHOLD_GBP;

      if (requireDualControl) {
        await consumeDualControlApproval(db, approvalRequestId, "manual_driver_payout_batch", actor);
      }

      const result = await runDriverPayoutOrchestration({
        uid: actor.uid,
        email: actor.email,
        triggerSource: approvalRequestId ? "approval_execution" : "manual_admin",
        reason,
        approvalRequestId: approvalRequestId || undefined,
      });
      if (!result?.success) {
        return res.status(500).json(result);
      }
      res.json(result);
    } catch (err: any) {
      console.error("Manual payout orchestration failed:", err);
      sendHttpError(res, err, req);
    }
  });

  // Manual Trigger for Consultancy Scheduled Jobs (AT-CONS-SCHED-01: real workers & visible error propagation)
  app.post("/api/admin/trigger-consultancy-jobs", requireAdmin, requireAdminTier("financial_operator", "triggering consultancy jobs"), async (req, res) => {
    try {
      const recurringSessions = await runConsultancyRecurringSessionCreator();
      const matchScores = await runConsultancyScoreRecalculator();

      const allErrors = [...(recurringSessions.errors || []), ...(matchScores.errors || [])];
      const bothFailed = recurringSessions.status === "failed" && matchScores.status === "failed";
      const anyFailedOrPartial =
        recurringSessions.status === "failed" ||
        matchScores.status === "failed" ||
        recurringSessions.status === "partial" ||
        matchScores.status === "partial";
      const bothSkipped = recurringSessions.status === "skipped" && matchScores.status === "skipped";

      const httpStatus = bothFailed ? 500 : anyFailedOrPartial ? 207 : 200;
      res.status(httpStatus).json({
        success: !bothFailed && !anyFailedOrPartial && !bothSkipped,
        status: bothFailed ? "failed" : anyFailedOrPartial ? "partial" : bothSkipped ? "skipped" : "executed",
        recurringSessions,
        matchScores,
        errors: allErrors,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("Consultancy background jobs failed:", err);
      sendHttpError(res, err, req);
    }
  });

  // Platform Fee Settlement Route (AT-RIDE-PAY-07: strict DB-authoritative balance & webhook ledger settlement)
  app.post("/api/driver/settle-fees", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter, async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({ error: "Database backend unavailable for fee settlement." });
      }
      const driverId = (req as any).user.uid;
      const appUrl = getAuthoritativeAppUrl();

      let stripe;
      try {
        stripe = getStripe();
      } catch {
        return res.status(503).json({
          error: "Fee settlement is currently unavailable: Stripe gateway is unconfigured.",
        });
      }

      const result = await createDriverFeeSettlementCheckout({
        db,
        driverId,
        stripeClient: stripe,
        appUrl,
      });

      res.json({ url: result.url, sessionId: result.sessionId, intentId: result.intentId });
    } catch (error: any) {
      console.error("Fee Settlement Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Authoritative Stripe Webhook Fee Settlement Status Lookup (replaces redirect-URL settlement)
  app.get("/api/driver/fee-settlement-status", requireAuth, async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({ error: "Database backend unavailable" });
      }
      const caller = (req as any).user;
      const sessionId = String(req.query?.session_id || "").trim();
      if (!sessionId) {
        return res.status(400).json({ error: "Missing session_id query parameter." });
      }

      const settlementSnap = await db.collection("driver_fee_settlements").doc(sessionId).get();
      if (settlementSnap.exists) {
        const data = settlementSnap.data() || {};
        if (data.driverId !== caller.uid && caller.isAdmin !== true && caller.admin !== true) {
          return res.status(403).json({ error: "Forbidden: Settlement does not belong to this driver." });
        }
        return res.json({
          settled: true,
          status: "settled",
          settledAmount: Number(data.settledAmount || 0),
          sessionId,
        });
      }

      const driverSnap = await db.collection("users").doc(caller.uid).get();
      const pendingPlatformFees = driverSnap.exists ? Number(driverSnap.data()?.pendingPlatformFees || 0) : null;
      return res.json({
        settled: false,
        status: "pending",
        pendingPlatformFees,
        sessionId,
      });
    } catch (error: any) {
      console.error("Fee Settlement Status Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Legacy URL-redirect settlement endpoint locked down — fees settle strictly via signed Stripe webhooks
  app.post("/api/driver/confirm-fee-settlement", requireAuth, async (_req, res) => {
    return res.status(403).json({
      error: "Direct settlement confirmation is disabled; platform fee settlements are reconciled strictly via signed Stripe webhooks.",
    });
  });

  // Server-Authoritative Milestone Release Route & QR Handshake (V6 Hardened)
  app.post("/api/release-milestone", requireAuth, handshakeLimiter, async (req, res) => {
    try {
      const { jobId, quoteId, milestoneId, isQrHandshake } = req.body;
      const handshakeCode = req.body.handshakeCode || req.body.pin || req.body.verificationPin;
      const authUser = (req as any).user;
      const authUid = authUser.uid;
      if (!db) throw new BadRequestError("Database not initialized");
      const firestoreDb = db;
      if (!jobId || !quoteId) throw new BadRequestError("jobId and quoteId are required");

      const idempotencyKey = (req.headers["x-idempotency-key"] as string) || 
        (req.headers["idempotency-key"] as string) || 
        req.body.idempotencyKey || 
        "";

      if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8) {
        throw new BadRequestError("A stable, non-empty Idempotency-Key is required for payment operations (minimum 8 characters)");
      }

      // Check Stripe integration readiness
      let stripeClient = null;
      try {
        stripeClient = getStripe();
      } catch (e) {}

      if (process.env.NODE_ENV === "production" && !stripeClient) {
        throw new InternalServerError("Stripe integration unavailable for escrow transfer");
      }

      // Persist QR PIN failures per job/user across server instances and restarts.
      if (isQrHandshake) {
        await PaymentLedgerEngine.validateAndRecordQrHandshakeAttempt(firestoreDb, {
          jobId, authUid,
          handshakeCode: typeof handshakeCode === "string" ? handshakeCode : undefined,
        });
      }

      // Delegate to canonical authority
      const result = await PaymentLedgerEngine.releaseEscrowFunds(firestoreDb, {
        jobId,
        quoteId,
        milestoneId,
        authUid,
        idempotencyKey,
        isQrHandshake: Boolean(isQrHandshake),
        handshakeCode: typeof handshakeCode === "string" ? handshakeCode : undefined,
        isAdmin: await checkIsAdmin(authUser)
      });

      // Execute Stripe side-effects
      const stripeTransferResult = await PaymentLedgerEngine.executeStripeEscrowTransfer(
        firestoreDb,
        {
          jobId,
          quoteId,
          milestoneId: result.milestoneId || milestoneId,
          idempotencyKey,
          traderId: result.traderId,
          netPayoutPence: result.netPayoutPence,
          ledgerEntryId: result.ledgerEntryId,
          targetMilestoneTitle: result.targetMilestoneTitle,
          jobNo: result.jobNo,
          stripePaymentIntentId: result.stripePaymentIntentId,
          isDestinationCharge: result.isDestinationCharge,
        },
        { stripe: stripeClient }
      );

      // A Stripe API error can be ambiguous: the transfer may have been created even if
      // the response was lost. Keep the milestone's original operation key and released
      // state locked for reconciliation; a new caller key must not create a second transfer.
      if (stripeTransferResult.transferStatus === "reconciliation_required") {
        await firestoreDb.runTransaction(async (tx: any) => {
          const qRef = firestoreDb.collection("jobs").doc(jobId).collection("quotes").doc(quoteId);
          const qSnap = await tx.get(qRef);
          if (!qSnap.exists) return;
          const qData = qSnap.data();
          const milestones = (qData?.milestones || []).map((m: any) => {
            if (m.id !== (result.milestoneId || milestoneId) || m.releaseOperationId !== idempotencyKey) return m;
            return {
              ...m,
              status: "funds_released",
              releaseStatus: "reconciliation_required",
              lastTransferError: stripeTransferResult.error,
            };
          });
          tx.update(qRef, { milestones });
        });

        return res.status(502).json({
          success: false,
          error: "Stripe transfer outcome is ambiguous. The milestone remains locked to its original operation key pending reconciliation; do not retry with a new idempotency key.",
          stripeTransferStatus: "reconciliation_required",
          stripeError: stripeTransferResult.error,
        });
      }

      // A preflight failure is known to have occurred before the Stripe transfer call.
      // Only this definite-no-transfer case may safely restore the milestone to funded.
      if (stripeTransferResult.transferStatus === "failed") {
        await firestoreDb.runTransaction(async (tx: any) => {
          const qRef = firestoreDb.collection("jobs").doc(jobId).collection("quotes").doc(quoteId);
          const qSnap = await tx.get(qRef);
          if (qSnap.exists) {
            const qData = qSnap.data();
            let matchedCurrentOperation = false;
            const milestones = (qData?.milestones || []).map((m: any) => {
              if (m.id !== (result.milestoneId || milestoneId) || m.releaseOperationId !== idempotencyKey) {
                return m;
              }
              matchedCurrentOperation = true;
              return {
                ...m,
                status: "funded",
                releaseStatus: "failed",
                lastTransferError: stripeTransferResult.error,
                releaseOperationId: null,
              };
            });
            if (matchedCurrentOperation) {
              tx.update(qRef, { milestones });
              // The job-level payment fields aggregate multiple milestones/quotes.
              // Leave that projection to the canonical reconciler rather than marking
              // the entire job funded because one milestone release failed.
            }
          }
        });

        // Also update ledger
        const ledgerSnap = await firestoreDb
          .collection("payment_ledger")
          .where("idempotencyKey", "==", idempotencyKey)
          .get();
        if (!ledgerSnap.empty) {
          await ledgerSnap.docs[0].ref.update({
            status: "failed",
            transferStatus: "failed",
            transferError: stripeTransferResult.error,
          });
        }

        // Release stale completed idempotency lock on definite preflight failure so clean retry works
        await PaymentLedgerEngine.releaseFailedPreflightIdempotencyLock(firestoreDb, idempotencyKey).catch(() => {});

        return res.status(502).json({
          success: false,
          error: `Stripe escrow transfer failed: ${stripeTransferResult.error}. Milestone remains funded and can be retried.`,
          stripeTransferStatus: "failed",
          stripeError: stripeTransferResult.error,
        });
      }

      // Reconcile parent job aggregate paymentStatus & isPaid (+ official invoice) after transfer confirmation
      const jobPaymentProjection = await PaymentLedgerEngine.reconcileJobPaymentStatus(firestoreDb, {
        jobId,
        quoteId,
        isQrHandshake: Boolean(isQrHandshake),
      }).catch(() => ({
        allMilestonesReleased: false,
        anyMilestoneReleased: true,
        paymentStatus: null,
        isPaid: false,
      }));

      // Notify Trader (outside transaction) with status-aware notification messaging
      if (result.traderId) {
        const notif = PaymentLedgerEngine.formatReleaseNotification({
          transferStatus: stripeTransferResult.transferStatus,
          isQrHandshake: Boolean(isQrHandshake),
          jobNo: result.jobNo,
          targetMilestoneTitle: result.targetMilestoneTitle,
        });

        await firestoreDb.collection("notifications").add({
          userId: result.traderId,
          title: notif.title,
          message: notif.message,
          type: "status",
          link: `/job/${jobId}`,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        }).catch(() => {});
      }

      res.json({
        ...result,
        stripeTransferStatus: stripeTransferResult.transferStatus,
        stripeTransferId: stripeTransferResult.stripeTransferId,
        stripeError: stripeTransferResult.error,
        jobPaymentStatus: jobPaymentProjection.paymentStatus,
        jobIsPaid: jobPaymentProjection.isPaid,
      });
    } catch (error: any) {
      console.error("Milestone Release Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Milestone Work Submission & Homeowner Review / Approval Workflow (AT-CJ-MILESTONE-01)
  app.post("/api/milestones/submit-work", requireAuth, generalLimiter, async (req, res) => {
    try {
      const authUser = (req as any).user;
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const { jobId, quoteId, milestoneId, deliverableNotes, deliverablePhotos } = req.body || {};
      const result = await PaymentLedgerEngine.submitMilestoneWork(db, {
        jobId,
        quoteId,
        milestoneId,
        authUid: authUser.uid,
        deliverableNotes,
        deliverablePhotos,
      });
      return res.json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  app.post("/api/milestones/review-work", requireAuth, generalLimiter, async (req, res) => {
    try {
      const authUser = (req as any).user;
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const { jobId, quoteId, milestoneId, decision, revisionReason } = req.body || {};
      const isAdmin = await checkIsAdmin(authUser);
      const result = await PaymentLedgerEngine.reviewMilestoneWork(db, {
        jobId,
        quoteId,
        milestoneId,
        authUid: authUser.uid,
        decision,
        revisionReason,
        isAdmin,
      });
      return res.json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Review Submission & Rating Aggregation (PL-01 & Task 4.4 Hardened)
  app.post("/api/reviews/submit", requireAuth, reviewLimiter, async (req, res) => {
    try {
      const reviewerId = (req as any).user.uid;
      const {
        jobId,
        revieweeId,
        rating,
        comment = "",
        recommended = true,
      } = req.body;
      const type: ReviewType =
        req.body?.type === "homeowner_review" ? "homeowner_review" : "tradesperson_review";

      if (!db) {
        return res.status(503).json({
          error: "Database not initialized on server",
          fallbackToClient: true
        });
      }
      const firestoreDb = db;
      if (!jobId || !revieweeId) throw new BadRequestError("Job ID and Reviewee ID are required");

      if (reviewerId === revieweeId) {
        throw new BadRequestError("Self-reviews are strictly forbidden.");
      }

      const numRating = Number(rating);
      if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
        throw new BadRequestError("Rating must be a whole number from 1 to 5.");
      }

      const isLowRating = numRating <= 2 && type === "tradesperson_review";
      const status = isLowRating ? "cooling_off" : "published";
      const publishAt = isLowRating
        ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) // 14-day cooling-off
        : new Date();

      // Deterministic document ID ensures one review per job per direction enforced atomically
      const reviewDocId = `${jobId}_${type}`;
      const reviewRef = firestoreDb.collection("reviews").doc(reviewDocId);
      const jobRef = firestoreDb.collection("jobs").doc(jobId);
      const userRef = firestoreDb.collection("users").doc(revieweeId);
      const publicProfileRef = firestoreDb.collection("public_profiles").doc(revieweeId);

      await firestoreDb.runTransaction(async (transaction) => {
        const [jobDoc, existingReviewDoc, userDoc, publicProfileDoc] = await Promise.all([
          transaction.get(jobRef),
          transaction.get(reviewRef),
          transaction.get(userRef),
          transaction.get(publicProfileRef),
        ]);

        if (!jobDoc.exists) throw new NotFoundError(`Job ${jobId} not found`);
        const jobData = jobDoc.data() || {};

        // Authoritative validation: counterparty engagement, ownership, and job status == 'completed'
        assertCanReview(jobData, reviewerId, revieweeId, type);

        if (existingReviewDoc.exists) {
          throw new ConflictError("This job has already been reviewed.");
        }

        // 1. Write the review document
        transaction.set(reviewRef, {
          id: reviewRef.id,
          jobId,
          reviewerId,
          revieweeId,
          type,
          rating: numRating,
          comment: String(comment).slice(0, 2000),
          recommended: type === "tradesperson_review" ? Boolean(recommended) : false,
          status,
          publishAt: admin.firestore.Timestamp.fromDate(publishAt),
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // 2. Update user profile & public_profiles aggregates atomically (only if not in cooling off period)
        if (!isLowRating && userDoc.exists) {
          const userData = userDoc.data();
          const nowIso = new Date().toISOString();
          if (type === "tradesperson_review") {
            const currentRating = Number(userData?.rating) || 0;
            const currentTotalReviews = Number(userData?.totalReviews) || 0;
            const currentTotalRecommendations = Number(userData?.totalRecommendations) || 0;

            const newTotalReviews = currentTotalReviews + 1;
            const newRating = Number((((currentRating * currentTotalReviews) + numRating) / newTotalReviews).toFixed(2));
            const newTotalRecommendations = recommended ? currentTotalRecommendations + 1 : currentTotalRecommendations;

            const ratingPatch = {
              rating: newRating,
              totalReviews: newTotalReviews,
              totalRecommendations: newTotalRecommendations,
              updatedAt: nowIso,
            };
            transaction.update(userRef, ratingPatch);
            if (publicProfileDoc.exists) {
              transaction.update(publicProfileRef, ratingPatch);
            }
          } else {
            const currentRating = Number(userData?.homeownerRating) || 0;
            const currentTotalReviews = Number(userData?.totalHomeownerReviews) || 0;

            const newTotalReviews = currentTotalReviews + 1;
            const newRating = Number((((currentRating * currentTotalReviews) + numRating) / newTotalReviews).toFixed(2));

            const homeownerPatch = {
              homeownerRating: newRating,
              totalHomeownerReviews: newTotalReviews,
              updatedAt: nowIso,
            };
            transaction.update(userRef, homeownerPatch);
            if (publicProfileDoc.exists) {
              transaction.update(publicProfileRef, homeownerPatch);
            }
          }
        }

        // 3. Mark job review indicator (Do not alter status; completion is managed strictly by /api/jobs/:id/complete)
        if (type === "tradesperson_review") {
          transaction.update(jobRef, {
            hasReview: true,
            hasHomeownerReview: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        } else {
          transaction.update(jobRef, {
            hasTradespersonReview: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }

        // 4. Write reviewee notification atomically inside the same transaction (AT-CJ-REVIEW-04)
        const reviewNotifRef = firestoreDb.collection("notifications").doc(`review_${reviewDocId}_${revieweeId}`);
        if (isLowRating) {
          const delayDays = 3 + Math.floor(Math.random() * 5);
          const visibleAt = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000);
          transaction.set(reviewNotifRef, {
            userId: revieweeId,
            title: "Trust & Fairness Update",
            message: "The Trust & Fairness engine is conducting a standard quality review of a recent interaction. This process ensures platform balance and takes 14 days.",
            type: "system",
            read: false,
            visibleAt: admin.firestore.Timestamp.fromDate(visibleAt),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            link: `/job/${jobId}`
          });
        } else {
          transaction.set(reviewNotifRef, {
            userId: revieweeId,
            title: "New Review Received! ⭐",
            message: `You received a ${numRating}-star review for your recent job.`,
            type: "system",
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            link: `/job/${jobId}`
          });
        }
      });

      // Non-fatal post-commit domain event dispatch so committed reviews never trigger API failure
      try {
        await domainEvents.dispatch("REVIEW_SUBMITTED", reviewRef.id, reviewerId, {
          jobId,
          revieweeId,
          rating: numRating,
          isLowRating
        }, reviewRef.id, firestoreDb);
      } catch (eventErr) {
        console.warn("[/api/reviews/submit] Non-fatal post-commit domain event notice:", eventErr);
      }

      res.json({
        success: true,
        reviewId: reviewRef.id,
        isLowRating,
        status
      });
    } catch (error: any) {
      if (
        error?.code === 7 ||
        String(error?.message || error).includes("PERMISSION_DENIED") ||
        String(error?.message || error).includes("Missing or insufficient permissions")
      ) {
        console.warn("[/api/reviews/submit] Server-side Admin SDK lacks database permission in sandbox. Signaling client-side fallback.");
        return res.status(503).json({
          error: "Server database permissions unavailable in this environment",
          fallbackToClient: true
        });
      }
      console.error("Review Submission Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Account Profile Initialization (PL-02 Hardened)
  app.post("/api/account/bootstrap-profile", requireAuth, paymentLimiter, async (req, res) => {
    try {
      const caller = (req as any).user;
      const clientIp = req.ip || req.socket.remoteAddress;

      if (!db) {
        const parseResult = bootstrapProfileSchema.safeParse(req.body);
        if (!parseResult.success) {
          throw new BadRequestError(`Invalid profile payload: ${parseResult.error.message}`);
        }
        return res.status(200).json({
          success: true,
          uid: caller.uid,
          fallbackToClient: true,
          message: "Server database connection uninitialized. Client authorized to persist profile."
        });
      }

      const result = await executeBootstrapProfileCommand(db, caller, req.body, clientIp);
      res.status(201).json(result);
    } catch (error: any) {
      if (
        error?.code === 7 ||
        error?.message?.includes("PERMISSION_DENIED") ||
        error?.message?.includes("Missing or insufficient permissions")
      ) {
        console.warn("[/api/account/bootstrap-profile] Server Firestore access restricted. Authorizing client SDK persistence:", error.message);
        return res.status(200).json({
          success: true,
          uid: (req as any).user?.uid,
          fallbackToClient: true,
          message: "Server database connection restricted. Client authorized to persist profile."
        });
      }
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Homeowner -> Dual-Role Tradesperson Self-Service Upgrade (Task 8)
  app.post("/api/account/upgrade-to-trader", requireAuth, paymentLimiter, async (req, res) => {
    try {
      const caller = (req as any).user;
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable. Please try again shortly." });
      }
      const result = await executeUpgradeHomeownerToTraderCommand(db, caller, req.body);
      res.status(200).json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative UK GDPR Data Portability Export (Task 11)
  app.post("/api/account/gdpr/export", requireAuth, paymentLimiter, async (req, res) => {
    try {
      const caller = (req as any).user;
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable. Please try again shortly." });
      }
      const exportPayload = await executeExportUserDataCommand({
        db,
        uid: caller.uid,
      });
      res.status(200).json(exportPayload);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative UK GDPR Self-Service Account Deletion (Task 11)
  app.post("/api/account/gdpr/delete-account", requireAuth, paymentLimiter, async (req, res) => {
    try {
      const caller = (req as any).user;
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable. Please try again shortly." });
      }
      let authClient: any = null;
      try {
        authClient = admin.auth();
      } catch {
        authClient = null;
      }
      const result = await executeSelfServiceAccountDeletionCommand({
        db,
        authClient,
        uid: caller.uid,
        email: caller.email,
        confirmationText: req.body?.confirmationText,
        reason: req.body?.reason,
      });
      res.status(200).json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Slice 1 P0 #1: Server-Authoritative Platform Terms & Privacy Acceptance
  app.post("/api/account/accept-terms", requireAuth, paymentLimiter, async (req, res) => {
    try {
      const caller = (req as any).user;
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable. Please try again shortly." });
      }
      const forwarded = req.headers["x-forwarded-for"];
      const clientIp = Array.isArray(forwarded)
        ? forwarded[0]
        : typeof forwarded === "string"
        ? forwarded.split(",")[0].trim()
        : req.ip || "unknown";
      const result = await executeAcceptTermsCommand({
        db,
        caller,
        rawInput: req.body,
        clientIp,
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "Web",
      });
      res.status(200).json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Slice 1 P1 #8: Server-Authoritative Verification Document Expiry & 30-Day Warning Sync
  app.post("/api/account/sync-expired-docs", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable." });
      }
      const result = await executeSyncExpiredVerificationDocsCommand({
        db,
        caller,
      });
      res.status(200).json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Slice 1 P1 #9: Server-Authoritative Video Verification Removal (Private + Public Profile)
  app.post("/api/account/remove-video-verification", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable." });
      }
      const result = await executeRemoveVideoVerificationCommand({
        db,
        caller,
      });
      res.status(200).json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Slice 1 P0 #4: Server-Authoritative Business Team Management Endpoints
  app.get("/api/business/team", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable." });
      }
      const result = await executeListBusinessTeamCommand({ db, caller });
      res.status(200).json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  app.post("/api/business/team/invite", requireAuth, paymentLimiter, async (req, res) => {
    try {
      const caller = (req as any).user;
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable." });
      }
      const result = await executeSendBusinessTeamInviteCommand({
        db,
        caller,
        email: req.body?.email,
        appOrigin: getAuthoritativeAppUrl(),
      });
      res.status(201).json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  app.delete("/api/business/team/invitations/:invitationId", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable." });
      }
      const result = await executeRevokeBusinessTeamInviteCommand({
        db,
        caller,
        invitationId: req.params.invitationId,
      });
      res.status(200).json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  app.post("/api/business/team/invitations/:invitationId/accept", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable." });
      }
      const result = await executeAcceptBusinessTeamInviteCommand({
        db,
        caller,
        invitationId: req.params.invitationId,
        token: req.body?.token,
      });
      res.status(200).json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  app.delete("/api/business/team/members/:memberUid", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      if (!db) {
        return res.status(503).json({ error: "Database service unavailable." });
      }
      const result = await executeRemoveBusinessTeamMemberCommand({
        db,
        caller,
        memberUid: req.params.memberUid,
      });
      res.status(200).json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Quote Acceptance Route (Task 4 Single Canonical Authority)
  app.post("/api/jobs/:jobId/accept-quote", requireAuth, async (req, res) => {
    try {
      const { jobId } = req.params;
      if (!db) throw new BadRequestError("Database not initialized");

      const identity = await resolveTrustedCanonicalIdentity(req as any, async (uid) => {
        const profileSnap = await db!.collection("users").doc(uid).get();
        return profileSnap.exists ? (profileSnap.data() || null) : null;
      });

      const rawPayload = { ...(req.body || {}) };
      const idempotencyKey =
        (req.headers["x-idempotency-key"] as string) ||
        (req.headers["idempotency-key"] as string) ||
        rawPayload.idempotencyKey ||
        "";
      delete rawPayload.idempotencyKey;

      const quoteId = rawPayload.quoteId;

      const result = await executeAcceptQuoteCommand({
        db,
        identity,
        jobId,
        quoteId,
        rawPayload,
        idempotencyKey,
        messagingClient: getFirebaseMessagingClient(),
      });

      res.status(result.wasReplayed ? 200 : 200).json({
        success: true,
        jobId: result.jobId,
        quoteId: result.quoteId,
        status: result.status,
        acceptedTradespersonId: result.acceptedTradespersonId,
        scheduledDate: result.scheduledDate,
        verificationPin: result.verificationPin,
        isConfirmedByTradesperson: result.isConfirmedByTradesperson,
        wasReplayed: result.wasReplayed,
      });
    } catch (error: any) {
      console.error("Quote Acceptance Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Canonical Job Lifecycle Routes (Task 5)
  const handleJobLifecycleRoute = (commandType: "StartJob" | "CompleteJob" | "CancelJob" | "RaiseJobDispute") => {
    return async (req: express.Request, res: express.Response) => {
      try {
        const { jobId } = req.params;
        if (!db) throw new BadRequestError("Database service is not initialized");

        const identity = await resolveTrustedCanonicalIdentity(req as any, async (uid) => {
          const profileSnap = await db!.collection("users").doc(uid).get();
          return profileSnap.exists ? (profileSnap.data() || null) : null;
        });

        const rawPayload = { ...(req.body || {}) };
        const idempotencyKey =
          (req.headers["x-idempotency-key"] as string) ||
          (req.headers["idempotency-key"] as string) ||
          rawPayload.idempotencyKey ||
          "";
        delete rawPayload.idempotencyKey;

        const result = await executeJobLifecycleCommand({
          db,
          identity,
          command: {
            type: commandType,
            payload: {
              ...rawPayload,
              jobId,
            },
          },
          idempotencyKey: idempotencyKey || `job_${commandType.toLowerCase()}_${jobId}_${identity.uid}`,
          strictTraderProfileRequired: commandType === "StartJob",
          stripe: commandType === "CancelJob" ? getOptionalStripeClient() : undefined,
          messagingClient: getFirebaseMessagingClient(),
        });

        res.status(200).json({
          success: true,
          commandType: result.commandType,
          jobId: result.jobId,
          status: result.status,
          job: result.job,
          wasReplayed: result.wasReplayed,
        });
      } catch (error: any) {
        console.error(`Job Lifecycle Command '${commandType}' Error:`, error);
        sendHttpError(res, error, req);
      }
    };
  };

  app.post("/api/jobs/:jobId/start", requireAuth, handleJobLifecycleRoute("StartJob"));
  app.post("/api/jobs/:jobId/complete", requireAuth, handleJobLifecycleRoute("CompleteJob"));
  app.post("/api/jobs/:jobId/cancel", requireAuth, handleJobLifecycleRoute("CancelJob"));
  app.post("/api/jobs/:jobId/dispute", requireAuth, handleJobLifecycleRoute("RaiseJobDispute"));

  // Server-Authoritative Job Edit with Atomic Public Card Projection Sync (AT-CJ-JOB-07)
  app.post("/api/jobs/:jobId/update", requireAuth, generalLimiter, async (req, res) => {
    try {
      const { jobId } = req.params;
      if (!db) return res.status(503).json({ error: "Database service unavailable" });

      const identity = await resolveTrustedCanonicalIdentity(req as any, async (uid) => {
        const profileSnap = await db!.collection("users").doc(uid).get();
        return profileSnap.exists ? (profileSnap.data() || null) : null;
      });

      const result = await executeUpdateJobCommand({
        db,
        identity,
        jobId,
        rawPayload: req.body || {},
      });

      return res.json({
        success: true,
        ...result,
      });
    } catch (error: any) {
      console.error("Job Update Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Job Delete / Archive with Atomic Public Card Cleanup (Slice 3)
  app.post("/api/jobs/:jobId/delete", requireAuth, generalLimiter, async (req, res) => {
    try {
      const { jobId } = req.params;
      if (!db) return res.status(503).json({ error: "Database service unavailable" });

      const identity = await resolveTrustedCanonicalIdentity(req as any, async (uid) => {
        const profileSnap = await db!.collection("users").doc(uid).get();
        return profileSnap.exists ? (profileSnap.data() || null) : null;
      });

      const mode = req.body?.mode === "archive" ? "archive" : "delete";
      const result = await executeDeleteJobCommand({
        db,
        identity,
        jobId,
        mode,
      });

      return res.json({
        success: true,
        ...result,
      });
    } catch (error: any) {
      console.error("Job Delete/Archive Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Job Scheduling & Reschedule with Atomic Trader Calendar Sync (Slice 3)
  app.post("/api/jobs/:jobId/schedule-action", requireAuth, generalLimiter, async (req, res) => {
    try {
      const { jobId } = req.params;
      if (!db) return res.status(503).json({ error: "Database service unavailable" });

      const identity = await resolveTrustedCanonicalIdentity(req as any, async (uid) => {
        const profileSnap = await db!.collection("users").doc(uid).get();
        return profileSnap.exists ? (profileSnap.data() || null) : null;
      });

      const result = await executeJobScheduleActionCommand({
        db,
        identity,
        jobId,
        action: req.body?.action,
        proposedDate: req.body?.proposedDate,
        reason: req.body?.reason,
        messagingClient: getFirebaseMessagingClient(),
      });

      return res.json(result);
    } catch (error: any) {
      console.error("Job Schedule Action Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Canonical CreateJob Command Route (Task 2)
  app.post("/api/jobs/create", requireAuth, async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database service is not initialized");

      let trustedProfile: Record<string, any> | null = null;
      const identity = await resolveTrustedCanonicalIdentity(req as any, async (uid) => {
        const profileSnap = await db!.collection("users").doc(uid).get();
        trustedProfile = profileSnap.exists ? (profileSnap.data() || null) : null;
        return trustedProfile;
      });

      const platformConfig = await getCachedConfig("global");
      const globalTiers = await getCachedConfig("global_tiers");

      const rawPayload = { ...(req.body || {}) };
      // Accept idempotency key from header or extract from body before validation
      const idempotencyKey =
        (req.headers["x-idempotency-key"] as string) ||
        (req.headers["idempotency-key"] as string) ||
        rawPayload.idempotencyKey ||
        "";
      delete rawPayload.idempotencyKey;

      const quota = resolveCreateJobQuota(trustedProfile, platformConfig, globalTiers);

      const result = await executeCreateJobCommand({
        db,
        identity,
        rawPayload,
        idempotencyKey,
        quota,
      });

      // Server-side automatic Wave 1 lead distribution on freshly created jobs
      // (idempotent with client POST /api/jobs/:id/distribute-leads so recurring/BOM/tab-close jobs are never missed)
      if (!result.wasReplayed && db) {
        const messagingClient = getFirebaseMessagingClient();
        void distributeJobLeadsAuthoritative({
          db,
          jobId: result.jobId,
          jobData: result.job,
          callerUid: identity.uid,
          maxRecipients: 25,
          wave: 1,
          dispatchFcmPush: (payload) => dispatchAuthoritativeFcmPush(db!, messagingClient, payload),
        }).catch((err) => {
          console.warn(`[AutoLeadDistribution] Non-blocking dispatch failed for job ${result.jobId}:`, err);
        });
      }

      res.status(result.wasReplayed ? 200 : 201).json({
        success: true,
        jobId: result.jobId,
        status: result.job.status,
        job: result.job,
        wasReplayed: result.wasReplayed,
      });
    } catch (error: any) {
      console.error("Server Job Creation Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Canonical Quote Commands Route (Task 3)
  app.post("/api/quotes/command", requireAuth, async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database service is not initialized");

      let trustedProfile: Record<string, any> | null = null;
      const identity = await resolveTrustedCanonicalIdentity(req as any, async (uid) => {
        const profileSnap = await db!.collection("users").doc(uid).get();
        trustedProfile = profileSnap.exists ? (profileSnap.data() || null) : null;
        return trustedProfile;
      });

      const rawBody = { ...(req.body || {}) };
      const commandType = rawBody.type;
      const rawPayload = rawBody.payload || {};

      if (!commandType) {
        throw new BadRequestError("Quote command 'type' is required (e.g. 'CreateQuote', 'UpdateQuote', 'WithdrawQuote', 'RejectQuote', 'RequestRequote', 'RespondToRequote').");
      }

      // Extract idempotency key from headers or payload
      const idempotencyKey =
        (req.headers["x-idempotency-key"] as string) ||
        (req.headers["idempotency-key"] as string) ||
        rawBody.idempotencyKey ||
        rawPayload.idempotencyKey ||
        "";

      delete rawPayload.idempotencyKey;
      delete rawBody.idempotencyKey;

      const trimmedIdempotencyKey = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
      if (!trimmedIdempotencyKey || trimmedIdempotencyKey.length < 8 || trimmedIdempotencyKey.length > 200) {
        throw new BadRequestError("Idempotency key is required and must be between 8 and 200 characters.");
      }

      const result = await executeQuoteCommand({
        db,
        identity,
        command: {
          type: commandType,
          payload: rawPayload,
        },
        idempotencyKey: trimmedIdempotencyKey,
        messagingClient: getFirebaseMessagingClient(),
      });

      res.status(result.wasReplayed ? 200 : (commandType === "CreateQuote" ? 201 : 200)).json({
        success: true,
        commandType: result.commandType,
        quoteId: result.quoteId,
        jobId: result.jobId,
        status: result.status,
        quote: result.quote,
        wasReplayed: result.wasReplayed,
      });
    } catch (error: any) {
      console.error("Quote Command Execution Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Trader Invitation on Existing Open Job (Stage 1B)
  app.post("/api/jobs/:jobId/invite-trader", requireAuth, async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database service is not initialized");
      const identity = await resolveTrustedCanonicalIdentity(req as any, async (uid) => {
        const profileSnap = await db!.collection("users").doc(uid).get();
        return profileSnap.exists ? (profileSnap.data() || null) : null;
      });
      const result = await executeInviteTraderToJobCommand({
        db,
        identity,
        jobId: req.params.jobId,
        traderId: req.body?.traderId,
      });
      res.status(200).json(result);
    } catch (error: any) {
      console.error("Invite Trader Command Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative BOM Material Order Placement (Stage 1B)
  app.post("/api/bom/orders", requireAuth, async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database service is not initialized");
      const identity = await resolveTrustedCanonicalIdentity(req as any, async (uid) => {
        const profileSnap = await db!.collection("users").doc(uid).get();
        return profileSnap.exists ? (profileSnap.data() || null) : null;
      });
      const orderRecord = await executeCreateBomOrderCommand({
        db,
        identity,
        payload: req.body,
      });
      res.status(201).json({ success: true, order: orderRecord });
    } catch (error: any) {
      console.error("BOM Order Creation Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Recurring Job & Accepted Quote Generation (Stage 1B)
  app.post("/api/recurring-schedules/:scheduleId/generate-job", requireAuth, async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database service is not initialized");
      const identity = await resolveTrustedCanonicalIdentity(req as any, async (uid) => {
        const profileSnap = await db!.collection("users").doc(uid).get();
        return profileSnap.exists ? (profileSnap.data() || null) : null;
      });
      const result = await executeGenerateRecurringJobCommand({
        db,
        identity,
        scheduleId: req.params.scheduleId,
      });
      res.status(result.generated && !result.wasReplayed ? 201 : 200).json(result);
    } catch (error: any) {
      console.error("Recurring Job Generation Error:", error);
      sendHttpError(res, error, req);
    }
  });

  // Check job posting limit
  app.post("/api/check-job-limit", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user.uid; // Strictly derive from authenticated token
      const { isEmergency, requestedCount = 1 } = req.body;
      if (!db) return res.json({ allowed: true, count: 0, limit: Infinity, isEmergency: !!isEmergency, warning: "Database backend disabled in sandbox" });

      // Emergency jobs don't count towards the limit
      if (isEmergency) {
        return res.json({ allowed: true, count: 0, limit: Infinity, isEmergency: true });
      }

      const userDoc = await db.collection("users").doc(userId).get();
      if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

      const userData = userDoc.data();
      const isBusiness = userData?.subscriptionType === "business";
      const hasActiveSubscription = userData?.subscriptionId && userData?.subscriptionStatus === "active";
      
      // Default tier if not subscribed
      const defaultBusinessTier = { name: "Trial", jobPostsLimit: 10, limitPeriod: "lifetime" };
      const tierId = userData?.tierId || (isBusiness ? "Business Basic" : "Basic");
      
      // Platform Configuration
      const platformConfig = await getCachedConfig("global");
      const globalTiers = await getCachedConfig("global_tiers");
      
      if (platformConfig?.paywallEnabled === false) {
        return res.json({ allowed: true, count: 0, limit: Infinity, betaMode: true });
      }

      let tier;
      let limit = 0;

      if (globalTiers && userData?.subscription?.providerModel) {
        const model = userData.subscription.providerModel;
        const tierId = userData.subscription.tierId || "basic";
        const tierConfig = globalTiers.providerModels?.[model]?.tiers?.[tierId];
        
        if (tierConfig) {
          tier = { 
            name: tierId, 
            jobPostsLimit: tierConfig.maxQuotes,
            limitPeriod: "monthly" // Simplified to monthly for now
          };
          limit = tier.jobPostsLimit;
        }
      }

      // Legacy fallback
      if (!tier) {
        const tierId = userData?.tierId || (isBusiness ? "Business Basic" : "Basic");
        if (isBusiness) {
          if (!hasActiveSubscription) {
            tier = defaultBusinessTier;
          } else {
            tier = platformConfig?.businessTiers?.find((t: any) => t.name === tierId);
          }
        } else {
          tier = platformConfig?.feeTiers?.find((t: any) => t.name === tierId);
        }
        limit = tier?.jobPostsLimit || Infinity;
      }
      
      if (!tier) return res.json({ allowed: true });

      const isLifetime = tier.limitPeriod === "lifetime";
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      let jobsQuery = db.collection("jobs")
        .where("homeownerId", "==", userId)
        .where("urgency", "!=", "emergency");
      
      if (!isLifetime) {
        jobsQuery = jobsQuery.where("createdAt", ">=", admin.firestore.Timestamp.fromDate(startOfMonth));
      }

      const jobsSnapshot = await jobsQuery.get();
      const jobCount = jobsSnapshot.size;
      
      // Check if the requested number of posts is allowed
      const isAllowed = (jobCount + requestedCount) <= tier.jobPostsLimit;

      // Check for duplicate accounts based on deviceId
      let securityAlert: string | null = null;
      let suggestedStatus = "posted";
      
      if (userData?.deviceId && db) {
        const duplicateUsers = await db.collection("users").where("deviceId", "==", userData.deviceId).get();
        if (duplicateUsers.size > 1) {
          securityAlert = "Potential duplicate account detected (same device)";
          suggestedStatus = "pending_admin_review";
          
          // Log security alert
          await db.collection("security_alerts").add({
            userId,
            type: "duplicate_account",
            message: `User ${userId} shared device ID with ${duplicateUsers.size - 1} other accounts.`,
            deviceId: userData.deviceId,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      }

      res.json({ 
        allowed: isAllowed, 
        count: jobCount, 
        limit: tier.jobPostsLimit,
        isTrial: isBusiness && !hasActiveSubscription,
        securityAlert,
        suggestedStatus
      });
    } catch (error: any) {
      console.error("Job Limit Check Error:", error);
      res.status(500).json({ error: error.message || "Failed to check job limit" });
    }
  });

  // Check quote limit for tradespeople
  app.post("/api/check-quote-limit", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user.uid; // Strictly derive from authenticated token
      const { jobId } = req.body;
      if (!db) return res.json({ allowed: true, warning: "Database backend disabled in sandbox" });

      const userDoc = await db.collection("users").doc(userId).get();
      let userData: any = {};
      if (userDoc.exists) {
        userData = userDoc.data() || {};
      }
      const platformConfig = await getCachedConfig("global");
      const globalTiers = await getCachedConfig("global_tiers");
      
      // 1. Check Exclusive Job Constraints First
      let isJobExclusive = false;
      if (jobId && platformConfig?.paywallEnabled !== false) {
        const jobDoc = await db.collection("jobs").doc(jobId).get();
        if (jobDoc.exists) {
          const jobData = jobDoc.data() || {};
          const exclusiveUntil = jobData.exclusiveUntil?.toDate ? jobData.exclusiveUntil.toDate() : (jobData.exclusiveUntil ? new Date(jobData.exclusiveUntil) : null);
          
          if (exclusiveUntil && exclusiveUntil > new Date()) {
            isJobExclusive = true;
            
            if (!userData.hasExclusiveAddon) {
              return res.json({ allowed: false, error: "This job is currently exclusive to Fast Pass members. Please wait or upgrade." });
            }

            // Check if midnight reset is needed
            const lastQuoteDate = userData.lastExclusiveQuoteDate?.toDate ? userData.lastExclusiveQuoteDate.toDate() : (userData.lastExclusiveQuoteDate ? new Date(userData.lastExclusiveQuoteDate) : new Date(0));
            const today = new Date();
            const isSameDay = lastQuoteDate.getDate() === today.getDate() && lastQuoteDate.getMonth() === today.getMonth() && lastQuoteDate.getFullYear() === today.getFullYear();
            
            const usedToday = isSameDay ? (userData.exclusiveSlotsUsedToday || 0) : 0;
            if (usedToday >= 3) {
              return res.json({ allowed: false, error: "You have used your 3 exclusive quotes for today. You can quote on this job when it goes public." });
            }

            const cooldownUntil = userData.exclusiveCooldownUntil?.toDate ? userData.exclusiveCooldownUntil.toDate() : (userData.exclusiveCooldownUntil ? new Date(userData.exclusiveCooldownUntil) : new Date(0));
            if (cooldownUntil > new Date()) {
              return res.json({ allowed: false, error: "You must wait 2 hours between exclusive quotes to ensure fairness. You can quote on this job when it goes public." });
            }
          }
        }
      }

      // 2. Determine Tier and Limit
      if (platformConfig?.paywallEnabled === false) {
        return res.json({ allowed: true, count: 0, limit: Infinity, betaMode: true, isJobExclusive });
      }

      const subStatus = String(userData.subscriptionStatus || "").trim().toLowerCase();
      const isTerminalInactive = ["canceled", "cancelled", "unpaid", "incomplete_expired", "free"].includes(subStatus);
      const normalizedTier = isTerminalInactive
        ? "payg"
        : normalizeTraderTier(String(userData.tier || userData.tierId || "payg"));

      let tier: { name: string; maxQuotes?: number; limitPeriod?: string } | undefined;
      let limitValue = Infinity;

      const canonicalTierConfig = globalTiers?.providerModels?.one_off_trades?.tiers?.[normalizedTier];
      if (canonicalTierConfig && typeof canonicalTierConfig.maxQuotes === "number") {
        tier = {
          name: normalizedTier,
          maxQuotes: canonicalTierConfig.maxQuotes,
          limitPeriod: "monthly",
        };
        limitValue = canonicalTierConfig.maxQuotes;
      } else if (Array.isArray(platformConfig?.feeTiers)) {
        const matched = platformConfig.feeTiers.find(
          (t: any) => normalizeTraderTier(t?.name) === normalizedTier
        );
        if (matched && typeof matched.maxQuotes === "number") {
          tier = matched;
          limitValue = matched.maxQuotes;
        }
      }

      if (!tier || !Number.isFinite(limitValue) || limitValue <= 0) {
        return res.json({ allowed: true, tier: normalizedTier, isJobExclusive });
      }

      const isLifetime = tier.limitPeriod === "lifetime";
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      const sinceTimestamp = admin.firestore.Timestamp.fromDate(isLifetime ? new Date(0) : startOfMonth);

      let count = 0;
      try {
        const groupSnap = await db.collectionGroup("quotes")
          .where("tradespersonId", "==", userId)
          .where("createdAt", ">=", sinceTimestamp)
          .get();
        count = groupSnap.size;
      } catch {
        const legacySnap = await db.collection("quotes")
          .where("tradespersonId", "==", userId)
          .where("createdAt", ">=", sinceTimestamp)
          .get();
        count = legacySnap.size;
      }

      res.json({ allowed: count < limitValue, count, limit: limitValue, tier: normalizedTier, isJobExclusive });
    } catch (error: any) {
      console.error("Quote Limit Check Error:", error);
      res.status(500).json({ error: error.message || "Failed to check quote limit" });
    }
  });

  // Postcode lookup proxy cache
  const postcodeCache = new Map<string, { data: any; expiresAt: number }>();

  // Postcode lookup proxy with rate limiting, strict alphanumeric format validation, 5s fetch timeout, and conditional caching
  app.get("/api/postcode/:postcode", postcodeLimiter, async (req, res) => {
    try {
      const rawPostcode = req.params.postcode || "";
      const formattedPostcode = rawPostcode.toUpperCase().replace(/\s/g, '');

      // Strict validation: UK postcodes are 2-8 alphanumeric characters without spaces
      if (!/^[A-Z0-9]{2,8}$/.test(formattedPostcode)) {
        return res.status(400).json({ error: "Invalid postcode format" });
      }

      const cached = postcodeCache.get(formattedPostcode);
      if (cached && Date.now() < cached.expiresAt) {
        return res.json(cached.data);
      }

      // AT-POSTCODE-01: Single AbortController timeout covering fetch + response.json() body consumption
      const { status: upstreamStatus, ok: upstreamOk, data } = await fetchPostcodeWithTimeout(
        formattedPostcode,
        fetch,
        5000
      );
      const response = { status: upstreamStatus, ok: upstreamOk };
      const isSuccess = response.ok && data && (data.status === 200 || data.result);
      const isNotFound = response.status === 404 || (data && data.status === 404);

      // Prevent memory leaks - enforce a safe 1000-entry peak limit
      if (postcodeCache.size >= 1000) {
        let deleted = false;
        const now = Date.now();
        // Remove individual expired items first
        for (const [k, v] of postcodeCache.entries()) {
          if (now >= v.expiresAt) {
            postcodeCache.delete(k);
            deleted = true;
          }
        }
        // Force-evict the first element if nothing was expired
        if (!deleted) {
          const firstKey = postcodeCache.keys().next().value;
          if (firstKey !== undefined) {
            postcodeCache.delete(firstKey);
          }
        }
      }

      // Cache successful responses for 24h, 404s for 5m, and do not cache errors/server failures
      const cacheDuration = isSuccess ? 24 * 60 * 60 * 1000 : (isNotFound ? 5 * 60 * 1000 : 0);
      if (cacheDuration > 0) {
        postcodeCache.set(formattedPostcode, {
          data,
          expiresAt: Date.now() + cacheDuration
        });
      }

      res.status(response.status).json(data);
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return res.status(504).json({ error: "Postcode lookup timed out" });
      }
      res.status(500).json({ error: "Failed to lookup postcode" });
    }
  });

  // AI Shop SSO Token Route (Server-Authoritative SSO Claims - Task 35-E Hardened)
  app.post("/api/sso-token", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      const secret = process.env.JWT_SECRET;
      
      if (!secret) {
        return res.status(500).json({ error: "SSO secret not configured" });
      }

      const result = await generateAuthoritativeSsoToken(
        db,
        caller,
        secret,
        req.body,
        () => getCachedConfig("global")
      );

      res.json({ token: result.token });
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Authoritative Provider Account-Linking Route (Task 35-E-R3 Cryptographic Trust Chain)
  app.post("/api/account/link-provider", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      const { credential, idToken, providerToken, ...untrustedProviderInput } = req.body || {};
      const providerCredential = credential || idToken || providerToken;

      const result = await executeAuthoritativeAccountLinking({
        db,
        caller,
        providerCredential,
        providerInput: untrustedProviderInput,
        adminAuthInstance: admin.auth(),
      });

      res.json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });


  // AI Shop Analytics Route
  app.post("/api/analytics/profitability", requireAuth, async (req, res) => {
    try {
      const uid = (req as any).user.uid; // Strictly derive from verified token
      if (!uid) return res.status(400).json({ error: "Missing UID" });

      if (!db) {
         return res.status(500).json({ error: "Database not initialized" });
      }

      console.log("Fetching profitability for UID:", uid);
      // Read pre-aggregated data
      const colRef = db.collection("user_profitability_daily");
      console.log("Collection reference:", colRef.path);
      const docRef = colRef.doc(uid);
      console.log("Document reference:", docRef.path);
      
      let doc;
      try {
        doc = await docRef.get();
        console.log("Document fetch successful, exists:", doc.exists);
      } catch (err: any) {
        if (err.code === 5 || err.message?.includes("NOT_FOUND")) {
            console.warn("Analytics document truly not found (expected behavior):", uid);
            doc = { exists: false };
        } else {
            console.error("Unexpected error fetching analytics:", err);
            throw err; // Re-throw if it's not a simple not_found
        }
      }
      if (doc.exists && (doc as any).data) {
        const data = (doc as any).data();
        
        // Fetch user for tier info to calculate pulse
        const userDoc = await db.collection("users").doc(uid).get();
        const userData = userDoc.data() || {};
        const tier = userData.tierId || "Basic";
        
        // Calculate dynamic pulse metrics
        const discountRate = tier === "Gold Elite" ? 0.15 : tier === "Silver Professional" ? 0.10 : 0.05;
        const projectedSavings = (data?.totalSpend || 0) * discountRate;

        res.json({
          totalRevenue: data?.totalRevenue || 0,
          totalSpend: data?.totalSpend || 0,
          netProfit: data?.netProfit || 0,
          orderCount: data?.orderCount || 0,
          quoteCount: 0,
          shopSavings: data?.shopSavings || projectedSavings,
          replenishmentAlert: (data?.totalSpend || 0) > 500,
          pulse: {
            score: Math.min(100, (data?.totalSpend || 0) / 10),
            status: (data?.totalSpend || 0) > 1000 ? "Power Buyer" : "Active Restocking",
            nextPerk: 1000 - (data?.totalSpend || 0) > 0 ? `Spend £${(1000 - (data.totalSpend || 0)).toFixed(2)} more for VIP shipping` : "VIP Shipping Unlocked!"
          }
        });
      } else {
        // Fallback for new accounts
        res.json({
          totalRevenue: 0,
          totalSpend: 0,
          netProfit: 0,
          orderCount: 0,
          quoteCount: 0,
          shopSavings: 0,
          replenishmentAlert: false,
          pulse: {
            score: 0,
            status: "New Buyer",
            nextPerk: "Spend £100 to earn your first loyalty badge"
          }
        });
      }
    } catch (error: any) {
      console.error("Analytics Error:", error);
      res.status(500).json({ error: "Failed to generate analytics" });
    }
  });

  // Smart Job Procurement Material Detection Route
  app.post("/api/job/procure-materials", requireAuth, aiLimiter, async (req, res) => {
    try {
      const { description } = req.body;
      let apiKey = process.env.GEMINI_API_KEY;
      
      if (!apiKey || apiKey === "your_gemini_api_key") {
        return res.json({ materials: [] });
      }

      const client = new GoogleGenAI({ apiKey });
      const prompt = `Analyze the following job description for a construction/trade project. 
Identify the likely material categories or specific tools a tradesperson would need to order to complete this job. 
Return a RAW JSON array of items (no markdown). 
Each object should have:
- 'item': Material category name
- 'reason': Brief explanation why it is needed for this job
- 'estimatedQuantity': A placeholder estimated quantity (integer) and unit (e.g., '10m', '50kg', '20L')
Description: ${description}`;

      const result = await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json" }
      });

      let parsedResult = [];
      if (result.text && result.text !== "undefined") {
        parsedResult = JSON.parse(result.text.replace(/```json/g, "").replace(/```/g, "").trim());
      }
      res.json({ materials: parsedResult });
    } catch (error: any) {
      res.json({ materials: [] });
    }
  });

  // Direct Merchant AI "BOM" (Bill of Materials) One-Click Extraction Route
  app.post("/api/job/extract-bom", requireAuth, aiLimiter, async (req, res) => {
    try {
      const { jobTitle, category, description, quoteMessage, quoteMaterialList, propertyPassportSpecs } = req.body;
      let apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey || apiKey === "your_gemini_api_key") {
        return res.json({ items: [] });
      }

      const client = new GoogleGenAI({ apiKey });
      const prompt = `You are TradeOS AI, a master UK Quantity Surveyor & Trade Merchant Estimator.
Analyze the following trade job and generate a realistic, detailed Bill of Materials (BOM) for 1-click ordering from UK merchants (Screwfix, Toolstation, Travis Perkins, City Plumbing, B&Q TradePoint, Jewson).

JOB CONTEXT:
- Title: ${jobTitle || 'Trade Job'}
- Category: ${category || 'General Building'}
- Description: ${description || 'N/A'}
- Quote Details / Scope: ${quoteMessage || 'N/A'}
- Quote Material Items: ${JSON.stringify(quoteMaterialList || [])}
- Property Specs Digital Twin: ${JSON.stringify(propertyPassportSpecs || {})}

REQUIREMENTS:
1. Extract 3 to 8 specific raw materials, consumables, and parts needed.
2. Use precise UK trade names (e.g., "15mm Copper Pipe BS EN 1057 (2m)", "Fernox TF1 Magnetic Filter", "MK 2-Gang Switched Sockets", "C16 Treated Structural Timber 47x100mm", "Mapei Ultracolor Plus Grout 5kg").
3. Provide standard realistic UK trade unit prices (£) and retail prices (£).
4. Assign to categories: "Plumbing & Heating" | "Electrical" | "Building & Timber" | "Fixings & Consumables" | "Tiling & Flooring" | "Decorating" | "Tools & PPE".
5. Suggest best supplier: "Screwfix Trade" | "Toolstation" | "Travis Perkins" | "City Plumbing" | "B&Q TradePoint" | "Jewson".
6. Check compatibility with Property Passport specs (e.g. boiler model, roof type, subfloor).

Return a JSON object with an 'items' array:
{
  "items": [
    {
      "id": "bom_1",
      "name": "Exact Part Name with spec",
      "sku": "SFX-12345",
      "category": "Plumbing & Heating",
      "quantity": 2,
      "unit": "lengths (2m)" | "units" | "packs" | "tubs (20kg)" | "rolls" | "boxes",
      "unitCost": 14.50,
      "retailCost": 19.99,
      "suggestedSupplier": "Screwfix Trade",
      "compatibilityNotes": "Fits Worcester Bosch 30i 15mm inlet pipework",
      "stockStatus": "in_stock_1hr",
      "isPassportComponent": true
    }
  ]
}`;

      const result = await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json" }
      });

      let parsedResult = { items: [] };
      if (result.text && result.text !== "undefined") {
        parsedResult = JSON.parse(result.text.replace(/```json/g, "").replace(/```/g, "").trim());
      }
      res.json(parsedResult);
    } catch (error: any) {
      console.error("AI BOM Extraction error:", error);
      res.json({ items: [] });
    }
  });

  app.post("/api/driver/analytics-pulse", requireAuth, aiLimiter, async (req, res) => {
    try {
      const { driverStats } = req.body;
      let apiKey = process.env.GEMINI_API_KEY;
      
      if (!apiKey || apiKey === "your_gemini_api_key") {
        return res.json({ insight: "Drive near city center between 5 PM and 8 PM for peak fares." });
      }

      const client = new GoogleGenAI({ apiKey });
      const prompt = `You are an AI assistant for a taxi/ride-hailing platform (AnyRoller). 
The user is a driver looking at their analytics hub.
Analyze their stats: ${JSON.stringify(driverStats)}
Give ONE short, highly actionable, encouraging tip (under 15 words) about when or where they should drive next to maximize earnings, or how to improve their rating/acceptance.
Limit your response to just the text of the tip. Do not use quotes.`;

      const result = await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });

      const insight = result.text ? result.text.trim() : "Drive near city center between 5 PM and 8 PM for peak fares.";
      res.json({ insight });
    } catch (error: any) {
      res.json({ insight: "Drive near city center between 5 PM and 8 PM for peak fares." });
    }
  });

  // Explicit allowlist of client-permitted Gemini functions (eliminates unvetted dynamic RPC execution)
  const ALLOWED_GEMINI_FUNCTIONS: Record<string, (...args: any[]) => Promise<any>> = {
    getPlatformHealthInsights: geminiServer.getPlatformHealthInsights,
    getJobEstimate: geminiServer.getJobEstimate,
    generateBroadcastDraft: geminiServer.generateBroadcastDraft,
    generateQuoteDraft: geminiServer.generateQuoteDraft,
    summarizeDisputeChat: geminiServer.summarizeDisputeChat,
    getReviewSummary: geminiServer.getReviewSummary,
    analyzeFraudRisk: geminiServer.analyzeFraudRisk,
    analyzeJobPhoto: geminiServer.analyzeJobPhoto,
    getClarifyingQuestions: geminiServer.getClarifyingQuestions,
    getMaterialList: geminiServer.getMaterialList,
    analyzeSecurityThreat: geminiServer.analyzeSecurityThreat,
    improveJobDescription: geminiServer.improveJobDescription,
    parseNaturalLanguageSearch: geminiServer.parseNaturalLanguageSearch,
    checkSafetyAndPII: geminiServer.checkSafetyAndPII,
    getDisputeResolution: geminiServer.getDisputeResolution,
    getRecommendedJobs: geminiServer.getRecommendedJobs,
    getMaintenancePredictions: geminiServer.getMaintenancePredictions,
    generateMarketingPost: geminiServer.generateMarketingPost,
    analyzeQuote: geminiServer.analyzeQuote,
    getRejectionFeedback: geminiServer.getRejectionFeedback,
    analyzeDocument: geminiServer.analyzeDocument,
    suggestNewCategories: geminiServer.suggestNewCategories,
    getMonetizationOpportunities: geminiServer.getMonetizationOpportunities,
    transcribeVoiceAudio: geminiServer.transcribeVoiceAudio,
    processVoiceAudio: geminiServer.processVoiceAudio,
    processVoiceTranscript: geminiServer.processVoiceTranscript,
    getEquipmentRecommendations: geminiServer.getEquipmentRecommendations,
    getShopRecommendations: geminiServer.getShopRecommendations,
    getBuildingRegsAndSupplierPricing: geminiServer.getBuildingRegsAndSupplierPricing,
    callTradeBot: geminiServer.callTradeBot,
    processTaxiVoiceCommand: geminiServer.processTaxiVoiceCommand,
    getAiModelRecommendations: geminiServer.getAiModelRecommendations,
    getDynamicInstantMatchPricing: geminiServer.getDynamicInstantMatchPricing,
    getNearbyTradeInsights: geminiServer.getNearbyTradeInsights,
    polishBio: geminiServer.polishBio,
    getProMatches: geminiServer.getProMatches,
    runServerPlatformMisuseDeepScan: geminiServer.runServerPlatformMisuseDeepScan,
    classifyUnmatchedSearchTermServer: geminiServer.classifyUnmatchedSearchTermServer,
    runServerAutonomousAgentTask: geminiServer.runServerAutonomousAgentTask,
  };

  const ADMIN_ONLY_GEMINI_FUNCTIONS = new Set([
    "getPlatformHealthInsights",
    "analyzeSecurityThreat",
    "getMonetizationOpportunities",
    "runServerPlatformMisuseDeepScan",
    "runServerAutonomousAgentTask",
    "suggestNewCategories"
  ]);

  // Secure Gemini API Service Call Proxy (AT-ADMIN-OPS-07: requireAuth + aiLimiter run BEFORE 10MB body parser)
  app.post("/api/gemini/call", requireAuth, aiLimiter, geminiJsonParser, async (req, res) => {
    try {
      const { functionName, args } = req.body;
      if (!functionName) {
        return res.status(400).json({ error: "Missing functionName" });
      }

      const targetFunc = ALLOWED_GEMINI_FUNCTIONS[functionName];

      if (!targetFunc || typeof targetFunc !== "function") {
        console.warn(`[Gemini RPC Blocked] Function '${functionName}' is not in the explicit allowlist.`);
        return res.status(403).json({ error: `Function '${functionName}' is not permitted or does not exist` });
      }

      if (ADMIN_ONLY_GEMINI_FUNCTIONS.has(functionName) && !(req as any).user?.isAdmin) {
        console.warn(`[Gemini RPC Blocked] Admin function '${functionName}' invoked by non-admin user '${(req as any).user?.uid}'`);
        return res.status(403).json({ error: `Function '${functionName}' requires administrator privileges` });
      }

      if (functionName === "callTradeBot") {
        const [userMessage, history, userContext] = Array.isArray(args) ? args : [];
        const authUser = (req as any).user;
        const authoritativeRole = authUser?.isAdmin ? "admin" : (authUser?.role || "homeowner");
        const result = await geminiServer.callTradeBot(userMessage, history, userContext, { authoritativeRole });
        return res.json(result);
      }

      const result = await targetFunc(...(args || []));
      res.json(result);
    } catch (error: any) {
      const upstreamStatus = geminiServer.extractUpstreamApiStatus(error);
      const cleanMessage = geminiServer.extractCleanGeminiErrorMessage(error);
      console.error(`Gemini Server Execution Error for ${req.body?.functionName}:`, cleanMessage);
      const isValidationError = typeof error?.message === "string" && error.message.startsWith("Invalid TradeBot request:");
      const responseStatus = isValidationError ? 400 : (upstreamStatus || 500);
      res.status(responseStatus).json({ error: cleanMessage || "Failed to execute Gemini function" });
    }
  });

  // High-Performance SSE Token Streaming Endpoint (<100-200ms TTFB)
  app.post("/api/gemini/stream", requireAuth, aiLimiter, async (req, res) => {
    const { task, args } = req.body || {};

    if (task !== "callTradeBotStream" && task !== "streamDiagnostic") {
      return res.status(400).json({ error: `Unknown streaming task: ${String(task || "")}` });
    }

    if (task === "streamDiagnostic" && !(req as any).user?.isAdmin) {
      return res.status(403).json({ error: "streamDiagnostic requires administrator privileges" });
    }

    if (task === "callTradeBotStream") {
      const [rawUserMessage] = Array.isArray(args) ? args : [];
      if (typeof rawUserMessage !== "string" || !rawUserMessage.trim()) {
        return res.status(400).json({ error: "Invalid TradeBot request: message cannot be empty." });
      }
      if (rawUserMessage.trim().length > 1500) {
        return res.status(400).json({ error: "Invalid TradeBot request: message exceeds 1500 characters." });
      }
    }

    // Configure SSE Headers after validation succeeds
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (res.flushHeaders) res.flushHeaders();

    const abortController = new AbortController();
    const handleClientClose = () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    };
    res.on("close", handleClientClose);

    try {
      if (task === "callTradeBotStream") {
        const [userMessage, history, userContext] = Array.isArray(args) ? args : [];
        const authUser = (req as any).user;
        const authoritativeRole = authUser?.isAdmin ? "admin" : (authUser?.role || "homeowner");
        const generator = geminiServer.callTradeBotStream(userMessage, history, userContext, {
          authoritativeRole,
          abortSignal: abortController.signal
        });
        for await (const event of generator) {
          if (abortController.signal.aborted || res.writableEnded) break;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } else if (task === "streamDiagnostic") {
        const [prompt, systemInstruction] = Array.isArray(args) ? args : [];
        const generator = geminiServer.streamGeminiDiagnostic(prompt, systemInstruction);
        for await (const event of generator) {
          if (abortController.signal.aborted || res.writableEnded) break;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      }
    } catch (error: any) {
      const upstreamStatus = geminiServer.extractUpstreamApiStatus(error);
      const cleanMessage = geminiServer.extractCleanGeminiErrorMessage(error);
      console.error(`Gemini Streaming Server Error [${task}]:`, cleanMessage);
      if (!abortController.signal.aborted && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", status: upstreamStatus || 500, error: cleanMessage || "Streaming failed" })}\n\n`);
      }
    } finally {
      res.off("close", handleClientClose);
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  });

  // Server-Side Semantic AI Query Cache Endpoints
  app.get("/api/gemini/cache-stats", requireAdmin, (req, res) => {
    try {
      const stats = geminiServer.getSemanticCacheTelemetry();
      res.json(stats);
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to retrieve cache stats" });
    }
  });

  app.post("/api/gemini/cache-clear", requireAdmin, requireAdminTier("financial_operator", "clearing Gemini semantic cache"), (req, res) => {
    try {
      geminiServer.clearSemanticCache();
      res.json({ success: true, message: "Semantic cache successfully purged" });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to clear cache" });
    }
  });

  // Category Registry Synchronization Endpoint
  app.post("/api/gemini/sync-categories", requireAdmin, requireAdminTier("financial_operator", "syncing category registry"), (req, res) => {
    try {
      const { categories, synonyms } = req.body || {};
      const syncResult = geminiServer.syncCategoryRegistryServer(categories, synonyms);
      res.json(syncResult);
    } catch (e: any) {
      console.error("Failed to sync category registry to Gemini server layer:", e);
      res.status(500).json({ error: e.message || "Failed to sync categories" });
    }
  });

  // Server-Mediated Unmatched Search / Demand-Gap Telemetry Endpoint (Admin-only reads in Firestore)
  app.post("/api/telemetry/unmatched-search", requireAuth, generalLimiter, async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({ recorded: false, reason: "database_unavailable" });
      }
      const rawQuery = typeof req.body?.query === "string" ? req.body.query.trim().toLowerCase() : "";
      if (rawQuery.length < 3 || rawQuery.length > 200 || /^\d+$/.test(rawQuery)) {
        return res.status(400).json({ recorded: false, error: "Invalid telemetry query" });
      }

      const slug = rawQuery.replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, "_").substring(0, 50);
      if (!slug || slug.length < 3) {
        return res.status(400).json({ recorded: false, error: "Invalid telemetry slug" });
      }

      const allowedSources = new Set(["search_bar", "ai_bot", "post_job"]);
      const allowedGapTypes = new Set(["unmatched_category", "no_traders_found"]);
      const source = allowedSources.has(req.body?.source) ? req.body.source : "search_bar";
      const gapType = allowedGapTypes.has(req.body?.gapType) ? req.body.gapType : "unmatched_category";
      const postcodeArea = typeof req.body?.postcodeArea === "string"
        ? req.body.postcodeArea.trim().toUpperCase().replace(/[^A-Z0-9 ]/g, "").split(" ")[0].slice(0, 6)
        : "";
      const suggestedCategory = typeof req.body?.category === "string"
        ? req.body.category.trim().slice(0, 80)
        : "";

      const docRef = db.collection("unmatched_search_telemetry").doc(slug);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        if (snap.exists) {
          tx.update(docRef, {
            searchCount: admin.firestore.FieldValue.increment(1),
            lastSearchedAt: admin.firestore.FieldValue.serverTimestamp(),
            ...(postcodeArea ? { postcodeArea } : {}),
            source,
            gapType
          });
        } else {
          tx.set(docRef, {
            id: slug,
            query: rawQuery,
            normalizedQuery: slug,
            searchCount: 1,
            lastSearchedAt: admin.firestore.FieldValue.serverTimestamp(),
            postcodeArea,
            status: "unmatched",
            source,
            gapType,
            suggestedCategory,
            userId: (req as any).user?.uid || ""
          });
        }
      });

      return res.json({ recorded: true, id: slug });
    } catch (e: any) {
      console.warn("[Telemetry] Failed to record unmatched search:", e?.message || e);
      return res.status(500).json({ recorded: false, error: "Failed to record demand telemetry" });
    }
  });

  // --- AI Agent Ecosystem Endpoints ---
  app.post("/api/admin/agents/scan", requireAdmin, async (req, res) => {
    try {
      const { agentType, payload } = req.body || {};
      if (!db) {
        return res.status(503).json({
          success: false,
          status: "unavailable",
          error: "Service Unavailable: Firestore telemetry database is required for live agent scans.",
        });
      }

      let result: any = {};

      switch (agentType) {
        case "materials_arbitrage": {
          const jobsSnap = await db.collection("jobs").limit(30).get();
          const observedDemandSignals = jobsSnap.docs.map((d) => {
            const j = d.data() || {};
            return {
              category: j.category,
              title: j.title,
              postcode: j.postcode,
              budget: j.budget || j.agreedPrice || null,
            };
          });
          result = await geminiServer.runServerMaterialsArbitrage(
            payload?.region || "Greater Manchester",
            observedDemandSignals
          );
          break;
        }
        case "trader_churn": {
          let liveTraders = Array.isArray(payload?.sampleTraders) && payload.sampleTraders.length > 0
            ? payload.sampleTraders
            : [];
          if (liveTraders.length === 0) {
            const tradersSnap = await db.collection("users").where("role", "==", "tradesperson").limit(30).get();
            liveTraders = tradersSnap.docs.map((d) => {
              const u = d.data() || {};
              return {
                id: d.id,
                name: u.name || u.businessName || "Tradesperson",
                tradeCategory: u.primaryTrade || u.category || (Array.isArray(u.trades) ? u.trades[0] : "General"),
                cityLocation: u.city || u.postcode || "UK",
                rating: u.rating ?? null,
                completedJobs: u.completedJobs ?? 0,
                verified: Boolean(u.idVerified || u.verifiedTrader),
                lastActiveAt: u.lastActiveAt || u.updatedAt || null,
              };
            });
          }
          result = await geminiServer.runServerTraderChurnPredictor(liveTraders);
          break;
        }
        case "demand_surge": {
          const jobsSnap = await db.collection("jobs").limit(50).get();
          const platformDemandSignals = jobsSnap.docs.map((d) => {
            const j = d.data() || {};
            return {
              category: j.category,
              urgency: j.urgency || (j.isEmergency ? "emergency" : "standard"),
              postcode: j.postcode,
              status: j.status,
            };
          });
          result = await geminiServer.runServerDemandSurgePredictor(
            payload?.region || "UK Wide",
            payload?.weatherCondition || "Sub-Zero Freeze & Frost Alert",
            platformDemandSignals
          );
          break;
        }
        default:
          return res.status(400).json({ error: `Unknown agentType: ${agentType}` });
      }

      await db.collection("ai_agent_audit_logs").add({
        agentType,
        action: "SCAN_COMPLETED",
        details: `Live telemetry scan completed for ${agentType}`,
        summary: result.executiveSummary || result.recommendedInterventionSummary || result.activeWeatherAlert || "Scan completed",
        timestamp: new Date().toISOString(),
        status: "success",
        triggerSource: "admin_portal"
      }).catch((logErr) => console.warn("Audit log write error:", logErr));

      res.json({ success: true, agentType, data: result });
    } catch (error: any) {
      const msg = error?.message || "Failed to execute agent scan";
      const isUnavailable = /GEMINI_API_KEY|API_KEY|PERMISSION_DENIED|ACCESS_DENIED|unavailable/i.test(msg);
      console.error("AI Agent Scan API Error:", error);
      res.status(isUnavailable ? 503 : 500).json({
        success: false,
        status: isUnavailable ? "unavailable" : "error",
        error: msg,
      });
    }
  });

  // Honest AI Agent Action Handler (Never fabricates unexecuted Stripe, dispatch, webhook, or broadcast actions)
  app.post("/api/admin/agents/execute-action", requireAdmin, requireAdminTier("financial_operator", "executing AI agent actions"), async (req, res) => {
    try {
      const { actionType, payload, agentName } = req.body || {};
      const timestamp = new Date().toISOString();
      const caller = (req as any).user || {};
      const cleanAction = String(actionType || "UNKNOWN_ACTION").trim().slice(0, 80);

      const guidanceMap: Record<string, string> = {
        EXECUTE_DISPUTE_SETTLEMENT:
          "Automated AI escrow settlement is disabled. Use the Disputes tab (/api/admin/disputes/:jobId/resolve) to execute verified Stripe escrow settlements.",
        DISPATCH_COMPLIANCE_JOB:
          "Automated AI contractor dispatch is not connected to live job dispatch. Create or assign the compliance job through the Property Passport or Jobs console.",
        PUBLISH_SOCIAL_CAMPAIGN:
          "Direct Meta/X publishing webhooks are not active. Copy the campaign draft and publish through your verified social media manager.",
        BROADCAST_ARBITRAGE_ALERT:
          "AI one-click arbitrage broadcasting is disabled. Send verified trader announcements through the Admin Broadcasts console (/api/admin/broadcasts).",
        APPLY_TRADER_RETENTION_INCENTIVE:
          "Automated fee rebates and promo activation are disabled here. Manage promo codes or tier overrides directly in the Pricing & Promo Codes console.",
        BROADCAST_DEMAND_SURGE_ALERT:
          "AI one-click demand surge broadcasting is disabled. Dispatch verified surge alerts through the Admin Broadcasts console (/api/admin/broadcasts).",
      };

      const guidance =
        guidanceMap[cleanAction] ||
        `Automated execution for '${cleanAction}' is not implemented. Perform this operation through the corresponding audited admin workflow.`;

      if (db) {
        try {
          await db.collection("ai_agent_audit_logs").add({
            agentType: String(agentName || "AI_ECOSYSTEM_AGENT").slice(0, 80),
            action: cleanAction,
            details: `Blocked unimplemented one-click action '${cleanAction}': ${guidance}`,
            payload: payload && typeof payload === "object" ? payload : {},
            adminUid: caller.uid || null,
            adminEmail: caller.email || null,
            timestamp,
            status: "not_implemented",
            executed: false,
            triggerSource: "admin_one_click",
          });
        } catch (logErr) {
          console.warn("Audit log save error:", logErr);
        }
      }

      return res.status(501).json({
        success: false,
        executed: false,
        actionType: cleanAction,
        error: guidance,
        outcomeMessage: guidance,
        recordedAt: timestamp,
      });
    } catch (error: any) {
      console.error("Execute Agent Action Error:", error);
      res.status(500).json({ success: false, executed: false, error: error.message || "Failed to process agent action" });
    }
  });

  // Query & Add Persistent AI Agent Audit Logs
  app.get("/api/admin/agents/audit-logs", requireAdmin, async (req, res) => {
    try {
      if (!db) {
        return res.json({ logs: [] });
      }
      const snapshot = await db.collection("ai_agent_audit_logs")
        .orderBy("timestamp", "desc")
        .limit(50)
        .get();

      const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      res.json({ logs });
    } catch (error: any) {
      console.warn("Error fetching AI agent audit logs:", error);
      res.json({ logs: [] });
    }
  });

  app.post("/api/admin/agents/audit-logs", requireAdmin, requireAdminTier("financial_operator", "writing AI agent audit logs"), async (req, res) => {
    try {
      if (!db) {
        return res.status(500).json({ error: "Database not available" });
      }
      const logEntry = {
        ...req.body,
        timestamp: req.body.timestamp || new Date().toISOString()
      };
      const docRef = await db.collection("ai_agent_audit_logs").add(logEntry);
      res.json({ success: true, id: docRef.id });
    } catch (error: any) {
      console.error("Error writing audit log:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Admin Security & Misuse Email Alert Dispatcher (Real Transport + Queue Persistence)
  app.post("/api/admin/send-email-alert", requireAdmin, requireAdminTier("financial_operator", "sending admin email alerts"), async (req, res) => {
    try {
      const { to, subject, html, breachId, severity, breachType } = req.body || {};
      const recipient = to || process.env.ADMIN_ALERT_EMAIL || "";
      const result = await dispatchTransactionalEmail({
        db,
        to: recipient,
        subject: subject || "🚨 Security Alert Flagged",
        html: html || "",
        metadata: {
          breachId: breachId || null,
          severity: severity || "HIGH",
          breachType: breachType || "anomaly",
        },
      });

      if (!result.delivered) {
        const statusCode =
          result.status === "unconfigured"
            ? 503
            : result.provider === "none" && result.status === "failed"
            ? 400
            : 502;
        return res.status(statusCode).json({
          success: false,
          delivered: false,
          status: result.status,
          provider: result.provider,
          queueId: result.queueId,
          error: result.error,
          timestamp: result.timestamp,
        });
      }

      res.json({
        success: true,
        delivered: true,
        status: result.status,
        provider: result.provider,
        queueId: result.queueId,
        providerMessageId: result.providerMessageId,
        message: `Email alert delivered to ${recipient}`,
        timestamp: result.timestamp,
      });
    } catch (error: any) {
      console.error("Error in /api/admin/send-email-alert:", error);
      res.status(500).json({ success: false, delivered: false, error: error.message || "Failed to dispatch email alert" });
    }
  });

  // Durable Staff Invitations (Expiring SHA-256 Token + Real Email Dispatch)
  app.post("/api/admin/invitations", requireAdmin, requireAdminTier("super_admin", "inviting admin staff"), async (req, res) => {
    try {
      const caller = (req as any).user || {};
      const result = await createAndDispatchStaffInvitation({
        db,
        email: req.body?.email,
        permissions: req.body?.permissions,
        invitedByUid: caller.uid,
        invitedByEmail: caller.email,
        appOrigin: getAuthoritativeAppUrl(),
      });

      if (db) {
        await db.collection("admin_audit_logs").add({
          action: "send_invitation",
          targetId: result.invitationId,
          targetType: "invitation",
          details: `Staff invitation for ${result.email} (${result.status} / ${result.deliveryStatus})`,
          adminId: caller.uid,
          adminEmail: caller.email || null,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }

      if (!result.success) {
        const httpCode = result.deliveryStatus === "unconfigured" ? 503 : 502;
        return res.status(httpCode).json(result);
      }

      res.status(201).json(result);
    } catch (err: any) {
      if (err instanceof StaffInvitationError) {
        return res.status(err.statusCode).json({ success: false, error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  app.delete("/api/admin/invitations/:invitationId", requireAdmin, requireAdminTier("super_admin", "cancelling staff invitations"), async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const invitationId = String(req.params.invitationId || "").trim();
      if (!invitationId) {
        throw new BadRequestError("invitationId is required.");
      }
      const caller = (req as any).user || {};
      const invRef = db.collection("invitations").doc(invitationId);
      const snap = await invRef.get();
      if (!snap.exists) {
        throw new NotFoundError("Invitation not found.");
      }
      const invData = snap.data() || {};
      await invRef.delete();

      await db.collection("admin_audit_logs").add({
        action: "cancel_invitation",
        targetId: invitationId,
        targetType: "invitation",
        details: `Cancelled staff invitation for ${invData.email || invitationId}`,
        adminId: caller.uid,
        adminEmail: caller.email || null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});

      res.json({ success: true, invitationId });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  app.post("/api/admin/invitations/:invitationId/accept", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user || {};
      const accepted = await acceptStaffInvitationToken({
        db,
        invitationId: req.params.invitationId,
        token: req.body?.token,
        callerUid: caller.uid,
        callerEmail: caller.email,
        emailVerified: caller.email_verified === true,
      });

      try {
        const userRecord = await admin.auth().getUser(caller.uid);
        await admin.auth().setCustomUserClaims(caller.uid, {
          ...(userRecord.customClaims || {}),
          admin: true,
          isAdmin: true,
          adminTier: accepted.adminTier,
        });
      } catch {
        // Non-blocking if Identity Toolkit unavailable in local tests
      }

      if (db) {
        await db.collection("admin_audit_logs").add({
          action: "accept_invitation",
          targetId: accepted.invitationId,
          targetType: "invitation",
          details: `Staff invitation accepted by ${caller.email} (tier: ${accepted.adminTier})`,
          adminId: caller.uid,
          adminEmail: caller.email || null,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }

      res.json({ success: true, ...accepted });
    } catch (err: any) {
      if (err instanceof StaffInvitationError) {
        return res.status(err.statusCode).json({ success: false, error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // Server-Authoritative Notification Dispatch (H3 Hardened)
  // Prevents direct client writes to /notifications with authenticated, authorized, validated, and rate-limited dispatch
  app.post(
    "/api/notifications",
    requireAuth,
    AbuseDefenseEngine.createMiddleware("NOTIFICATION_SEND"),
    async (req, res) => {
      try {
        const callerUid = (req as any).user?.uid;
        if (!callerUid) throw new UnauthorizedError("Authentication token is missing.");
        if (!db) throw new BadRequestError("Database not initialized");

        const validated = validateNotificationPayload(req.body);
        const { recipientId, title, message, type, link, jobId, conversationId, projectId, appointmentId } = validated;

        const isAuthorized = await authorizeNotificationRequest(
          db,
          callerUid,
          (req as any).user,
          { recipientId, type, link, jobId, conversationId, projectId, rideId: (validated as any).rideId, appointmentId }
        );

        if (!isAuthorized) {
          throw new ForbiddenError("You do not have authorization to send notifications to this recipient.");
        }

        // 2. Server-controlled document creation in /notifications (Immune to client field spoofing)
        const notificationData: Record<string, any> = {
          userId: recipientId,
          senderId: callerUid,
          title,
          message,
          type,
          read: false,
          isRead: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          visibleAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        if (link) {
          notificationData.link = link;
          notificationData.actionPath = link;
        }
        if (jobId) {
          notificationData.jobId = jobId;
        }
        if (conversationId) {
          notificationData.conversationId = conversationId;
        }
        if (appointmentId) {
          notificationData.appointmentId = appointmentId;
        }

        const docRef = await db.collection("notifications").add(notificationData);

        // Tier 2 (Free Push) + Tier 4 (Delayed Offline WhatsApp Fallback with 5-min cooldown)
        const notifTypeLower = String(type || "").toLowerCase();
        const isCriticalEvent =
          notifTypeLower.includes("quote") ||
          notifTypeLower.includes("emergency") ||
          notifTypeLower.includes("accepted") ||
          notifTypeLower.includes("arrived");

        // Best-effort Tier 2 multi-device FCM Push (Web PWA + Native Android)
        dispatchAuthoritativeFcmPush(db, getFirebaseMessagingClient(), {
          recipientId,
          title,
          body: message,
          channelId: isCriticalEvent ? "job_leads" : "chat_messages",
          notificationId: docRef.id,
          eventType: type || "notification",
          data: {
            link: link || "/notifications",
            jobId: jobId || "",
            conversationId: conversationId || "",
            type: type || "notification",
          },
        }).catch(() => {});

        // Best-effort Tier 4 delayed WhatsApp offline fallback (self-cancels if read or active within 45s)
        const waContextId =
          conversationId ||
          (validated as any).rideId ||
          jobId ||
          (link ? link.replace(/[^a-zA-Z0-9_-]/g, "_") : docRef.id);
        const waContextType: WhatsAppContextType = (validated as any).rideId
          ? "anyroller_ride"
          : notifTypeLower.includes("quote")
            ? "anytrader_quote"
            : conversationId || notifTypeLower === "message"
              ? "anytrader_chat"
              : "anytrader_job";

        enqueueWhatsAppFallback(db, {
          recipientUid: recipientId,
          senderUid: callerUid,
          senderLabel: title || "AnyTrader UK",
          contextId: waContextId,
          contextType: waContextType,
          contextSummary: message,
          deepLinkPath: link || (conversationId ? `/chat/${conversationId}` : jobId ? `/job/${jobId}` : "/notifications"),
          notificationId: docRef.id,
          urgent: isCriticalEvent,
        }).catch(() => {});

        res.json({
          success: true,
          notificationId: docRef.id,
          recipientId,
          createdAt: new Date().toISOString(),
        });
      } catch (error: any) {
        sendHttpError(res, error, req);
      }
    }
  );

  // Server-Authoritative Notification Querying / Listing (Task 35-D Hardened)
  // Requesting user is derived strictly from authentication context; client targetUserId parameter is restricted to admins
  app.get("/api/notifications", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      const targetUserId = req.query.userId || req.query.uid || req.query.recipientId;
      const unreadOnly = req.query.unread === "true" || req.query.unreadOnly === "true";
      const limit = req.query.limit ? Number(req.query.limit) : 50;

      const notifications = await listAuthoritativeNotifications(db, caller, {
        targetUserId: typeof targetUserId === "string" ? targetUserId : undefined,
        unreadOnly,
        limit,
      });

      res.json({
        success: true,
        notifications,
        count: notifications.length,
      });
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Mark-Read / Mark-Unread (Task 35-D Hardened)
  app.patch("/api/notifications/:id/read", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      const notificationId = req.params.id;
      const readState = req.body?.read !== false; // defaults to true
      const result = await markAuthoritativeNotificationRead(db, caller, notificationId, readState);
      res.json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  app.post("/api/notifications/:id/read", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      const notificationId = req.params.id;
      const readState = req.body?.read !== false;
      const result = await markAuthoritativeNotificationRead(db, caller, notificationId, readState);
      res.json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  app.patch("/api/notifications/:id", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      const notificationId = req.params.id;
      const readState = req.body?.read !== undefined ? Boolean(req.body.read) : true;
      const result = await markAuthoritativeNotificationRead(db, caller, notificationId, readState);
      res.json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Notification Deletion (Task 35-D Hardened)
  app.delete("/api/notifications/:id", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      const notificationId = req.params.id;
      const result = await deleteAuthoritativeNotification(db, caller, notificationId);
      res.json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Push Token Registration (Task 35-D + AT-CJ-NOTIF-05)
  // Strictly binds per-installation deviceId token to authenticated caller's subcollection
  app.post("/api/notifications/register-token", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      const result = await registerAuthoritativePushToken(db, caller, req.body);
      res.json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  app.post("/api/push-token", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      const result = await registerAuthoritativePushToken(db, caller, req.body);
      res.json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // AT-CJ-NOTIF-05: Per-device push token unregistration on logout / account switch
  app.post("/api/notifications/unregister-token", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      const result = await unregisterAuthoritativePushToken(db, caller, req.body || {});
      res.json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  app.delete("/api/notifications/push-token/:deviceId", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      const result = await unregisterAuthoritativePushToken(db, caller, {
        deviceId: req.params.deviceId,
      });
      res.json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // User Notification & WhatsApp Preferences (Server-Authoritative, Caller-Scoped)
  app.get("/api/notifications/preferences", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      const prefs = await getUserNotificationPreferences(db, caller);
      res.json({ success: true, preferences: prefs });
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  app.patch("/api/notifications/preferences", requireAuth, generalLimiter, async (req, res) => {
    try {
      const caller = (req as any).user;
      const prefs = await updateUserNotificationPreferences(db, caller, req.body || {});
      res.json({ success: true, preferences: prefs });
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  app.post(
    "/api/notifications/whatsapp-activation-link",
    requireAuth,
    generalLimiter,
    async (req, res) => {
      try {
        const caller = (req as any).user;
        const result = await createWhatsAppActivationLink(db, caller, {
          contextLabel: typeof req.body?.contextLabel === "string" ? req.body.contextLabel : undefined,
        });
        res.json({ success: true, ...result });
      } catch (error: any) {
        sendHttpError(res, error, req);
      }
    }
  );

  app.post("/api/notifications/presence", requireAuth, async (req, res) => {
    try {
      const caller = (req as any).user;
      const result = await recordUserChatPresence(db, caller, req.body || {});
      res.json(result);
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // AT-CJ-NOTIF-06: Authoritative multi-device FCM chat push dispatch + Tier-4 WhatsApp fallback
  const handleAuthoritativeChatPush = async (req: express.Request, res: express.Response) => {
    try {
      const caller = (req as any).user;
      const body = req.body || {};
      let pushResult: any = null;
      let pushError: any = null;

      try {
        pushResult = await sendAuthoritativeChatPush(
          db,
          getFirebaseMessagingClient(),
          caller,
          body
        );
      } catch (err: any) {
        pushError = err;
      }

      // If caller is forbidden or unauthorized, fail closed immediately
      if (pushError && (pushError instanceof ForbiddenError || pushError instanceof UnauthorizedError)) {
        throw pushError;
      }

      // Enqueue Tier-4 WhatsApp fallback (45s unread delay / 5s for ride arrival) when authorized
      const recipientId = typeof body.recipientId === "string" ? body.recipientId.trim() : "";
      let whatsappFallback: any = { queued: false };
      if (recipientId && (!pushError || String(pushError?.message || "").includes("no registered push token"))) {
        const hasRide = Boolean(body.rideId);
        const contextId = body.conversationId || body.rideId || body.jobId || "chat";
        const isRideArrival = String(body.type || "").toLowerCase().includes("arrived");
        whatsappFallback = await enqueueWhatsAppFallback(db, {
          recipientUid: recipientId,
          senderUid: caller?.uid,
          senderLabel: body.title || (hasRide ? "AnyRoller Driver" : "AnyTrader Message"),
          contextId,
          contextType: hasRide ? "anyroller_ride" : "anytrader_chat",
          contextSummary: body.body || body.message || "You have a new message.",
          deepLinkPath: hasRide
            ? `/rides`
            : body.conversationId
              ? `/chat/${body.conversationId}`
              : body.jobId
                ? `/job/${body.jobId}`
                : "/messages",
          notificationId: body.notificationId || null,
          urgent: isRideArrival,
        }).catch(() => ({ queued: false }));
      }

      if (pushResult) {
        return res.json({ ...pushResult, whatsappFallback });
      }
      if (whatsappFallback?.queued) {
        return res.json({
          success: true,
          recipientId,
          status: "whatsapp_fallback_queued",
          whatsappFallback,
        });
      }
      throw pushError;
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  };

  app.post(
    "/api/notifications/send-chat-push",
    requireAuth,
    AbuseDefenseEngine.createMiddleware("NOTIFICATION_SEND"),
    handleAuthoritativeChatPush
  );

  // Backwards-compatible alias used by Ride/Dispatch chat push callers (same auth + rate-limit + relationship checks)
  app.post(
    "/api/chat-push",
    requireAuth,
    AbuseDefenseEngine.createMiddleware("NOTIFICATION_SEND"),
    handleAuthoritativeChatPush
  );

  // Server-Authoritative Lead Distribution & Matching Alert Dispatch (H3 Hardened)
  // Homeowner job posting leads are authoritatively matched and dispatched server-side
  app.post(
    "/api/jobs/:id/distribute-leads",
    requireAuth,
    AbuseDefenseEngine.createMiddleware("NOTIFICATION_SEND"),
    async (req, res) => {
      try {
        const callerUid = (req as any).user?.uid;
        const jobId = req.params.id;
        if (!callerUid) throw new UnauthorizedError("Authentication token is missing.");
        if (!db) throw new BadRequestError("Database not initialized");

        const jobDoc = await db.collection("jobs").doc(jobId).get();
        if (!jobDoc.exists) {
          throw new NotFoundError("Job not found.");
        }

        const jobData = jobDoc.data() || {};
        const ownerId = jobData.homeownerId || jobData.userId || jobData.ownerId || jobData.customerId;
        const isCallerAdmin = isUserAdminClaim((req as any).user);

        if (callerUid !== ownerId && !isCallerAdmin) {
          throw new ForbiddenError("Only the job creator or an administrator can distribute job notifications.");
        }

        const messagingClient = getFirebaseMessagingClient();
        const distResult = await distributeJobLeadsAuthoritative({
          db,
          jobId,
          jobData: {
            ...jobData,
            category: jobData.category || req.body?.category || "General",
            postcode: jobData.postcode || req.body?.postcode || "",
            urgency: jobData.urgency || req.body?.urgency || "standard",
          },
          callerUid,
          maxRecipients: 25,
          wave: 1,
          forceRedistribute: Boolean(req.body?.forceRedistribute && isCallerAdmin),
          dispatchFcmPush: (payload) => dispatchAuthoritativeFcmPush(db!, messagingClient, payload),
        });

        res.json({
          success: true,
          jobId,
          notifiedCount: distResult.notifiedCount,
          skippedAlreadyDistributed: distResult.skippedAlreadyDistributed,
          wave: distResult.wave,
        });
      } catch (error: any) {
        sendHttpError(res, error, req);
      }
    }
  );

  // Server-Authoritative Manual Invoice Creation (AT-CJ-INVOICE-06)
  app.post("/api/invoices/create", requireAuth, async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database service is not initialized.");
      const identity = await resolveTrustedCanonicalIdentity(req as any, async (uid) => {
        const profileSnap = await db!.collection("users").doc(uid).get();
        return profileSnap.exists ? (profileSnap.data() || null) : null;
      });
      const result = await createManualInvoiceCommand({
        db,
        identity,
        rawBody: req.body,
      });
      res.status(201).json({ success: true, id: result.id, invoice: result.invoice });
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Official Job Invoice Creation / Retrieval (Slice 2 Money Flow Fix)
  app.post("/api/invoices/job/:jobId", requireAuth, generalLimiter, async (req, res) => {
    try {
      if (!db) throw new BadRequestError("Database service is not initialized.");
      const identity = await resolveTrustedCanonicalIdentity(req as any, async (uid) => {
        const profileSnap = await db!.collection("users").doc(uid).get();
        return profileSnap.exists ? (profileSnap.data() || null) : null;
      });
      const result = await createOrGetJobInvoiceCommand({
        db,
        identity,
        jobId: req.params.jobId,
      });
      res.status(result.created ? 201 : 200).json({ success: true, id: result.id, invoice: result.invoice });
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Server-Authoritative Instant Match Accept / Decline Command (AT-MATCH-08 / AT-CJ-SEC-START-01)
  app.post("/api/instant-match/respond", requireAuth, async (req, res) => {
    try {
      const callerUid = (req as any).user?.uid;
      if (!callerUid) throw new UnauthorizedError("Authentication token is missing.");
      if (!db) throw new BadRequestError("Database service is not initialized.");

      const attemptId = String(req.body?.attemptId || "").trim();
      const action = req.body?.action === "decline" ? "decline" : req.body?.action === "accept" ? "accept" : null;
      if (!attemptId || !action) {
        throw new BadRequestError("attemptId and valid action ('accept' or 'decline') are required.");
      }

      const result = await respondToInstantMatchAttempt({
        db,
        uid: callerUid,
        attemptId,
        action,
      });

      // Immediately advance to Candidate #2 when a trader declines (prevents Instant Match stall!)
      if (action === "decline" && result.instantMatchId) {
        void advanceInstantMatchAfterDecline(db, result.instantMatchId).catch((advErr) => {
          console.warn("[InstantMatch] Non-blocking decline advancement warning:", advErr);
        });
      }

      res.json({ success: true, ...result });
    } catch (error: any) {
      sendHttpError(res, error, req);
    }
  });

  // Cloud Scheduler / Cloud Run Job Decoupled Cron Trigger Endpoints (Leased + Fenced + Honest Execution Accounting AT-ADMIN-OPS-05)
  app.post("/api/cron/:jobName", requireCronOrAdmin, async (req, res) => {
    const { jobName } = req.params;
    try {
      let outcome: { acquired: boolean; fencedOut: boolean; reason?: string; result?: any };
      let canonicalJob = jobName;

      switch (jobName) {
        case "sms-queue":
          canonicalJob = "sms_queue";
          outcome = await runWithSchedulerLease("sms_queue", 45000, async () => processSmsQueue());
          break;
        case "whatsapp-fallback-queue":
          canonicalJob = "whatsapp_fallback_queue";
          outcome = await runWithSchedulerLease("whatsapp_fallback_queue", 30000, async () =>
            processWhatsAppFallbackQueue(db)
          );
          break;
        case "daily-aggregation":
          canonicalJob = "daily_aggregation";
          outcome = await runWithSchedulerLease("daily_aggregation", 300000, async () => runDailyAggregation());
          break;
        case "driver-payouts":
          canonicalJob = "driver_payouts";
          outcome = await runWithSchedulerLease("driver_payouts", 300000, async () => runDriverPayoutOrchestration());
          break;
        case "recurring-sessions":
          canonicalJob = "recurring_sessions";
          outcome = await runWithSchedulerLease("recurring_sessions", 300000, async () => runConsultancyRecurringSessionCreator());
          break;
        case "match-scores":
          canonicalJob = "match_scores";
          outcome = await runWithSchedulerLease("match_scores", 300000, async () => runConsultancyScoreRecalculator());
          break;
        case "compliance-audit":
          canonicalJob = "compliance_audit";
          outcome = await runWithSchedulerLease("compliance_audit", 300000, async () => runComplianceGuardianAudit());
          break;
        case "sentinel-scan":
          canonicalJob = "sentinel_scan";
          outcome = await runWithSchedulerLease("sentinel_scan", 300000, async () => runSentinelAnomalyScan());
          break;
        case "matching-system":
          canonicalJob = "matching_system";
          outcome = await runWithSchedulerLease("matching_system", 12000, async (ctx) => runMatchingCycle(ctx));
          break;
        case "lead-wave-expansion":
          canonicalJob = "lead_wave_expansion";
          outcome = await runWithSchedulerLease("lead_wave_expansion", 60000, async () =>
            expandLowQuoteJobsWave2({
              db,
              extraRadiusMiles: 10,
              maxJobsPerRun: 25,
              dispatchFcmPush: (payload) => dispatchAuthoritativeFcmPush(db!, getFirebaseMessagingClient(), payload),
            })
          );
          break;
        case "refund-reconciliation":
          canonicalJob = "refund_reconciliation";
          outcome = await runWithSchedulerLease("refund_reconciliation", 180000, async () =>
            reconcilePaymentRefundAggregates(db, getOptionalStripeClient())
          );
          break;
        case "sweep-payment-intents":
          canonicalJob = "sweep_payment_intents";
          outcome = await runWithSchedulerLease("sweep_payment_intents", 120000, async () =>
            sweepStaleCheckoutIntents({ db, stripeClient: getOptionalStripeClient() })
          );
          break;
        case "publish-cooling-off-reviews":
          canonicalJob = "cooling_off_reviews";
          outcome = await runWithSchedulerLease("cooling_off_reviews", 120000, async () =>
            publishMatureCoolingOffReviewsCommand(db)
          );
          break;
        default:
          return res.status(404).json({ error: `Unknown cron job '${jobName}'` });
      }

      const dispatch = buildCronDispatchResponse(canonicalJob, outcome);
      return res.status(dispatch.httpStatus).json(dispatch.body);
    } catch (error: any) {
      console.error(`Error in /api/cron/${jobName}:`, error);
      res.status(500).json({
        success: false,
        executed: false,
        job: jobName,
        status: "failed",
        executedCount: 0,
        skippedCount: 0,
        failedCount: 1,
        errors: [error?.message || "Failed to execute cron job"],
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.get("/api/cron/status", requireCronOrAdmin, async (req, res) => {
    try {
      if (!db) return res.json({ status: "disabled_no_db", locks: [] });
      const snap = await db.collection("cron_locks").get();
      const locks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      res.json({ success: true, locks, inProcessCronDisabled: process.env.DISABLE_IN_PROCESS_CRON === "true" });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // V6 Pre-Flight Production Readiness & Invariant Audit Route
  app.get("/api/admin/production-audit", requireAdmin, (req, res) => {
    try {
      const auditReport = runProductionChecks(process.env, db);
      res.json({ success: true, ...auditReport });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // FIN-05: Bounded Read-Only Operator Financial Reconciliation Report Endpoint (with full FIN-05 collector/evaluator audit)
  app.get("/api/admin/financial-reconciliation/report", requireAdmin, async (req, res) => {
    try {
      const caller = (req as any).user;
      const includeAudit = req.query.includeAudit !== "false";
      const report = await generateFinancialReconciliationReport(
        db,
        req.query as any,
        {
          uid: caller.uid,
          isAdmin: true,
        },
        {
          stripeClient: getOptionalStripeClient(),
          includeAudit,
        }
      );
      res.json({ success: true, ...report });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  app.post("/api/admin/financial-reconciliation/audit", requireAdmin, requireAdminTier("financial_operator", "running financial reconciliation audits"), async (req, res) => {
    try {
      const caller = (req as any).user;
      const report = await generateFinancialReconciliationReport(
        db,
        { ...(req.body || {}), includeAudit: true },
        { uid: caller.uid, isAdmin: true },
        { stripeClient: getOptionalStripeClient(), includeAudit: true }
      );
      res.json({ success: true, ...report });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  app.post("/api/admin/financial-reconciliation/resolve", requireAdmin, requireAdminTier("financial_operator", "resolving financial reconciliation findings"), async (req, res) => {
    try {
      const caller = (req as any).user;
      const result = await executeReconciliationOperatorAction({
        db,
        stripeClient: getOptionalStripeClient(),
        caller: { uid: caller.uid, email: caller.email, isAdmin: true },
        action: req.body?.action,
        jobId: req.body?.jobId,
        quoteId: req.body?.quoteId,
        milestoneId: req.body?.milestoneId,
        idempotencyKey: req.body?.idempotencyKey,
        findingCode: req.body?.findingCode,
        entityId: req.body?.entityId,
        note: req.body?.note,
      });
      res.json(result);
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // AT-ADMIN-CTRL-01, AT-ACCOUNT-01, AT-VER-09: Unified Account Suspension, Deletion & Reinstatement
  app.post("/api/admin/users/:userId/suspend", requireAdmin, requireAdminTier("financial_operator", "suspending user accounts"), async (req, res) => {
    try {
      const caller = (req as any).user;
      const result = await suspendOrDeleteAccount({
        db,
        authClient: admin.auth(),
        adminUid: caller.uid,
        adminEmail: caller.email,
        targetUid: req.params.userId,
        reason: req.body?.reason || "Administrative suspension",
        mode: "suspend",
      });
      res.json(result);
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  app.post("/api/admin/users/:userId/reinstate", requireAdmin, requireAdminTier("financial_operator", "reinstating user accounts"), async (req, res) => {
    try {
      const caller = (req as any).user;
      const result = await reinstateSuspendedAccount({
        db,
        authClient: admin.auth(),
        adminUid: caller.uid,
        adminEmail: caller.email,
        targetUid: req.params.userId,
        reason: req.body?.reason || "Administrative reinstatement",
      });
      res.json(result);
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  const handleAdminDeleteUser = async (req: express.Request, res: express.Response) => {
    try {
      const caller = (req as any).user;
      const result = await suspendOrDeleteAccount({
        db,
        authClient: admin.auth(),
        adminUid: caller.uid,
        adminEmail: caller.email,
        targetUid: req.params.userId,
        reason: req.body?.reason || "Administrative account deletion",
        mode: "delete",
      });
      res.json(result);
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  };
  app.delete("/api/admin/users/:userId", requireAdmin, requireAdminTier("super_admin", "deleting user accounts"), handleAdminDeleteUser);
  app.post("/api/admin/users/:userId/delete", requireAdmin, requireAdminTier("super_admin", "deleting user accounts"), handleAdminDeleteUser);

  // Server-Authoritative User Tier, Founding Member & Recommended Categories Update (syncs users + public_profiles + audit)
  app.post("/api/admin/users/:userId/attributes", requireAdmin, requireAdminTier("financial_operator", "updating user attributes"), async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const targetUid = String(req.params.userId || "").trim();
      if (!targetUid) throw new BadRequestError("targetUid is required.");
      const caller = (req as any).user || {};
      const { tierId, isFoundingMember, recommendedCategories, reason } = req.body || {};

      const userRef = db.collection("users").doc(targetUid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) {
        throw new NotFoundError("Target user not found.");
      }

      const nowIso = new Date().toISOString();
      const userPatch: Record<string, any> = { updatedAt: nowIso };
      const publicPatch: Record<string, any> = { updatedAt: nowIso };
      const changes: string[] = [];

      if (tierId !== undefined) {
        const cleanTier = String(tierId || "").trim().slice(0, 64);
        if (!cleanTier) throw new BadRequestError("Valid tierId string is required.");
        userPatch.tierId = cleanTier;
        userPatch.tier = cleanTier;
        publicPatch.tierId = cleanTier;
        publicPatch.tier = cleanTier;
        changes.push(`tierId=${cleanTier}`);
      }
      if (typeof isFoundingMember === "boolean") {
        userPatch.isFoundingMember = isFoundingMember;
        publicPatch.isFoundingMember = isFoundingMember;
        changes.push(`isFoundingMember=${isFoundingMember}`);
      }
      if (recommendedCategories !== undefined) {
        if (!Array.isArray(recommendedCategories)) {
          throw new BadRequestError("recommendedCategories must be an array of strings.");
        }
        const cleaned = Array.from(
          new Set(
            recommendedCategories
              .map((c: any) => String(c || "").trim())
              .filter(Boolean)
              .slice(0, 20)
          )
        );
        userPatch.recommendedCategories = cleaned;
        publicPatch.recommendedCategories = cleaned;
        changes.push(`recommendedCategories(${cleaned.length})`);
      }

      if (changes.length === 0) {
        throw new BadRequestError("No supported attributes provided (tierId, isFoundingMember, recommendedCategories).");
      }

      const batch = db.batch();
      batch.set(userRef, userPatch, { merge: true });
      const publicRef = db.collection("public_profiles").doc(targetUid);
      const publicSnap = await publicRef.get();
      if (publicSnap.exists) {
        batch.set(publicRef, publicPatch, { merge: true });
      }
      await batch.commit();

      await db.collection("admin_audit_logs").add({
        action: "update_user_attributes",
        targetId: targetUid,
        targetType: "user",
        details: `Updated user attributes (${changes.join(", ")})${reason ? ` — ${String(reason).slice(0, 200)}` : ""}`,
        adminId: caller.uid,
        adminEmail: caller.email || null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});

      res.json({ success: true, userId: targetUid, updated: userPatch });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // Server-Authoritative Admin Job Deletion (blocks deleting funded/assigned/disputed jobs, removes public_job_cards projection)
  app.delete("/api/admin/jobs/:jobId", requireAdmin, requireAdminTier("financial_operator", "deleting jobs"), async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: "Database service unavailable" });
      const jobId = String(req.params.jobId || "").trim();
      if (!jobId) throw new BadRequestError("jobId is required.");
      const caller = (req as any).user || {};

      const jobRef = db.collection("jobs").doc(jobId);
      const snap = await jobRef.get();
      if (!snap.exists) {
        throw new NotFoundError("Job not found.");
      }
      const data = snap.data() || {};

      const isFunded =
        data.funded === true ||
        data.isPaid === true ||
        Number(data.amountPaid || 0) > 0 ||
        Number(data.escrowBalance || 0) > 0 ||
        !["none", "unfunded", ""].includes(String(data.escrowStatus || "none").toLowerCase()) ||
        Boolean(data.escrowPaymentIntentId || data.stripePaymentIntentId);
      const isAssigned = Boolean(
        data.acceptedTradespersonId ||
        data.acceptedTraderId ||
        data.assignedTraderId ||
        data.acceptedQuoteId
      );
      const isDisputed =
        !["none", ""].includes(String(data.disputeStatus || "none").toLowerCase()) ||
        Boolean(data.disputeId || data.disputedAt);
      const isActiveLifecycle = ["in_progress", "completed", "disputed"].includes(
        String(data.status || "").toLowerCase()
      );

      if (isFunded || isAssigned || isDisputed || isActiveLifecycle) {
        throw new ConflictError(
          "Cannot delete a job that is funded, assigned to a tradesperson, in progress, completed, or under dispute."
        );
      }

      const batch = db.batch();
      batch.delete(jobRef);
      batch.delete(db.collection("public_job_cards").doc(jobId));
      await batch.commit();

      await db.collection("admin_audit_logs").add({
        action: "delete_job",
        targetId: jobId,
        targetType: "job",
        details: `Deleted unfunded/unassigned job '${data.title || jobId}' (guest=${Boolean(data.isGuest)})`,
        adminId: caller.uid,
        adminEmail: caller.email || null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});

      res.json({ success: true, jobId });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // AT-ADMIN-CONFIG-01: Atomic Versioned Pricing & Commission Config Publisher
  app.post("/api/admin/pricing-config/publish", requireAdmin, requireAdminTier("super_admin", "publishing platform pricing configuration"), async (req, res) => {
    try {
      const caller = (req as any).user;
      const result = await publishPlatformPricingConfigAtomic({
        db,
        adminUid: caller.uid,
        adminEmail: caller.email,
        tempConfig: req.body?.tempConfig,
        feeTiers: req.body?.feeTiers,
        businessTiers: req.body?.businessTiers,
        paidAddons: req.body?.paidAddons,
        commissionCapGbp:
          req.body?.commissionCapGbp !== undefined
            ? req.body.commissionCapGbp
            : req.body?.tempConfig?.commissionCapGbp,
        globalTiersProviderModels: req.body?.globalTiersProviderModels,
      });
      // Immediately clear server-side cached config so live routes see the new pricing/commission without delay
      configCache.delete("global");
      configCache.delete("global_tiers");
      res.json(result);
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // ==========================================
  // V8.1 STRUCTURED INTELLIGENCE DOMAIN ROUTES
  // ==========================================

  // Register task handlers for the async queue
  registerIntelligenceTaskHandlers();

  // Trigger Asynchronous Job Intelligence Analysis (AT-INTEL-JOB-01: dynamic content/version idempotency hash)
  app.post("/api/intelligence/jobs/:jobId/analyze", requireAuth, async (req, res) => {
    try {
      const { jobId } = req.params;
      const user = (req as any).user;

      if (!db) {
        return res.status(503).json({ error: "Service Unavailable: Firestore database not initialized." });
      }

      const jobDoc = await db.collection("jobs").doc(jobId).get();
      if (!jobDoc.exists) {
        return res.status(404).json({ error: `Job ${jobId} not found` });
      }
      const jobData: any = { jobId, ...jobDoc.data() };

      // Assert authorization: owner, assigned trader, or admin
      const isOwner = jobData.homeownerId === user.uid || jobData.userId === user.uid;
      const isAssignedTrader = jobData.assignedTraderId === user.uid;
      const isAdminUser = await checkIsAdmin(user);
      if (!isOwner && !isAssignedTrader && !isAdminUser) {
        return res.status(403).json({ error: "Forbidden: insufficient permissions to analyze this job" });
      }

      const contentVersionHash = computeJobAnalysisVersionHash(jobData);
      const idempotencyKey = buildIdempotencyKey(jobId, "JOB_ANALYSIS_COMPLETED", contentVersionHash);
      const task = await intelligenceTaskQueue.enqueueTaskAsync(
        "job_extraction",
        "job",
        jobId,
        idempotencyKey,
        { job: jobData, contentVersionHash }
      );

      res.status(202).json({
        success: true,
        message: "Intelligence extraction task enqueued",
        taskId: task.taskId,
        idempotencyKey: task.idempotencyKey,
        contentVersionHash,
        status: task.status,
      });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // Get Derived Job Intelligence
  app.get("/api/intelligence/jobs/:jobId", requireAuth, async (req, res) => {
    try {
      const { jobId } = req.params;
      const user = (req as any).user;

      if (db) {
        const isAdminUser = await checkIsAdmin(user);
        const jobDoc = await db.collection("jobs").doc(jobId).get();
        assertCanReadJobIntelligence({
          jobExists: jobDoc.exists,
          jobData: jobDoc.exists ? (jobDoc.data() || {}) : null,
          userUid: user?.uid,
          isAdminUser,
        });

        const intelDoc = await db.collection("intelligence_jobs").doc(jobId).get();
        if (!intelDoc.exists) {
          return res.status(404).json({ error: "Job intelligence record not found" });
        }
        return res.json({ success: true, intelligence: intelDoc.data() });
      }

      res.status(404).json({ error: "Job intelligence database not initialized" });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // Trigger Asynchronous Property Intelligence Roll-up (Admin Only — AT-INTEL-PROP-01: strict lineage & 404 on missing property)
  app.post("/api/intelligence/properties/:propertyId/rollup", requireAdmin, async (req, res) => {
    try {
      const { propertyId } = req.params;

      if (!db) {
        return res.status(503).json({ error: "Service Unavailable: Firestore database not initialized." });
      }

      const propDoc = await db.collection("properties").doc(propertyId).get();
      if (!propDoc.exists) {
        return res.status(404).json({ error: `Target property '${propertyId}' not found.` });
      }
      const propData: any = { propertyId, ...propDoc.data() };

      // Strictly scope historical jobs to this target property's lineage ONLY
      const jobsSnap = await db
        .collection("intelligence_jobs")
        .where("propertyId", "==", propertyId)
        .get();
      const historicalJobs = jobsSnap.docs
        .map((d) => d.data())
        .filter((j: any) => j && j.propertyId === propertyId);

      const lineageVersionHash = `pv_${computeSha256(
        JSON.stringify({
          propertyId,
          updatedAt: propData.updatedAt || "",
          jobIds: historicalJobs.map((j: any) => j.jobId || "").sort(),
        })
      ).slice(0, 16)}`;

      const idempotencyKey = buildIdempotencyKey(propertyId, "PROPERTY_ROLLUP_COMPLETED", lineageVersionHash);
      const task = await intelligenceTaskQueue.enqueueTaskAsync(
        "property_rollup",
        "property",
        propertyId,
        idempotencyKey,
        { property: propData, historicalJobs }
      );

      res.status(202).json({
        success: true,
        message: "Property rollup task enqueued",
        taskId: task.taskId,
        idempotencyKey: task.idempotencyKey,
        scopedJobCount: historicalJobs.length,
        status: task.status,
      });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // Trigger Asynchronous Property Predictive Maintenance Assessment
  app.post("/api/intelligence/properties/:propertyId/predictive-maintenance", requireAuth, async (req, res) => {
    try {
      const { propertyId } = req.params;
      const user = (req as any).user;

      // Ownership or Admin access check
      if (db) {
        const propDoc = await db.collection("properties").doc(propertyId).get();
        if (!propDoc.exists) {
          return res.status(404).json({ error: "Property not found" });
        }
        const propData = propDoc.data();
        const isOwner = propData?.ownerId === user.uid || propData?.homeownerId === user.uid;
        const isAdmin = await checkIsAdmin(user);
        if (!isOwner && !isAdmin) {
          return res.status(403).json({ error: "Forbidden: Not property owner or admin" });
        }
      }

      const {
        componentType,
        predictionType,
        forecastStart,
        forecastEnd,
        likelihood,
        severity,
        rationale,
        evidenceIds,
        rawCandidate,
      } = req.body || {};

      const idempotencyKey = buildIdempotencyKey(
        propertyId,
        `PM_${componentType || "roof"}_${forecastStart || "default"}`,
        "v1"
      );
      const task = await intelligenceTaskQueue.enqueueTaskAsync(
        "predictive_maintenance",
        "property",
        propertyId,
        idempotencyKey,
        {
          propertyId,
          componentType,
          predictionType,
          forecastStart,
          forecastEnd,
          likelihood,
          severity,
          rationale,
          evidenceIds,
          rawCandidate,
          provenance: {
            source: user.uid,
            origin: "api_request",
            triggeredBy: user.uid,
          },
          isVerifiedServerAction: false,
        }
      );

      res.status(202).json({
        success: true,
        message: "Property predictive maintenance task enqueued",
        taskId: task.taskId,
        idempotencyKey: task.idempotencyKey,
        status: task.status,
      });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // Admin Quality Review & Human Correction (AT-INTEL-QUALITY-01: fail-closed atomic commit of review + audit event)
  app.post("/api/intelligence/quality/review", requireAdmin, async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({
          error: "Service Unavailable: Firestore database required to atomically persist quality review and audit log.",
        });
      }

      const user = (req as any).user;
      const { targetCollection, targetId, targetVersionId, action, reason, originalCandidate, correctedResult } = req.body || {};

      // Atomically persists BOTH intelligence_quality review doc and immutable intelligence_events audit log
      const reviewOutcome = await qualityReviewService.applyAndPersistReview(
        {
          targetCollection,
          targetId,
          targetVersionId,
          action,
          reviewerId: user.uid || "admin",
          reason,
          originalCandidate,
          correctedResult,
        },
        db
      );

      res.json({
        success: true,
        persistedAtomically: true,
        review: reviewOutcome.review,
        auditEventId: reviewOutcome.auditEvent.eventId,
      });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // Controlled Historical Backfill (Admin Only, Strict Boolean dryRun + Closed Collection Allowlist)
  app.post("/api/intelligence/backfill", requireAdmin, async (req, res) => {
    try {
      const validated = parseAdminBackfillOptions(req.body || {});

      if (!db) {
        return res.status(503).json({
          error: "Service Unavailable: Firestore database instance required for production backfill execution",
        });
      }

      const progress = await controlledBackfillEngine.executeFirestoreBackfill(db, validated);

      res.json({
        success: true,
        mode: validated.dryRun ? "DRY_RUN" : "LIVE_BACKFILL",
        progress,
      });
    } catch (err: any) {
      if (err instanceof BackfillValidationError) {
        return res.status(400).json({ success: false, error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // ==========================================
  // V8.3 TASK 29 — CONTRACTOR ARCHIVE RIGHTS BOUNDARY
  // Server-Authoritative Boundary & Purpose Eligibility
  // ==========================================

  // Register Contractor Archive Rights Boundary
  app.post("/api/intelligence/contractor-archives/register", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const {
        archiveReference,
        title,
        description,
        allowInternalAi,
        purposes,
        restrictions,
        components,
        linkProvenance,
      } = req.body || {};

      if (!archiveReference || typeof archiveReference !== "string") {
        return res.status(400).json({ error: "Missing or invalid archiveReference" });
      }

      // Enforce strict tenant binding (tenantId === authenticated user UID)
      const tenantId = user.uid;
      const contractorUid = user.uid;

      if (db) {
        contractorArchiveRightsService.setFirestoreDb(db);
      }

      const outcome = await contractorArchiveRightsService.registerArchiveRights({
        tenantId,
        contractorUid,
        archiveReference,
        title,
        description,
        allowInternalAi,
        purposes,
        restrictions,
        components,
        linkProvenance,
        recordedBy: user.uid,
      });

      res.status(201).json({
        success: true,
        archiveId: outcome.archiveId,
        rightsId: outcome.rightsRecord.rightsId,
        rightsRecord: outcome.rightsRecord,
        provenanceNodeId: outcome.provenanceNode?.nodeId,
        componentCount: outcome.componentRights?.length || 0,
      });
    } catch (err: any) {
      if (err instanceof ContractorArchiveSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      if (err instanceof ContractorArchiveValidationError) {
        return res.status(400).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // Evaluate Contractor Archive Eligibility
  app.post("/api/intelligence/contractor-archives/:archiveId/evaluate", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const { archiveId } = req.params;
      const { purpose, componentId, originType } = req.body || {};

      if (!purpose || typeof purpose !== "string") {
        return res.status(400).json({ error: "Missing required 'purpose' field" });
      }

      if (db) {
        contractorArchiveRightsService.setFirestoreDb(db);
      }

      const tenantId = user.uid;
      const isAdmin = await checkIsAdmin(user);

      let result;
      if (componentId) {
        result = await contractorArchiveRightsService.evaluateComponentEligibility({
          tenantId,
          archiveId,
          componentId,
          purpose: purpose as any,
          originType,
          requestedByUid: user.uid,
          isAdmin,
        });
      } else {
        result = await contractorArchiveRightsService.evaluateArchiveEligibility({
          tenantId,
          archiveId,
          purpose: purpose as any,
          requestedByUid: user.uid,
          isAdmin,
        });
      }

      res.json({
        success: true,
        result,
      });
    } catch (err: any) {
      if (err instanceof ContractorArchiveSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // Revoke Contractor Archive Rights
  app.post("/api/intelligence/contractor-archives/:archiveId/revoke", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const { archiveId } = req.params;
      const { reason } = req.body || {};

      if (!reason || typeof reason !== "string") {
        return res.status(400).json({ error: "Missing required 'reason' field" });
      }

      if (db) {
        contractorArchiveRightsService.setFirestoreDb(db);
      }

      const tenantId = user.uid;
      const outcome = await contractorArchiveRightsService.revokeArchiveRights(
        tenantId,
        archiveId,
        reason,
        user.uid
      );

      res.json({
        success: true,
        archiveId,
        status: outcome.status,
        revocationReason: outcome.revocationReason,
      });
    } catch (err: any) {
      if (err instanceof ContractorArchiveSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // Register Data Classification
  app.post("/api/intelligence/data-classification/register", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const {
        classificationId,
        recordType,
        recordId,
        category,
        sensitivity,
        restrictions,
        provenanceRef,
        rightsRef,
        archiveRef,
      } = req.body || {};

      if (!recordType || !recordId || !category || !provenanceRef) {
        return res.status(400).json({ error: "Missing required fields: recordType, recordId, category, provenanceRef" });
      }

      const tenantId = user.uid;
      const record = await dataClassificationEligibilityService.registerClassification({
        classificationId,
        recordType,
        recordId,
        category,
        sensitivity,
        restrictions,
        provenanceRef,
        rightsRef,
        archiveRef,
        tenantId,
        recordedBy: user.uid,
      });

      res.json({
        success: true,
        record,
      });
    } catch (err: any) {
      if (err instanceof DataClassificationSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      if (err instanceof DataClassificationValidationError) {
        return res.status(400).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // Evaluate Data Eligibility
  app.post("/api/intelligence/data-classification/evaluate", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const { recordType, recordId, requestedPurpose, classificationId } = req.body || {};

      if (!recordType || !recordId || !requestedPurpose) {
        return res.status(400).json({ error: "Missing required fields: recordType, recordId, requestedPurpose" });
      }

      const tenantId = user.uid;
      // AT-INTEL-CLASS-01: Public HTTP routes must NEVER honor caller-supplied isInternalAi flags
      const decision = await dataClassificationEligibilityService.evaluateEligibility({
        tenantId,
        recordType,
        recordId,
        requestedPurpose,
        classificationId,
        context: {
          callerUid: user.uid,
          isInternalAi: false,
          executionChannel: "public_api",
        },
      });

      res.json({
        success: true,
        decision,
      });
    } catch (err: any) {
      if (err instanceof DataClassificationSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // Revoke Data Classification
  app.post("/api/intelligence/data-classification/revoke", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const { classificationId, reason } = req.body || {};

      if (!classificationId || !reason) {
        return res.status(400).json({ error: "Missing required fields: classificationId, reason" });
      }

      const tenantId = user.uid;
      const record = await dataClassificationEligibilityService.revokeClassification(
        tenantId,
        classificationId,
        reason
      );

      res.json({
        success: true,
        classificationId: record.classificationId,
        status: record.status,
        revocationReason: record.revocationReason,
      });
    } catch (err: any) {
      if (err instanceof DataClassificationSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      if (err instanceof DataClassificationValidationError) {
        return res.status(400).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // =========================================================================
  // Task 31: AI Training & Usage Controls Endpoints
  // =========================================================================

  // Register / Configure AI Usage Controls
  app.post("/api/intelligence/ai-controls/register", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const {
        controlId,
        recordType,
        recordId,
        scope,
        purposes,
        trainingConsent,
        modelTiersAllowed,
        restrictions,
        provenanceRef,
        rightsRef,
        classificationRef,
        archiveRef,
        reConsentCeremony,
      } = req.body || {};

      if (!recordType || !recordId || !provenanceRef) {
        return res.status(400).json({ error: "Missing required fields: recordType, recordId, provenanceRef" });
      }

      if (db) {
        aiTrainingUsageControlsService.setFirestoreDb(db);
      }

      const tenantId = user.uid;
      const record = await aiTrainingUsageControlsService.registerAiUsageControls({
        controlId,
        recordType,
        recordId,
        scope,
        purposes,
        trainingConsent,
        modelTiersAllowed,
        restrictions,
        provenanceRef,
        rightsRef,
        classificationRef,
        archiveRef,
        reConsentCeremony,
        tenantId,
        recordedBy: user.uid,
      });

      res.json({
        success: true,
        record,
      });
    } catch (err: any) {
      if (err instanceof AiUsageControlsSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      if (err instanceof AiUsageControlsValidationError) {
        return res.status(400).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // Evaluate AI Usage & Training Eligibility
  app.post("/api/intelligence/ai-controls/evaluate", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const { recordType, recordId, requestedPurpose, controlId, targetModelTier } = req.body || {};

      if (!recordType || !recordId || !requestedPurpose) {
        return res.status(400).json({ error: "Missing required fields: recordType, recordId, requestedPurpose" });
      }

      if (db) {
        aiTrainingUsageControlsService.setFirestoreDb(db);
      }

      const tenantId = user.uid;
      // AT-INTEL-CLASS-01: Public HTTP routes must NEVER honor caller-supplied isInternalAi flags
      const decision = await aiTrainingUsageControlsService.evaluateAiUsageEligibility({
        tenantId,
        recordType,
        recordId,
        requestedPurpose,
        controlId,
        targetModelTier,
        context: {
          callerUid: user.uid,
          isInternalAi: false,
          executionChannel: "public_api",
        },
      });

      res.json({
        success: true,
        decision,
      });
    } catch (err: any) {
      if (err instanceof AiUsageControlsSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      if (err instanceof AiUsageControlsValidationError) {
        return res.status(400).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // Get AI Usage Control Record
  app.get("/api/intelligence/ai-controls/:controlId", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const { controlId } = req.params;

      if (db) {
        aiTrainingUsageControlsService.setFirestoreDb(db);
      }

      const record = await aiTrainingUsageControlsService.getAiUsageControlRecord(controlId, user.uid);
      if (!record) {
        return res.status(404).json({ error: "AI usage control record not found" });
      }

      res.json({
        success: true,
        record,
      });
    } catch (err: any) {
      if (err instanceof AiUsageControlsSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // Revoke AI Usage Controls
  app.post("/api/intelligence/ai-controls/:controlId/revoke", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const { controlId } = req.params;
      const { reason } = req.body || {};

      if (!reason || typeof reason !== "string") {
        return res.status(400).json({ error: "Missing required 'reason' field" });
      }

      if (db) {
        aiTrainingUsageControlsService.setFirestoreDb(db);
      }

      const tenantId = user.uid;
      const record = await aiTrainingUsageControlsService.revokeAiUsageControls(
        tenantId,
        controlId,
        reason,
        user.uid
      );

      res.json({
        success: true,
        controlId: record.controlId,
        status: record.status,
        revocationReason: record.revocationReason,
      });
    } catch (err: any) {
      if (err instanceof AiUsageControlsSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      if (err instanceof AiUsageControlsValidationError) {
        return res.status(400).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // =========================================================================
  // V8.3 Task 32: Revocation, Retention & Deletion API Routes
  // =========================================================================

  // Register or update retention policy
  app.post("/api/intelligence/data-lifecycle/policy/register", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const { recordType, retentionClass, retentionPeriodDays, retentionUntil, legalHold, legalHoldReason } = req.body || {};

      // Security Remediation B: Legal Hold is strictly privileged. Ordinary users cannot create, modify, or remove legal holds.
      const isAdmin = await checkIsAdmin(user);
      if ((legalHold !== undefined || legalHoldReason !== undefined) && !isAdmin) {
        return res.status(403).json({ error: "Forbidden: Only administrators can create, modify, or remove legal holds" });
      }

      if (db) {
        dataRetentionService.setFirestoreDb(db);
      }

      const policy = await dataRetentionService.registerRetentionPolicy({
        tenantId: user.uid,
        recordType,
        retentionClass,
        retentionPeriodDays,
        retentionUntil,
        ...(isAdmin && legalHold !== undefined ? { legalHold, legalHoldReason } : {}),
      });

      res.status(201).json({
        success: true,
        policy,
      });
    } catch (err: any) {
      if (err instanceof DataRetentionSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      if (err instanceof DataRetentionValidationError) {
        return res.status(400).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // Apply or remove legal hold (Privileged Admin Only)
  app.post("/api/intelligence/data-lifecycle/policy/:policyId/legal-hold", requireAdmin, async (req, res) => {
    try {
      const user = (req as any).user;
      const { policyId } = req.params;
      const { legalHold, reason } = req.body || {};

      if (typeof legalHold !== "boolean") {
        return res.status(400).json({ error: "Missing or invalid 'legalHold' boolean field" });
      }

      if (db) {
        dataRetentionService.setFirestoreDb(db);
      }

      // Server-authoritative tenant derivation: lookup policy to verify and derive tenant
      const existingPolicy = await dataRetentionService.getRetentionPolicyAdmin(policyId);
      if (!existingPolicy) {
        return res.status(404).json({ error: `Retention policy '${policyId}' not found` });
      }

      const policy = await dataRetentionService.setLegalHold(
        existingPolicy.tenantId,
        policyId,
        legalHold,
        reason,
        user.uid
      );

      res.json({
        success: true,
        policy,
      });
    } catch (err: any) {
      if (err instanceof DataRetentionSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      if (err instanceof DataRetentionValidationError) {
        return res.status(400).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // Get retention policy
  app.get("/api/intelligence/data-lifecycle/policy/:policyId", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const { policyId } = req.params;

      if (db) {
        dataRetentionService.setFirestoreDb(db);
      }

      const policy = await dataRetentionService.getRetentionPolicy(policyId, user.uid);
      if (!policy) {
        return res.status(404).json({ error: "Retention policy not found" });
      }

      res.json({
        success: true,
        policy,
      });
    } catch (err: any) {
      if (err instanceof DataRetentionSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // Orchestrate lifecycle rights revocation (AT-INTEL-LIFECYCLE-01: fail closed 503/404 on missing targets)
  app.post("/api/intelligence/data-lifecycle/revoke", requireAuth, async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({ error: "Service Unavailable: Firestore database not initialized." });
      }

      const user = (req as any).user;
      const { rightsId, controlId, provenanceNodeId, reason } = req.body || {};

      if (!reason || typeof reason !== "string") {
        return res.status(400).json({ error: "Missing required 'reason' field" });
      }

      dataRetentionService.setFirestoreDb(db);

      const result = await dataRetentionService.revokeDataLifecycleRights({
        tenantId: user.uid,
        rightsId,
        controlId,
        provenanceNodeId,
        reason,
        updatedBy: user.uid,
      });

      res.json({
        success: true,
        result,
      });
    } catch (err: any) {
      if (err instanceof DataRetentionNotFoundError) {
        return res.status(404).json({ error: err.message });
      }
      if (err instanceof DataRetentionSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      if (err instanceof DataRetentionValidationError) {
        return res.status(400).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // ==========================================
  // BATCH 13 — OUTREACH QUEUE, TELEMETRY, PARTNER LEADS, ECOSYSTEM STATS & FIELD OWNERSHIP GUARDS
  // ==========================================

  // AT-OUTREACH-02: Durable server outbound outreach queue
  app.post("/api/admin/outreach/enqueue", requireAdmin, requireAdminTier("financial_operator", "enqueueing outreach messages"), generalLimiter, async (req, res) => {
    try {
      const adminUser = (req as any).user;
      const record = await enqueueOutreachMessageCommand({
        db,
        adminUid: adminUser.uid,
        adminEmail: adminUser.email || null,
        leadId: req.body?.leadId,
        businessName: req.body?.businessName,
        channel: req.body?.channel,
        recipient: req.body?.recipient,
        subject: req.body?.subject,
        body: req.body?.body,
        campaignName: req.body?.campaignName,
      });
      res.status(202).json({ success: true, record });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  app.get("/api/admin/outreach/queue", requireAdmin, async (req, res) => {
    try {
      const limitNum = Number(req.query.limit) || 50;
      const items = await listOutreachQueueCommand(db, limitNum);
      res.json({ success: true, items });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // AT-FIRESTORE-SEARCH-01: Authenticated, rate-limited, schema-bounded search telemetry endpoint
  app.post("/api/telemetry/search-log", requireAuth, generalLimiter, async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({ error: "Telemetry database unavailable." });
      }
      const caller = (req as any).user;
      const rawQuery = typeof req.body?.query === "string" ? req.body.query.trim().toLowerCase() : "";
      const rawCategory = typeof req.body?.category === "string" ? req.body.category.trim().slice(0, 80) : undefined;
      if (rawQuery.length < 2 || rawQuery.length > 120) {
        return res.status(400).json({ error: "Search query must be between 2 and 120 characters." });
      }

      const payload: Record<string, any> = {
        query: rawQuery,
        userId: caller.uid,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (rawCategory) payload.category = rawCategory;

      const docRef = await db.collection("search_logs").add(payload);
      res.status(201).json({ success: true, id: docRef.id });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // AT-LEAD-02: Server-verified partner lead attribution endpoint (prevents forged client lead writes)
  app.post("/api/partner-leads", requireAuth, generalLimiter, async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({ error: "Service Unavailable: database not initialized." });
      }
      const caller = (req as any).user;
      const campaignId = typeof req.body?.campaignId === "string" ? req.body.campaignId.trim() : "";
      if (!campaignId) {
        return res.status(400).json({ error: "campaignId is required." });
      }

      const campaignRef = db.collection("campaigns").doc(campaignId);
      const userRef = db.collection("users").doc(caller.uid);
      const leadRef = db.collection("leads").doc();
      const safeData =
        req.body?.data && typeof req.body.data === "object" && !Array.isArray(req.body.data)
          ? Object.fromEntries(Object.entries(req.body.data).slice(0, 20))
          : {};

      let attributedLeadId = "";
      await db.runTransaction(async (tx: any) => {
        const [campaignSnap, userSnap] = await Promise.all([tx.get(campaignRef), tx.get(userRef)]);
        if (!campaignSnap.exists) {
          throw new NotFoundError("Partner campaign not found.");
        }
        const campaignData = campaignSnap.data() || {};
        if (campaignData.status !== "active") {
          throw new BadRequestError("Partner campaign is not currently active.");
        }

        const authoritativePartnerId = String(campaignData.partnerId || "").trim();
        if (!authoritativePartnerId) {
          throw new BadRequestError("Campaign has no verified partner attribution.");
        }
        const userData = userSnap.exists ? userSnap.data() || {} : {};
        const authoritativeRole = String(userData.role || "homeowner");

        tx.set(leadRef, {
          partnerId: authoritativePartnerId,
          campaignId,
          userId: caller.uid,
          userRole: authoritativeRole,
          status: "new",
          data: safeData,
          verifiedByServer: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        tx.update(campaignRef, {
          leads: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        attributedLeadId = leadRef.id;
      });

      res.status(201).json({ success: true, leadId: attributedLeadId });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  app.post("/api/partner-campaigns/:campaignId/click", requireAuth, generalLimiter, async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({ error: "Service Unavailable: database not initialized." });
      }
      const campaignId = String(req.params.campaignId || "").trim();
      if (!campaignId) return res.status(400).json({ error: "campaignId is required." });

      const campaignRef = db.collection("campaigns").doc(campaignId);
      await db.runTransaction(async (tx: any) => {
        const snap = await tx.get(campaignRef);
        if (!snap.exists) {
          throw new NotFoundError("Partner campaign not found.");
        }
        const data = snap.data() || {};
        if (data.status !== "active") {
          throw new BadRequestError("Partner campaign is not active.");
        }
        tx.update(campaignRef, {
          clicks: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      res.json({ success: true, campaignId });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // AT-ECOSYSTEM-01: Real aggregated Firestore platform metrics for Ecosystem AI Strategist
  app.get("/api/admin/ecosystem/stats", requireAdmin, async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({ error: "Service Unavailable: database not initialized." });
      }

      const [usersCountSnap, jobsCountSnap, campaignsSnap, leadsCountSnap, recentJobsSnap] = await Promise.all([
        db.collection("users").count().get(),
        db.collection("jobs").count().get(),
        db.collection("campaigns").where("status", "==", "active").count().get(),
        db.collection("leads").count().get(),
        db.collection("jobs").orderBy("createdAt", "desc").limit(200).get().catch(() => db.collection("jobs").limit(200).get()),
      ]);

      const categoryCounts = new Map<string, number>();
      for (const d of recentJobsSnap.docs || []) {
        const cat = String(d.data()?.category || "").trim();
        if (cat) categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
      }
      const topCategories = Array.from(categoryCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([cat]) => cat);

      res.json({
        success: true,
        stats: {
          totalUsers: usersCountSnap.data().count || 0,
          totalJobs: jobsCountSnap.data().count || 0,
          activeCampaigns: campaignsSnap.data().count || 0,
          totalLeads: leadsCountSnap.data().count || 0,
          topCategories,
          sampledJobsCount: (recentJobsSnap.docs || []).length,
          aggregatedAt: new Date().toISOString(),
        },
      });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // AT-ADMIN-AUTH-01: Dual-Control Approval Workflow Routes
  app.get("/api/admin/approvals", requireAdmin, async (req, res) => {
    try {
      if (!db) throw new ServiceUnavailableError("Database unavailable.");
      const snap = await db.collection("admin_approval_requests").limit(50).get();
      const approvals = (snap.docs || []).map((d: any) => ({ id: d.id, ...d.data() }));
      res.json({ success: true, approvals, currentAdminTier: (req as any).adminTier });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  app.post("/api/admin/approvals", requireAdmin, requireAdminTier("financial_operator", "creating dual-control approval requests"), async (req, res) => {
    try {
      const actor: AdminActor = (req as any).adminActor;
      const result = await createDualControlApprovalRequest(db, actor, req.body || {});
      res.status(201).json({ success: true, ...result });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  app.post("/api/admin/approvals/:requestId/review", requireAdmin, requireAdminTier("financial_operator", "reviewing dual-control approval requests"), async (req, res) => {
    try {
      const actor: AdminActor = (req as any).adminActor;
      const { decision, reviewNote } = req.body || {};
      const result = await reviewDualControlApprovalRequest(
        db,
        actor,
        req.params.requestId,
        decision,
        reviewNote
      );
      res.json({ success: true, ...result });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // AT-ADMIN-CTRL-04: Bounded Server Admin Broadcast Fan-Out Queue
  app.post("/api/admin/broadcasts", requireAdmin, requireAdminTier("financial_operator", "dispatching platform broadcasts"), async (req, res) => {
    try {
      const actor: AdminActor = (req as any).adminActor;
      const result = await enqueueAdminBroadcastCommand(db, actor, req.body || {}, process.env);
      res.status(result.status === "partial_failure" ? 207 : 201).json({ success: true, ...result });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  app.get("/api/admin/broadcasts", requireAdmin, async (req, res) => {
    try {
      if (!db) throw new ServiceUnavailableError("Database unavailable.");
      const snap = await db.collection("broadcast_fanout_jobs").limit(50).get();
      const jobs = (snap.docs || []).map((d: any) => ({ id: d.id, ...d.data() }));
      res.json({ success: true, jobs });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // AT-ADMIN-CTRL-06: Unified Operational Health & Incident Snapshot
  app.get("/api/admin/operational-health", requireAdmin, async (req, res) => {
    try {
      const snapshot = await getOperationalHealthSnapshot(db);
      res.json({ success: true, health: snapshot });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // AT-ADMIN-CONFIG-02: Versioned Platform Feature Flags Control Plane
  app.get("/api/admin/feature-flags", requireAdmin, async (req, res) => {
    try {
      const data = await listFeatureFlagsCommand(db);
      res.json({ success: true, ...data });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  app.put("/api/admin/feature-flags/:flagKey", requireAdmin, requireAdminTier("super_admin", "updating feature flags"), async (req, res) => {
    try {
      const actor: AdminActor = (req as any).adminActor;
      const record = await upsertFeatureFlagCommand(db, actor, req.params.flagKey, req.body || {});
      res.json({ success: true, flag: record });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // AT-CJ-CHAT-03: In-context Chat Report / Block Participant APIs
  app.get("/api/chat/blocks", requireAuth, generalLimiter, async (req, res) => {
    try {
      const caller = (req as any).user;
      const data = await listUserChatBlocksCommand(db, caller.uid);
      res.json({ success: true, ...data });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  app.post("/api/chat/report-block", requireAuth, generalLimiter, async (req, res) => {
    try {
      const caller = (req as any).user;
      const result = await reportOrBlockChatParticipantCommand(
        db,
        { uid: caller.uid, email: caller.email },
        req.body || {}
      );
      res.status(201).json({ success: true, ...result });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  app.delete("/api/chat/blocks/:targetUserId", requireAuth, generalLimiter, async (req, res) => {
    try {
      const caller = (req as any).user;
      const result = await unblockChatParticipantCommand(db, caller.uid, req.params.targetUserId);
      res.json({ success: true, ...result });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // AT-FIELD-01: Ownership-immutable update endpoints for field_agents and dispatch_routes
  app.patch("/api/field-agents/:id", requireAuth, generalLimiter, async (req, res) => {
    try {
      const caller = (req as any).user;
      const isAdminUser = await checkIsAdmin(caller);
      const result = await updateFieldEntityWithOwnershipGuard({
        db,
        collectionName: "field_agents",
        entityId: req.params.id,
        callerUid: caller.uid,
        isAdmin: isAdminUser,
        updates: req.body || {},
      });
      res.json({ success: true, ...result });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  app.patch("/api/dispatch-routes/:id", requireAuth, generalLimiter, async (req, res) => {
    try {
      const caller = (req as any).user;
      const isAdminUser = await checkIsAdmin(caller);
      const result = await updateFieldEntityWithOwnershipGuard({
        db,
        collectionName: "dispatch_routes",
        entityId: req.params.id,
        callerUid: caller.uid,
        isAdmin: isAdminUser,
        updates: req.body || {},
      });
      res.json({ success: true, ...result });
    } catch (err: any) {
      sendHttpError(res, err, req);
    }
  });

  // Request deletion
  app.post("/api/intelligence/data-lifecycle/deletion-request", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const { recordType, recordId, reason } = req.body || {};

      if (!recordType || !recordId || !reason) {
        return res.status(400).json({ error: "Missing required fields: recordType, recordId, reason" });
      }

      if (db) {
        dataRetentionService.setFirestoreDb(db);
      }

      const request = await dataRetentionService.requestDeletion({
        tenantId: user.uid,
        recordType,
        recordId,
        reason,
        requestedBy: user.uid,
      });

      res.status(201).json({
        success: true,
        request,
      });
    } catch (err: any) {
      if (err instanceof DataRetentionSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      if (err instanceof DataRetentionValidationError) {
        return res.status(400).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // Process approved deletion (Security Remediation A: Server-Authoritative target resolution; client targetCollection removed)
  app.post("/api/intelligence/data-lifecycle/process-deletion", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const { requestId } = req.body || {};

      if (!requestId) {
        return res.status(400).json({ error: "Missing required 'requestId' field" });
      }

      if (db) {
        dataRetentionService.setFirestoreDb(db);
      }

      const completed = await dataRetentionService.processDeletion({
        tenantId: user.uid,
        requestId,
        processedBy: user.uid,
      });

      res.json({
        success: true,
        request: completed,
      });
    } catch (err: any) {
      if (err instanceof DataRetentionSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      if (err instanceof DataRetentionValidationError) {
        return res.status(400).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // Get deletion request
  app.get("/api/intelligence/data-lifecycle/:requestId", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const { requestId } = req.params;

      if (db) {
        dataRetentionService.setFirestoreDb(db);
      }

      const request = await dataRetentionService.getDeletionRequest(requestId, user.uid);
      if (!request) {
        return res.status(404).json({ error: "Deletion request not found" });
      }

      res.json({
        success: true,
        request,
      });
    } catch (err: any) {
      if (err instanceof DataRetentionSecurityError) {
        return res.status(403).json({ error: err.message });
      }
      sendHttpError(res, err, req);
    }
  });

  // AT-MOBILE-03: Server-served parameterized mobile deep-link manifests validated against placeholders
  app.get("/.well-known/assetlinks.json", (_req, res) => {
    const result = buildAndroidAssetLinksPayload(process.env);
    if (!result.configured || !result.payload) {
      return res.status(503).json({
        error: result.reason || "Android App Links signing identity is not configured.",
        code: "ANDROID_ASSETLINKS_UNCONFIGURED",
      });
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).json(result.payload);
  });

  app.get("/.well-known/apple-app-site-association", (_req, res) => {
    const result = buildAppleAppSiteAssociationPayload(process.env);
    if (!result.configured || !result.payload) {
      return res.status(503).json({
        error: result.reason || "iOS Universal Links Team ID is not configured.",
        code: "IOS_AASA_UNCONFIGURED",
      });
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).json(result.payload);
  });

  // Fallback 404 JSON handler for unmatched /api/* routes to prevent HTML index.html responses
  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.path}` });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use((req, res, next) => {
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(req.path);
      } catch {
        return res.status(404).end();
      }
      if (decodedPath.includes("\0")) {
        return res.status(404).end();
      }
      const collapsedPath = decodedPath.replace(/\\+/g, "/").replace(/\/+/g, "/");
      const normalizedPath = (path.posix.normalize(collapsedPath).replace(/\/+$/, "")) || "/";
      if (
        /^\/server\.cjs(\.map)?(\/|$)/i.test(normalizedPath) ||
        /^\/assets\/aistudio(\/|$)/i.test(normalizedPath) ||
        /\.map$/i.test(normalizedPath)
      ) {
        return res.status(404).end();
      }
      next();
    });
    app.use(express.static(distPath, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('sw.js') || filePath.endsWith('registerSW.js') || filePath.endsWith('manifest.webmanifest') || filePath.endsWith('manifest.json') || filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        }
      }
    }));
    app.get("*", (req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Terminal Express error-handling middleware: guarantees sanitized JSON responses
  // and prevents raw Express HTML stack traces (e.g. malformed JSON body parse errors).
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      return next(err);
    }
    if (err?.type === "entity.parse.failed" || (err instanceof SyntaxError && (err as { status?: number }).status === 400 && "body" in err)) {
      return res.status(400).json({
        error: "Invalid JSON request body.",
        code: "INVALID_JSON",
      });
    }
    if (err?.type === "entity.too.large" || err?.status === 413) {
      return res.status(413).json({
        error: "Request payload exceeds the maximum allowed size.",
        code: "PAYLOAD_TOO_LARGE",
      });
    }
    return sendHttpError(res, err, req);
  });

  return new Promise((resolve, reject) => {
    const serverInstance = app.listen(PORT, "0.0.0.0", () => {
      console.log(`AnyTrader UK server running on http://localhost:${PORT}`);
      const preflight = runProductionChecks(process.env, db);
      console.log(`[V6 Pre-Flight Gate] Overall Status: ${preflight.overallStatus} (${preflight.checks.filter(c => c.status === 'FAIL').length} fails, ${preflight.checks.filter(c => c.status === 'WARN').length} warns)`);
      if (process.env.NODE_ENV === "production" && preflight.overallStatus === "NO_GO") {
        console.warn(
          "[Pre-Flight] WARNING: Incomplete production configuration detected (missing optional secrets/origins). Server remains active for client & API ingress:",
          preflight.checks.filter((c) => c.status === "FAIL").map((c) => c.name)
        );
        if (process.env.STRICT_PREFLIGHT_EXIT === "true") {
          console.error("[Pre-Flight] STRICT_PREFLIGHT_EXIT is enabled. Terminating process.");
          process.exit(1);
        }
      }
      resolve(serverInstance);
    });
    serverInstance.on("error", (err) => {
      reject(err);
    });

    // Graceful Cloud Run / container shutdown on SIGTERM & SIGINT
    let isShuttingDown = false;
    const handleGracefulShutdown = (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(`[Shutdown] Received ${signal}. Stopping background workers and draining HTTP connections...`);
      try {
        intelligenceTaskQueue.stopWorker();
      } catch (stopErr) {
        console.warn("[Shutdown] Error stopping intelligenceTaskQueue:", stopErr);
      }
      const forceExitTimer = setTimeout(() => {
        console.warn("[Shutdown] Force-exiting after 10s drain timeout.");
        process.exit(1);
      }, 10_000);
      if (typeof forceExitTimer.unref === "function") {
        forceExitTimer.unref();
      }
      serverInstance.close((closeErr) => {
        clearTimeout(forceExitTimer);
        if (closeErr) {
          console.error("[Shutdown] HTTP server close error:", closeErr);
          process.exit(1);
        }
        console.log("[Shutdown] Clean shutdown complete.");
        process.exit(0);
      });
    };
    process.once("SIGTERM", () => handleGracefulShutdown("SIGTERM"));
    process.once("SIGINT", () => handleGracefulShutdown("SIGINT"));
  });
}

export async function bootstrap() {
  const hooks: BootstrapLifecycleHooks = {
    initFirebase: initializeFirebaseAdminAsync,
    verifyFirestore: async (firestoreDb) => {
      // Strictly fail-closed without swallowing errors
      return verifyFirestoreReadiness(firestoreDb, 3000);
    },
    queue: intelligenceTaskQueue,
    registerHandlers: registerIntelligenceTaskHandlers,
    startWorker: () => {
      intelligenceTaskQueue.setMaintenanceCheck(() => isMaintenanceModeActive({ db }));
      intelligenceTaskQueue.startWorker(5000);
    },
    startSyncWorkers: (firestoreDb) => {
      db = firestoreDb;
      startInstantMatchEngine(firestoreDb, {
        dispatchFcmPush: (payload) =>
          dispatchAuthoritativeFcmPush(firestoreDb, getFirebaseMessagingClient(), payload),
      });
      startCategoryRegistrySyncWorker(firestoreDb);
      startPublicJobCardsSync(firestoreDb);
      startPublicPropertiesSync(firestoreDb);
      startPublicAdsSync(firestoreDb);
    },
    startBackgroundSchedulers: () => startBackgroundSchedulers(),
    startMatchingSystem: () => startMatchingSystem(),
    startHttpServer: () => startServer(),
  };

  try {
    const result = await runBootstrapSequence(hooks);
    isApplicationReady = true;
    bootstrapError = null;
    return result;
  } catch (err: any) {
    isApplicationReady = false;
    bootstrapError = err?.message || String(err);
    throw err;
  }
}

// Authoritative bootstrap startup
bootstrap().catch((err) => {
  const errMsg = err?.message || String(err);
  const isExpectedCredentialBoundary =
    errMsg.includes("PERMISSION_DENIED") ||
    errMsg.includes("UNAUTHENTICATED") ||
    errMsg.includes("Could not load the default credentials");
  if (isExpectedCredentialBoundary) {
    console.log(
      "[Bootstrap] Admin SDK runtime credentials unavailable for external Firebase project; running fail-closed in client SPA ingress mode (background workers paused)."
    );
  } else {
    console.warn("[Bootstrap] Background intelligence worker bootstrap notice (client SPA ingress active):", errMsg);
  }
  // Bind port 3000 for platform health probes, diagnostic ingress, and client UI serving
  // (workers, sync, and schedulers remain unstarted).
  console.log("[Bootstrap] Starting HTTP server on port 3000 for client serving & API ingress...");
  startServer().catch((serverErr) => {
    console.error("[Server] Error binding HTTP server:", serverErr);
  });
});

