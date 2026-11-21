import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  sanitizePublicDescription,
  sanitizeJobToPublicCard,
  isJobEligibleForPublicCard,
  backfillPublicJobCards,
  isPropertyEligibleForPublicPassport,
  sanitizePropertyToPublicPassport,
  backfillPublicProperties,
  isAdEligibleForPublicProjection,
  sanitizeAdToPublicAd,
  backfillPublicAds,
} from "../../src/server/projectionSync";
import {
  computeGeodesicDistanceMiles,
  isWithinAdRadiusMiles,
  resolvePostcodeCentroid,
  extractExplicitGeoPoint,
} from "../../src/lib/geoDistance";
import {
  sanitizePublicProfilePayload,
  PUBLIC_PROFILE_FORBIDDEN_PII_KEYS,
} from "../../src/lib/publicProfileProjection";
import {
  verifyTraderAccountWithProjection,
  buildSanitizedPublicProfileProjection,
} from "../../src/server/accountLifecycle";
import {
  createCpcCampaignCommand,
  updateAdAutoTopUpSettingsCommand,
  processAdAutoTopUpCommand,
  trackSponsoredAdEventCommand,
  clearAdEventDedupCacheForTests,
} from "../../src/server/adEngine";
import { PropertyPassportService } from "../../src/server/intelligence/propertyPassport";
import { getHybridTraderRecommendations } from "../../src/services/aiRecommendationService";
import { auditProfileAndAccountReadiness } from "../../src/services/aiProfileOptimizationService";

function createInMemoryFirestore(initialCollections: Record<string, Record<string, any>> = {}) {
  const store: Record<string, Map<string, any>> = {};
  for (const [col, docs] of Object.entries(initialCollections)) {
    store[col] = new Map(Object.entries(docs).map(([id, data]) => [id, structuredClone(data)]));
  }
  const ensureCol = (name: string) => {
    if (!store[name]) store[name] = new Map();
    return store[name];
  };

  let batchCommitCount = 0;
  let maxBatchOps = 0;
  let reusedBatchAttempt = false;

  const makeDocRef = (colName: string, docId: string): any => ({
    id: docId,
    path: `${colName}/${docId}`,
    _colName: colName,
    get: async () => {
      const data = ensureCol(colName).get(docId);
      return {
        id: docId,
        exists: data !== undefined,
        data: () => (data !== undefined ? structuredClone(data) : undefined),
      };
    },
    set: async (data: any, opts?: { merge?: boolean }) => {
      const col = ensureCol(colName);
      if (opts?.merge && col.has(docId)) {
        col.set(docId, { ...col.get(docId), ...structuredClone(data) });
      } else {
        col.set(docId, structuredClone(data));
      }
    },
    update: async (data: any) => {
      const col = ensureCol(colName);
      if (!col.has(docId)) throw new Error(`Missing doc ${colName}/${docId}`);
      col.set(docId, { ...col.get(docId), ...structuredClone(data) });
    },
    delete: async () => {
      ensureCol(colName).delete(docId);
    },
    collection: (sub: string) => makeColRef(`${colName}/${docId}/${sub}`),
  });

  const makeQuery = (colName: string, filters: Array<{ field: string; op: string; val: any }> = []): any => ({
    where: (field: string, op: string, val: any) => makeQuery(colName, [...filters, { field, op, val }]),
    orderBy: () => makeQuery(colName, filters),
    limit: () => makeQuery(colName, filters),
    get: async () => {
      const col = ensureCol(colName);
      const docs: any[] = [];
      for (const [id, data] of col.entries()) {
        const matches = filters.every((f) => {
          if (f.op === "==") return data?.[f.field] === f.val;
          if (f.op === "in" && Array.isArray(f.val)) return f.val.includes(data?.[f.field]);
          return true;
        });
        if (matches) {
          docs.push({
            id,
            exists: true,
            ref: makeDocRef(colName, id),
            data: () => structuredClone(data),
          });
        }
      }
      return { docs, empty: docs.length === 0, size: docs.length, forEach: (fn: any) => docs.forEach(fn) };
    },
  });

  const makeColRef = (colName: string): any => ({
    doc: (id?: string) => makeDocRef(colName, id || `auto_${Math.random().toString(36).slice(2, 10)}`),
    add: async (data: any) => {
      const id = `auto_${Math.random().toString(36).slice(2, 10)}`;
      ensureCol(colName).set(id, structuredClone(data));
      return makeDocRef(colName, id);
    },
    where: (field: string, op: string, val: any) => makeQuery(colName, [{ field, op, val }]),
    orderBy: () => makeQuery(colName, []),
    limit: () => makeQuery(colName, []),
    get: async () => makeQuery(colName, []).get(),
  });

  const db: any = {
    collection: (name: string) => makeColRef(name),
    batch: () => {
      let committed = false;
      const ops: Array<() => void> = [];
      const b = {
        set: (ref: any, data: any, opts?: { merge?: boolean }) => {
          if (committed) reusedBatchAttempt = true;
          ops.push(() => {
            const col = ensureCol(ref._colName);
            if (opts?.merge && col.has(ref.id)) {
              col.set(ref.id, { ...col.get(ref.id), ...structuredClone(data) });
            } else {
              col.set(ref.id, structuredClone(data));
            }
          });
          return b;
        },
        update: (ref: any, data: any) => {
          if (committed) reusedBatchAttempt = true;
          ops.push(() => {
            const col = ensureCol(ref._colName);
            col.set(ref.id, { ...(col.get(ref.id) || {}), ...structuredClone(data) });
          });
          return b;
        },
        delete: (ref: any) => {
          if (committed) reusedBatchAttempt = true;
          ops.push(() => {
            ensureCol(ref._colName).delete(ref.id);
          });
          return b;
        },
        commit: async () => {
          if (committed) reusedBatchAttempt = true;
          committed = true;
          batchCommitCount += 1;
          if (ops.length > maxBatchOps) maxBatchOps = ops.length;
          ops.forEach((fn) => fn());
        },
      };
      return b;
    },
    runTransaction: async (fn: (tx: any) => Promise<any>) => {
      const tx = {
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: { merge?: boolean }) => {
          const col = ensureCol(ref._colName);
          if (opts?.merge && col.has(ref.id)) {
            col.set(ref.id, { ...col.get(ref.id), ...structuredClone(data) });
          } else {
            col.set(ref.id, structuredClone(data));
          }
        },
        update: (ref: any, data: any) => {
          const col = ensureCol(ref._colName);
          col.set(ref.id, { ...(col.get(ref.id) || {}), ...structuredClone(data) });
        },
        delete: (ref: any) => {
          ensureCol(ref._colName).delete(ref.id);
        },
      };
      return fn(tx);
    },
    _store: store,
    _stats: () => ({ batchCommitCount, maxBatchOps, reusedBatchAttempt }),
  };

  return db;
}

describe("Batch 12 — Public Projections, Property Passports, Profiles & Ads Hardening", () => {
  beforeEach(() => {
    clearAdEventDedupCacheForTests();
  });

  it("AT-PROJ-01 & AT-PROJ-02: excludes private direct 1-to-1 jobs, retracts newly ineligible cards, and chunks write batches cleanly (>450 ops)", async () => {
    const jobs: Record<string, any> = {};
    for (let i = 0; i < 470; i++) {
      jobs[`job_${i}`] = {
        title: `Boiler service #${i}`,
        description: "Annual check",
        category: "Gas & Heating",
        status: "open",
        postcode: "M14 5TP",
        city: "Manchester",
        isDirectJob: false,
      };
    }
    jobs["direct_private_job"] = {
      title: "Private direct job",
      description: "Only for one trader",
      category: "Plumbing",
      status: "open",
      postcode: "SW1A 1AA",
      isDirectJob: true,
      directTraderId: "trader-1",
    };

    const db = createInMemoryFirestore({
      jobs,
      public_job_cards: {
        direct_private_job: { id: "direct_private_job", title: "Stale leaked direct job" },
        orphan_deleted_job: { id: "orphan_deleted_job", title: "Deleted source job" },
      },
    });

    expect(isJobEligibleForPublicCard(jobs["direct_private_job"])).toBe(false);
    expect(isJobEligibleForPublicCard(jobs["job_0"])).toBe(true);

    const result = await backfillPublicJobCards(db);
    expect(result.synced).toBe(470);
    expect(result.retracted).toBe(2);
    expect(db._store.public_job_cards.has("direct_private_job")).toBe(false);
    expect(db._store.public_job_cards.has("orphan_deleted_job")).toBe(false);
    expect(db._store.public_job_cards.size).toBe(470);

    const stats = db._stats();
    expect(stats.reusedBatchAttempt).toBe(false);
    expect(stats.batchCommitCount).toBeGreaterThanOrEqual(2);
    expect(stats.maxBatchOps).toBeLessThanOrEqual(450);
  });

  it("AT-JOB-PUB-01 & AT-JOB-PUB-02: coarse-grains location server-side and strips UK street addresses, flat numbers, postcodes, phones, and emails from title & description", () => {
    const card = sanitizeJobToPublicCard("job-1", {
      title: "Leak at Flat 4B, 22 Baker Street NW1 6XE",
      description: "Call 07700 900123 or email owner@example.com. Meet at 14 High Street or Victoria Avenue near M14 5TP.",
      area: "22 Baker Street, Flat 4B, London NW1 6XE",
      postcode: "NW1 6XE",
      city: "London",
      category: "Plumbing",
      status: "open",
    });

    expect(card.area).toBe("NW1 • London");
    expect(card.postcodeArea).toBe("NW1");
    expect(card.title).not.toContain("Baker Street");
    expect(card.title).not.toContain("Flat 4B");
    expect(card.title).not.toContain("NW1 6XE");
    expect(card.description).not.toContain("07700 900123");
    expect(card.description).not.toContain("owner@example.com");
    expect(card.description).not.toContain("14 High Street");
    expect(card.description).not.toContain("Victoria Avenue");
    expect(card.description).not.toContain("M14 5TP");
    expect(sanitizePublicDescription("Apt 12, 88 Oxford Road")).toContain("[Address Redacted]");
  });

  it("AT-PASS-01: filters retracted and superseded condition observations out of authoritative Property Passport builds", async () => {
    const db = createInMemoryFirestore({
      properties: {
        prop1: {
          ownerId: "owner-1",
          name: "Oak Villa",
          propertyType: "residential",
          postcode: "M14 5TP",
          city: "Manchester",
        },
      },
      property_condition_history: {
        obs_active: {
          propertyId: "prop1",
          componentType: "roof",
          condition: "good",
          status: "active",
          evidenceIds: ["ev_1"],
          observedAt: "2026-09-01T10:00:00Z",
        },
        obs_retracted_flag: {
          propertyId: "prop1",
          componentType: "boiler",
          condition: "critical",
          retracted: true,
          evidenceIds: ["ev_2"],
          observedAt: "2026-08-01T10:00:00Z",
        },
        obs_superseded_by_newer: {
          propertyId: "prop1",
          componentType: "electrical",
          condition: "poor",
          evidenceIds: ["ev_3"],
          observedAt: "2026-07-01T10:00:00Z",
        },
        obs_newer_replacement: {
          propertyId: "prop1",
          componentType: "electrical",
          condition: "excellent",
          supersedesConditionId: "obs_superseded_by_newer",
          evidenceIds: ["ev_4"],
          observedAt: "2026-09-10T10:00:00Z",
        },
        obs_in_retraction_collection: {
          propertyId: "prop1",
          componentType: "plumbing",
          condition: "critical",
          evidenceIds: ["ev_5"],
          observedAt: "2026-06-01T10:00:00Z",
        },
      },
      property_condition_retractions: {
        ret1: {
          propertyId: "prop1",
          conditionId: "obs_in_retraction_collection",
          reason: "Entered in error",
        },
      },
    });

    const service = new PropertyPassportService({ firestoreDb: db });
    const passport = await service.generatePropertyPassport({
      propertyId: "prop1",
      provenance: { tenantId: "owner-1", triggerSource: "manual" } as any,
    });

    expect(passport.conditionSummary.length).toBe(2);
    expect(passport.provenance.sourceRecordIds).toContain("obs_active");
    expect(passport.provenance.sourceRecordIds).toContain("obs_newer_replacement");
    expect(passport.provenance.sourceRecordIds).not.toContain("obs_retracted_flag");
    expect(passport.provenance.sourceRecordIds).not.toContain("obs_superseded_by_newer");
    expect(passport.provenance.sourceRecordIds).not.toContain("obs_in_retraction_collection");
  });

  it("AT-PASS-03, AT-PASS-05, AT-PASS-07, AT-PROP-08: requires explicit publicConsent === true, retracts revoked passports on backfill, and avoids synthetic C/Good/Standard defaults", async () => {
    expect(isPropertyEligibleForPublicPassport({ isPublicPassport: true })).toBe(false);
    expect(isPropertyEligibleForPublicPassport({ isPublicPassport: true, publicConsent: false })).toBe(false);
    expect(isPropertyEligibleForPublicPassport({ isPublicPassport: true, publicConsent: true, status: "archived" })).toBe(false);
    expect(isPropertyEligibleForPublicPassport({ isPublicPassport: true, publicConsent: true })).toBe(true);

    const sanitized = sanitizePropertyToPublicPassport("p1", {
      name: "Test House",
      postcode: "LS1 4AP",
      city: "Leeds",
      isPublicPassport: true,
      publicConsent: true,
    });
    expect(sanitized.epcRating).toBeNull();
    expect(sanitized.roofCondition).toBeNull();
    expect(sanitized.boilerInfo).toBeNull();

    const db = createInMemoryFirestore({
      properties: {
        p_consented: { name: "Consented", isPublicPassport: true, publicConsent: true, postcode: "LS1 4AP" },
        p_revoked: { name: "Revoked", isPublicPassport: true, publicConsent: false, postcode: "LS1 4AP" },
      },
      public_properties: {
        p_revoked: { id: "p_revoked", name: "Stale Public Projection" },
        p_deleted: { id: "p_deleted", name: "Deleted Property" },
      },
    });

    const result = await backfillPublicProperties(db);
    expect(result.synced).toBe(1);
    expect(result.retracted).toBe(2);
    expect(db._store.public_properties.has("p_consented")).toBe(true);
    expect(db._store.public_properties.has("p_revoked")).toBe(false);
    expect(db._store.public_properties.has("p_deleted")).toBe(false);
  });

  it("AT-PROFILE-03 & AT-ACCOUNT-03: enforces strict non-PII public_profiles allowlist and atomic verification projection sync", async () => {
    const sanitized = sanitizePublicProfilePayload({
      name: "Sam Spark",
      trades: ["Electrical"],
      acceptingNewWork: false,
      email: "private@example.com",
      phone: "07700900123",
      stripeAccountId: "acct_secret",
      bankDetails: { sortCode: "00-00-00" },
      address: "10 Downing Street",
    });

    expect(sanitized.name).toBe("Sam Spark");
    expect(sanitized.acceptingNewWork).toBe(false);
    for (const forbidden of PUBLIC_PROFILE_FORBIDDEN_PII_KEYS) {
      expect(sanitized).not.toHaveProperty(forbidden);
    }

    const db = createInMemoryFirestore({
      users: {
        trader_1: {
          name: "Sam Spark",
          role: "tradesperson",
          email: "private@example.com",
          phone: "07700900123",
          trades: ["Electrical"],
          verificationStatus: "pending",
        },
      },
    });

    const res = await verifyTraderAccountWithProjection({
      db,
      adminUid: "admin_1",
      adminEmail: "admin@anytrader.co.uk",
      targetUid: "trader_1",
      verificationStatus: "verified",
      reason: "Checked NICEIC",
    });
    expect(res.verificationStatus).toBe("verified");
    expect(res.publicProfileSynced).toBe(true);
    expect(db._store.users.get("trader_1").verificationStatus).toBe("verified");
    expect(db._store.public_profiles.get("trader_1").verificationStatus).toBe("verified");
    expect(db._store.public_profiles.get("trader_1").isVerified).toBe(true);
    expect(db._store.public_profiles.get("trader_1").email).toBeUndefined();
    expect(db._store.admin_audit_logs.size).toBe(1);

    const proj = buildSanitizedPublicProfileProjection("trader_1", {
      name: "Sam Spark",
      role: "tradesperson",
      email: "leak@example.com",
      phone: "07000000000",
      trades: ["Electrical"],
    });
    expect(proj).not.toBeNull();
    expect(proj?.email).toBeUndefined();
    expect(proj?.phone).toBeUndefined();
  });

  it("AT-PROFILE-02 & AT-PROFILE-04: Profile Coach respects persisted ack/dismiss state and labels conversion copy as illustrative benchmarks", async () => {
    const profile = {
      uid: "trader_coach_1",
      role: "trader",
      name: "Alex Plumber",
      trades: ["Plumbing"],
      services: [],
      bio: "Short bio",
    };

    const firstAudit = await auditProfileAndAccountReadiness(profile, true, {
      acknowledgedSuggestionIds: ["sug_bio_short"],
      dismissedSuggestionIds: ["sug_skills_gap"],
      lastAuditedAt: new Date().toISOString(),
    });

    expect(firstAudit.suggestions.some((s) => s.id === "sug_skills_gap")).toBe(false);
    const bioSug = firstAudit.suggestions.find((s) => s.id === "sug_bio_short");
    expect(bioSug?.isApplied).toBe(true);

    const photoSug = firstAudit.suggestions.find((s) => s.id === "sug_portfolio_photos");
    expect(photoSug?.description.toLowerCase()).toContain("illustrative platform benchmark");
    expect(photoSug?.description).not.toContain("up to 3x");
  });

  it("AT-ACCOUNT-02 & AT-ADS-06: TradeBot excludes traders not accepting new work and only labels Slot 1 as Featured Partner for active paid placements", async () => {
    const organicPool: any[] = [
      {
        uid: "paused_elec",
        name: "Paused Electrician",
        trade: "Electrical",
        trades: ["Electrical"],
        postcode: "M14 5TP",
        rating: 5.0,
        reviewsCount: 999,
        isVerified: true,
        verificationStatus: "verified",
        acceptingNewWork: false,
      },
      {
        uid: "organic_elec",
        name: "Organic Electrician",
        trade: "Electrical",
        trades: ["Electrical"],
        postcode: "M14 5TP",
        rating: 5.0,
        reviewsCount: 950,
        isVerified: true,
        verificationStatus: "verified",
        subscriptionType: "pro",
        acceptingNewWork: true,
      },
    ];

    const organicRecs = await getHybridTraderRecommendations(["Electrical"], "M14", organicPool, "need electrician");
    expect(organicRecs.length).toBeGreaterThan(0);
    expect(organicRecs.some((r) => r.uid === "paused_elec")).toBe(false);
    expect(organicRecs.every((r) => r.isSponsored === false)).toBe(true);
    expect(organicRecs[0]?.badges[0]).toBe("✓ Top Verified Match");

    const paidPool: any[] = [
      ...organicPool,
      {
        uid: "paid_elec",
        name: "Paid Partner Electrician",
        trade: "Electrical",
        trades: ["Electrical"],
        postcode: "M14 5TP",
        rating: 4.9,
        reviewsCount: 400,
        isVerified: true,
        verificationStatus: "verified",
        hasActivePaidAd: true,
        acceptingNewWork: true,
      },
    ];

    const paidRecs = await getHybridTraderRecommendations(["Electrical"], "M14", paidPool, "need electrician");
    expect(paidRecs[0]?.uid).toBe("paid_elec");
    expect(paidRecs[0]?.isSponsored).toBe(true);
    expect(paidRecs[0]?.badges[0]).toBe("⚡ Featured Partner");
  });

  it("AT-ADS-12: computes real Haversine geodesic distance for promoted ad radius placement", () => {
    const manchester = resolvePostcodeCentroid("M14 5TP");
    const london = resolvePostcodeCentroid("SW1A 1AA");
    expect(manchester).not.toBeNull();
    expect(london).not.toBeNull();

    const miles = computeGeodesicDistanceMiles({ coords: manchester! }, { coords: london! });
    expect(miles).not.toBeNull();
    expect(miles!).toBeGreaterThan(150);
    expect(miles!).toBeLessThan(185);

    expect(
      isWithinAdRadiusMiles({ promotionRadius: 10, traderPostcode: "M14 5TP", searchPostcode: "SW1A 1AA" }).withinRadius
    ).toBe(false);
    expect(
      isWithinAdRadiusMiles({ promotionRadius: 15, traderPostcode: "M14 5TP", searchPostcode: "SK1 1AA" }).withinRadius
    ).toBe(true);
    expect(
      isWithinAdRadiusMiles({ promotionRadius: "nationwide", traderPostcode: "M14 5TP", searchPostcode: "EH1 1AA" }).withinRadius
    ).toBe(true);
    expect(extractExplicitGeoPoint({ latitude: 53.48, longitude: -2.24 })).toEqual({ lat: 53.48, lng: -2.24 });
  });

  it("AT-ADS-05, AT-ADS-11 & AT-ADS-13: sanitizes public_ads without sensitive fields, throttles duplicate click/impression abuse, sends low-balance alerts, and enforces saved-card & monthly-cap gating on Smart Auto Top-Up", async () => {
    const rawAd = {
      advertiserUid: "trader_99",
      advertiserId: "trader_99",
      advertiserName: "Spark Pro",
      targetProfileId: "trader_99",
      url: "/profile/trader_99",
      title: "24/7 Emergency Spark",
      description: "Fast electrical fault finding",
      type: "trader_promo",
      placement: "both",
      promotionRadius: "15",
      approvalStatus: "approved",
      isActive: true,
      billingCycle: "prepaid",
      prepaidBalance: 100,
      totalBudget: 250,
      costPerDisplay: 0.7,
      autoTopUpEnabled: true,
      autoTopUpAmount: 50,
      autoTopUpMaxMonthlyCapGbp: 250,
    };

    expect(isAdEligibleForPublicProjection(rawAd)).toBe(true);
    const pubAd = sanitizeAdToPublicAd("ad_1", rawAd);
    expect(pubAd.targetProfileId).toBe("trader_99");
    expect(pubAd.hasAvailableBudget).toBe(true);
    expect((pubAd as any).advertiserUid).toBeUndefined();
    expect((pubAd as any).prepaidBalance).toBeUndefined();
    expect((pubAd as any).totalBudget).toBeUndefined();
    expect((pubAd as any).costPerDisplay).toBeUndefined();
    expect((pubAd as any).autoTopUpEnabled).toBeUndefined();

    const db = createInMemoryFirestore({
      users: {
        trader_99: {
          name: "Spark Pro",
          role: "tradesperson",
          subscriptionType: "pro",
          postcode: "M14 5TP",
          stripeCustomerId: "cus_123",
          defaultPaymentMethodId: "pm_123",
        },
        trader_no_card: {
          name: "No Card Trader",
          role: "tradesperson",
          subscriptionType: "free",
        },
      },
      advertisements: {
        ad_low: {
          ...rawAd,
          prepaidBalance: 10.2,
          costPerDisplay: 0.7,
          lowBalanceAlertsEnabled: true,
          autoTopUpEnabled: true,
          autoTopUpThreshold: 10,
          autoTopUpAmount: 50,
          autoTopUpMaxMonthlyCapGbp: 100,
          autoTopUpMonthlySpentGbp: 0,
          autoTopUpMonthKey: new Date().toISOString().slice(0, 7),
          clicks: 0,
          searchFeedClicks: 0,
          impressions: 0,
        },
      },
    });

    // Server-side CPC creation rejects autoTopUpEnabled when user has no saved card
    await expect(
      createCpcCampaignCommand({
        db,
        authUid: "trader_no_card",
        title: "No Card Ad",
        description: "Test",
        totalBudget: 50,
        autoTopUpEnabled: true,
      })
    ).rejects.toThrow(/saved off-session payment method/i);

    // Backfill public_ads populates sanitized public projection
    const adBackfill = await backfillPublicAds(db);
    expect(adBackfill.synced).toBe(1);
    expect(db._store.public_ads.has("ad_low")).toBe(true);
    expect(db._store.public_ads.get("ad_low").advertiserUid).toBeUndefined();

    // Track click drops balance below £10 threshold -> sends low-balance notification
    const click1 = await trackSponsoredAdEventCommand({
      db,
      adId: "ad_low",
      eventType: "click",
      placement: "search_feed",
      viewerFingerprint: "viewer_abc",
    });
    expect(click1.tracked).toBe(true);
    expect(click1.remainingBalance).toBe(9.5);
    expect(click1.lowBalanceAlertTriggered).toBe(true);
    expect(db._store.notifications.size).toBe(1);
    expect(db._store.public_ads.has("ad_low")).toBe(true);

    // Duplicate click from same viewer fingerprint inside dedup window is throttled
    const click2 = await trackSponsoredAdEventCommand({
      db,
      adId: "ad_low",
      eventType: "click",
      placement: "search_feed",
      viewerFingerprint: "viewer_abc",
    });
    expect(click2.tracked).toBe(false);
    expect(click2.reason).toBe("duplicate_throttled");
    expect(db._store.advertisements.get("ad_low").clicks).toBe(1);

    // Auto Top-Up with mock Stripe client succeeds once, then stops when monthly cap reached
    const mockStripe: any = {
      paymentIntents: {
        create: vi.fn().mockResolvedValue({ id: "pi_auto_1", status: "succeeded" }),
      },
    };
    const autoRes = await processAdAutoTopUpCommand({
      db,
      adId: "ad_low",
      stripeClient: mockStripe,
    });
    expect(autoRes.status).toBe("charged");
    expect(autoRes.newPrepaidBalance).toBe(59.5);
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(1);

    // Lower balance again and set monthly spent to cap -> skips cleanly
    db._store.advertisements.get("ad_low").prepaidBalance = 5;
    db._store.advertisements.get("ad_low").autoTopUpMonthlySpentGbp = 100;
    const capRes = await processAdAutoTopUpCommand({
      db,
      adId: "ad_low",
      stripeClient: mockStripe,
    });
    expect(capRes.status).toBe("skipped_monthly_cap_reached");

    // Disable auto top-up via command
    const toggleRes = await updateAdAutoTopUpSettingsCommand({
      db,
      authUid: "trader_99",
      adId: "ad_low",
      autoTopUpEnabled: false,
    });
    expect(toggleRes.autoTopUpEnabled).toBe(false);

    // Backfill public_ads removes inactive/unapproved ads
    db._store.public_ads.set("stale_ad", { id: "stale_ad", title: "Stale" });
    const syncedAds = await backfillPublicAds(db);
    expect(syncedAds.synced).toBe(1);
    expect(syncedAds.retracted).toBe(1);
    expect(db._store.public_ads.has("stale_ad")).toBe(false);
  });

  it("AT-PASS-02, AT-PASS-06, AT-PASS-08, AT-PROP-07, AT-PROJ-03, AT-TENANT-02, AT-PROFILE-01, AT-PROP-UI-01: verifies server routes & Firestore rules enforce fail-closed controls", () => {
    const serverSrc = fs.readFileSync(path.resolve("server.ts"), "utf8");
    const rulesSrc = fs.readFileSync(path.resolve("firestore.rules"), "utf8");
    const coachUiSrc = fs.readFileSync(path.resolve("src/components/AiProfileOptimizerSection.tsx"), "utf8");
    const propMgrSrc = fs.readFileSync(path.resolve("src/components/PropertyManager.tsx"), "utf8");
    const tenantUiSrc = fs.readFileSync(path.resolve("src/components/TenantReportPortal.tsx"), "utf8");

    // Server endpoints & fail-closed checks
    expect(serverSrc).toContain('"/api/properties/:id/public-passport"');
    expect(serverSrc).toContain('"/api/tenant-issues"');
    expect(serverSrc).toContain('"/api/profile/coach/state"');
    expect(serverSrc).toContain('"/api/profile/coach/acknowledge"');
    expect(serverSrc).toContain('"/api/admin/traders/:uid/verify"');
    expect(serverSrc).toContain('"/api/ads/create-cpc"');
    expect(serverSrc).toContain('"/api/ads/:id/auto-topup-settings"');
    expect(serverSrc).toContain('"/api/ads/:id/process-auto-topup"');
    expect(serverSrc).toContain("payloadHash");
    expect(serverSrc).toContain("transferExpiresAt");
    expect(serverSrc).toContain("publicConsent");

    // Firestore rules hardening
    expect(rulesSrc).toContain("match /public_ads/{adId}");
    expect(rulesSrc).toContain("match /profile_coach_state/{stateId}");
    expect(rulesSrc).toMatch(/match \/tenant_issues\/\{issueId\}[\s\S]*allow create: if false;/);
    expect(rulesSrc).toMatch(/match \/public_profiles\/\{userId\}[\s\S]*hasOnly\(/);
    expect(rulesSrc).not.toContain("hasOnly(['clicks', 'searchFeedClicks', 'bannerClicks', 'impressions', 'prepaidBalance', 'isActive', 'updatedAt'])");

    // UI verification
    expect(coachUiSrc).toContain("Confirm Your Qualifications & Scope of Work");
    expect(propMgrSrc).not.toContain("Step {step} of 3");
    expect(propMgrSrc).toContain('type="file"');
    expect(tenantUiSrc).toContain('fetch("/api/tenant-issues"');
  });
});
