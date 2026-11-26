import { describe, it, expect } from "vitest";
import {
  computeJobTraderDistance,
  evaluateCategoryAlignment,
  evaluateCertificationEligibility,
  evaluateGeographicFit,
  extractJobDate,
  extractJobPostcode,
  extractJobSubCategory,
  isTraderCalendarAvailableForDate,
  isTraderInQuietHours,
  scoreJobFitForTrader,
  scoreTraderForJob,
} from "../../src/lib/unifiedJobMatching.ts";
import { sanitizeJobToPublicCard } from "../../src/server/projectionSync.ts";
import { calculateJobFitForTrader, calculateTraderMatchScore } from "../../src/services/matchingEngine.ts";
import {
  distributeJobLeadsAuthoritative,
  evaluateLeadRecipient,
  expandLowQuoteJobsWave2,
  filterEligibleLeadRecipients,
} from "../../src/server/leadDistribution.ts";
import {
  evaluateInstantMatchCandidate,
  respondToInstantMatchAttempt,
} from "../../src/server/instantMatchEligibility.ts";
import {
  advanceInstantMatchAfterDecline,
  selectNextInstantMatchCandidate,
} from "../../instantMatchWorker.ts";

function createInMemoryDb(seed: Record<string, Record<string, any>> = {}) {
  const store: Record<string, Record<string, any>> = {};
  for (const [k, v] of Object.entries(seed)) {
    store[k] = JSON.parse(JSON.stringify(v));
  }
  let autoId = 0;

  const buildCollection = (basePath: string): any => {
    const col: any = {
      doc: (docId?: string) => {
        const id = docId || `auto_${++autoId}`;
        const fullPath = `${basePath}/${id}`;
        const ref: any = {
          id,
          path: fullPath,
          get: async () => ({
            exists: store[fullPath] !== undefined,
            id,
            ref,
            data: () => (store[fullPath] ? JSON.parse(JSON.stringify(store[fullPath])) : undefined),
          }),
          set: async (data: any, opts?: { merge?: boolean }) => {
            if (opts?.merge && store[fullPath]) {
              store[fullPath] = { ...store[fullPath], ...JSON.parse(JSON.stringify(data)) };
            } else {
              store[fullPath] = JSON.parse(JSON.stringify(data));
            }
          },
          update: async (data: any) => {
            if (!store[fullPath]) throw new Error(`Missing doc ${fullPath}`);
            store[fullPath] = { ...store[fullPath], ...JSON.parse(JSON.stringify(data)) };
          },
          delete: async () => {
            delete store[fullPath];
          },
          collection: (sub: string) => buildCollection(`${fullPath}/${sub}`),
        };
        return ref;
      },
      where: (field: string, op: string, value: any) => {
        const filters = [{ field, op, value }];
        const buildQuery = (currentFilters: Array<{ field: string; op: string; value: any }>): any => ({
          where: (f2: string, o2: string, v2: any) => buildQuery([...currentFilters, { field: f2, op: o2, value: v2 }]),
          limit: () => buildQuery(currentFilters),
          get: async () => {
            const prefix = `${basePath}/`;
            const docs = Object.entries(store)
              .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
              .filter(([, data]) =>
                currentFilters.every((flt) => {
                  if (flt.op === "==") return data[flt.field] === flt.value;
                  if (flt.op === "in") return Array.isArray(flt.value) && flt.value.includes(data[flt.field]);
                  if (flt.op === "array-contains") return Array.isArray(data[flt.field]) && data[flt.field].includes(flt.value);
                  return true;
                })
              )
              .map(([k, data]) => {
                const id = k.slice(prefix.length);
                return { id, ref: buildCollection(basePath).doc(id), data: () => JSON.parse(JSON.stringify(data)) };
              });
            return { empty: docs.length === 0, size: docs.length, docs };
          },
        });
        return buildQuery(filters);
      },
      limit: () => col,
      get: async () => {
        const prefix = `${basePath}/`;
        const docs = Object.entries(store)
          .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
          .map(([k, data]) => {
            const id = k.slice(prefix.length);
            return { id, ref: buildCollection(basePath).doc(id), data: () => JSON.parse(JSON.stringify(data)) };
          });
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    };
    return col;
  };

  return {
    _store: store,
    collection: (name: string) => buildCollection(name),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        set: (ref: any, data: any, opts?: any) => {
          ops.push(() => {
            if (opts?.merge && store[ref.path]) {
              store[ref.path] = { ...store[ref.path], ...JSON.parse(JSON.stringify(data)) };
            } else {
              store[ref.path] = JSON.parse(JSON.stringify(data));
            }
          });
        },
        update: (ref: any, data: any) => {
          ops.push(() => {
            store[ref.path] = { ...(store[ref.path] || {}), ...JSON.parse(JSON.stringify(data)) };
          });
        },
        delete: (ref: any) => {
          ops.push(() => {
            delete store[ref.path];
          });
        },
        commit: async () => {
          for (const op of ops) op();
        },
      };
    },
    runTransaction: async (fn: (tx: any) => Promise<any>) => {
      const tx = {
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        create: (ref: any, data: any) => {
          if (store[ref.path]) throw new Error(`Already exists: ${ref.path}`);
          store[ref.path] = JSON.parse(JSON.stringify(data));
        },
        update: (ref: any, data: any) => ref.update(data),
        delete: (ref: any) => ref.delete(),
      };
      return fn(tx);
    },
  };
}

describe("Unified AnyTrader Job-to-Trader Matching Engine (All 4 Phases)", () => {
  describe("Phase 1: Public Job Card Schema Normalization & UK Postcode-Centroid Distance", () => {
    it("extracts postcodeArea, subCategory, and preferredDate from sanitized public_job_cards and computes accurate cross-area distance", () => {
      const publicCard = sanitizeJobToPublicCard("job_london_1", {
        title: "Leaking kitchen radiator",
        description: "Pipe dripping behind radiator",
        category: "Plumbing",
        subcategory: "Radiator Repair",
        postcode: "SW1A 1AA",
        city: "London",
        jobDate: "2026-12-10",
        status: "open",
        requiredCertifications: ["Gas Safe"],
      });

      // PII stripped, safe discovery fields preserved
      expect((publicCard as any).postcode).toBeUndefined();
      expect(publicCard.postcodeArea).toBe("SW1A");
      expect(publicCard.subCategory).toBe("Radiator Repair");
      expect(publicCard.preferredDate).toBe("2026-12-10");
      expect(publicCard.requiredCertifications).toEqual(["Gas Safe"]);

      expect(extractJobPostcode(publicCard)).toBe("SW1A");
      expect(extractJobSubCategory(publicCard)).toBe("Radiator Repair");
      expect(extractJobDate(publicCard)).toBe("2026-12-10");

      // Cross-area London proximity: SW1A -> SE1 is ~5.8 mi (centroid), NOT rejected by naive SW !== SE!
      const se1Trader = { postcode: "SE1 7PB", coverageRadiusMiles: 10 };
      const se1Geo = evaluateGeographicFit(se1Trader, publicCard);
      expect(se1Geo.withinRadius).toBe(true);
      expect(se1Geo.distanceMiles).not.toBeNull();
      expect(se1Geo.distanceMiles!).toBeLessThan(10);

      // Far-away trader: Manchester M1 -> London SW1A is ~163 mi -> strictly rejected!
      const manchesterTrader = { postcode: "M1 1AE", coverageRadiusMiles: 25 };
      const m1Geo = evaluateGeographicFit(manchesterTrader, publicCard);
      expect(m1Geo.withinRadius).toBe(false);
      expect(m1Geo.distanceMiles!).toBeGreaterThan(140);
      expect(m1Geo.matchType).toBe("out_of_radius");
    });

    it("detects calendar busy/booked dateOverrides and weekly unavailability across preferredDate/jobDate", () => {
      const trader = {
        dateOverrides: { "2026-12-10": "booked", "2026-12-11": "available" },
        availability: { sunday: false, monday: { available: true } },
      };
      expect(isTraderCalendarAvailableForDate(trader, "2026-12-10")).toBe(false);
      expect(isTraderCalendarAvailableForDate(trader, "2026-12-11")).toBe(true);
      // 2026-12-13 is a Sunday
      expect(isTraderCalendarAvailableForDate(trader, "2026-12-13")).toBe(false);
    });
  });

  describe("Phase 1 & 4: Instant Match Geographic Hard Gate & Decline Progression Fix", () => {
    it("strictly rejects out-of-area Gold Video-Verified trader so local London trader wins Instant Match", async () => {
      const londonJob = {
        jobCategory: "Plumbing",
        jobText: "Burst pipe emergency",
        jobPostcode: "SW1A 1AA",
        triedTraderIds: [],
      };

      const farGoldTrader = {
        uid: "t_manchester_gold",
        role: "tradesperson",
        isVerified: true,
        isAvailableForEmergency: true,
        isAvailableForInstantMatch: true,
        videoVerificationStatus: "verified",
        tier: "gold",
        rating: 5.0,
        trades: ["Plumbing"],
        postcode: "M1 1AE",
        coverageRadiusMiles: 25,
      };

      const localSilverTrader = {
        uid: "t_london_local",
        role: "tradesperson",
        isVerified: true,
        isAvailableForEmergency: true,
        isAvailableForInstantMatch: true,
        trades: ["Plumbing"],
        postcode: "SE1 7PB",
        coverageRadiusMiles: 15,
        rating: 4.7,
      };

      const farEval = evaluateInstantMatchCandidate("t_manchester_gold", farGoldTrader, farGoldTrader, {}, londonJob);
      const localEval = evaluateInstantMatchCandidate("t_london_local", localSilverTrader, localSilverTrader, {}, londonJob);

      expect(farEval.eligible).toBe(false);
      expect(farEval.rejectionReason).toBe("out_of_radius");
      expect(localEval.eligible).toBe(true);
      expect(localEval.distanceMiles!).toBeLessThan(15);
    });

    it("immediately advances Instant Match to Candidate #2 when Candidate #1 declines (fixes P0 stall bug)", async () => {
      const db = createInMemoryDb({
        "jobs/job_im_decline": {
          id: "job_im_decline",
          homeownerId: "owner_1",
          category: "Plumbing",
          title: "Burst Pipe",
          postcode: "SW1A 1AA",
          status: "open",
        },
        "instant_matches/im_decline_1": {
          id: "im_decline_1",
          jobId: "job_im_decline",
          status: "searching",
          currentAttempt: 1,
        },
        "instant_match_attempts/im_decline_1_1": {
          id: "im_decline_1_1",
          instantMatchId: "im_decline_1",
          attemptNumber: 1,
          traderId: "trader_1",
          status: "pending",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
        "users/trader_1": {
          uid: "trader_1",
          role: "tradesperson",
          isVerified: true,
          isAvailableForInstantMatch: true,
          isAvailableForEmergency: true,
          trades: ["Plumbing"],
          postcode: "SW1A 1AA",
          rating: 5.0,
        },
        "users/trader_2": {
          uid: "trader_2",
          role: "tradesperson",
          isVerified: true,
          isAvailableForInstantMatch: true,
          isAvailableForEmergency: true,
          trades: ["Plumbing"],
          postcode: "SW1A 2BB",
          rating: 4.8,
          phone: "+447700900111",
        },
        "public_profiles/trader_1": { acceptingNewWork: true, isAvailableForInstantMatch: true },
        "public_profiles/trader_2": { acceptingNewWork: true, isAvailableForInstantMatch: true },
      });

      const declineRes = await respondToInstantMatchAttempt({
        db,
        uid: "trader_1",
        attemptId: "im_decline_1_1",
        action: "decline",
      });

      expect(declineRes.status).toBe("declined");
      expect(db._store["instant_match_attempts/im_decline_1_1"].status).toBe("declined");
      // Parent match document updated to trigger realtime listener
      expect(db._store["instant_matches/im_decline_1"].lastDeclinedAttemptNumber).toBe(1);

      const advRes = await advanceInstantMatchAfterDecline(db, "im_decline_1");
      expect(advRes.action).toBe("created_attempt");
      expect(advRes.attemptNumber).toBe(2);
      expect(db._store["instant_match_attempts/im_decline_1_2"].traderId).toBe("trader_2");
      expect(db._store["instant_matches/im_decline_1"].currentAttempt).toBe(2);

      // Verify SMS alert was enqueued for Candidate #2
      const smsEntries = Object.entries(db._store).filter(([k]) => k.startsWith("sms_queue/"));
      expect(smsEntries.length).toBe(1);
      expect(smsEntries[0][1].toUserId).toBe("trader_2");
    });
  });

  describe("Phase 2 & 4: Ranked Lead Distribution, Priority Exclusive Window, Quiet Hours, Certs & Wave 2", () => {
    it("ranks closest/highest-quality & Priority Exclusive traders ahead of arbitrary FIFO doc-ID order", () => {
      const futureExclusive = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const job = {
        jobId: "job_rank_1",
        ownerId: "homeowner_1",
        category: "Painting & Decorating",
        postcode: "SW1A 1AA",
        exclusiveUntil: futureExclusive,
      };

      const candidates = [
        // Alphabetically FIRST doc ID, but farther away and standard tier
        {
          id: "aaa_far_standard",
          data: {
            role: "tradesperson",
            isVerified: true,
            trades: ["Painting & Decorating"],
            postcode: "KT1 1AA",
            coverageRadiusMiles: 25,
            rating: 4.1,
            totalReviews: 2,
          },
        },
        // Alphabetically LAST doc ID, but closest + fast responder + Priority Exclusive subscriber
        {
          id: "zzz_close_priority",
          data: {
            role: "tradesperson",
            isVerified: true,
            videoVerificationStatus: "verified",
            hasExclusiveAddon: true,
            isExclusiveActive: true,
            trades: ["Painting & Decorating"],
            postcode: "SW1A 2BB",
            coverageRadiusMiles: 20,
            rating: 4.9,
            totalReviews: 25,
            avgResponseMinutes: 10,
          },
        },
      ];

      const ranked = filterEligibleLeadRecipients(candidates, job, 1);
      expect(ranked.length).toBe(1);
      expect(ranked[0].id).toBe("zzz_close_priority");
      expect(ranked[0].isExclusivePriority).toBe(true);
      expect(ranked[0].delayedVisibleAtMs).toBeNull();

      // Standard non-exclusive recipient during exclusive window gets delayedVisibleAtMs set
      const standardEval = evaluateLeadRecipient("aaa_far_standard", candidates[0].data, job);
      expect(standardEval.eligible).toBe(true);
      expect(standardEval.delayedVisibleAtMs).not.toBeNull();
      expect(standardEval.allowImmediatePush).toBe(false);
    });

    it("enforces Quiet Hours, Emergency SMS opt-out, and Regulated Trade Certification Gate", () => {
      // Quiet hours active at 23:00
      const nightMs = new Date("2026-11-24T23:00:00").getTime();
      const quietTrader = {
        role: "tradesperson",
        isVerified: true,
        trades: ["Plumbing"],
        postcode: "SW1A 1AA",
        isAvailableForEmergency: false,
        notificationSettings: { quietHoursEnabled: true, quietHoursStart: "22:00", quietHoursEnd: "07:00" },
      };

      expect(isTraderInQuietHours(quietTrader, new Date(nightMs))).toBe(true);

      const evalQuiet = evaluateLeadRecipient("t_quiet", quietTrader, {
        jobId: "j_emerg",
        ownerId: "owner_1",
        category: "Plumbing",
        postcode: "SW1A 1AA",
        isEmergency: true,
        nowMs: nightMs,
      });
      expect(evalQuiet.eligible).toBe(true);
      expect(evalQuiet.inQuietHours).toBe(true);
      expect(evalQuiet.allowImmediatePush).toBe(false);
      expect(evalQuiet.allowEmergencySms).toBe(false);

      // Regulated category (Electrical) MUST block provisional trader
      const provisionalElectrician = {
        role: "tradesperson",
        verificationStatus: "provisional",
        isVerified: false,
        documentGraceDeadlineAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        provisionalQuotesUsed: 0,
        trades: ["Electrical"],
        postcode: "SW1A 1AA",
      };
      const certResult = evaluateCertificationEligibility(provisionalElectrician, {
        category: "Electrical",
      });
      expect(certResult.eligible).toBe(false);
      expect(certResult.reason).toBe("regulated_trade_requires_verified_trader");

      const leadRegEval = evaluateLeadRecipient("t_prov_elec", provisionalElectrician, {
        jobId: "j_elec",
        ownerId: "owner_1",
        category: "Electrical",
        postcode: "SW1A 1AA",
      });
      expect(leadRegEval.eligible).toBe(false);
    });

    it("executes idempotent Wave 1 distribution and expands radius by +10mi in Wave 2 for low-quote jobs", async () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      const db = createInMemoryDb({
        "jobs/job_wave_1": {
          id: "job_wave_1",
          homeownerId: "owner_1",
          category: "Painting & Decorating",
          title: "Hallway repaint",
          postcode: "SW1A 1AA",
          status: "open",
          quoteCount: 0,
          createdAt: threeHoursAgo,
        },
        "users/trader_close": {
          uid: "trader_close",
          role: "tradesperson",
          isVerified: true,
          trades: ["Painting & Decorating"],
          postcode: "SW1A 2BB",
          coverageRadiusMiles: 5,
        },
        // GU1 (Guildford) is ~23.5 mi from SW centroid — outside 20mi Wave 1, INSIDE 20+10=30mi Wave 2!
        "users/trader_wave2": {
          uid: "trader_wave2",
          role: "tradesperson",
          isVerified: true,
          trades: ["Painting & Decorating"],
          postcode: "GU1 1AA",
          coverageRadiusMiles: 20,
        },
      });

      const wave1 = await distributeJobLeadsAuthoritative({ db, jobId: "job_wave_1", wave: 1 });
      expect(wave1.notifiedCount).toBe(1);
      expect(wave1.recipientIds).toEqual(["trader_close"]);

      // Calling Wave 1 again immediately is idempotent (no duplicate notifications!)
      const wave1Replay = await distributeJobLeadsAuthoritative({ db, jobId: "job_wave_1", wave: 1 });
      expect(wave1Replay.skippedAlreadyDistributed).toBe(true);

      // Wave 2 expands radius by +10mi and reaches trader_wave2 without re-notifying trader_close
      const wave2 = await expandLowQuoteJobsWave2({ db, extraRadiusMiles: 10 });
      expect(wave2.jobsExpanded).toBe(1);
      expect(wave2.totalTradersNotified).toBe(1);
      expect(db._store["jobs/job_wave_1"].notifiedTraderIds).toEqual(["trader_close", "trader_wave2"]);
    });
  });

  describe("Phase 3: Honest Trader-Facing Job Fit vs Homeowner-Facing Trader Rank", () => {
    it("differentiates close/0-quote/free-calendar jobs from far/busy/crowded jobs for the same trader", () => {
      const trader = {
        uid: "t_plumber",
        isVerified: true,
        trades: ["Plumbing"],
        services: ["Boiler Repair"],
        postcode: "SW1A 1AA",
        coverageRadiusMiles: 15,
        dateOverrides: { "2026-12-20": "booked" },
        totalReviews: 18,
        rating: 4.9,
      };

      const greatJob = {
        id: "j_great",
        category: "Plumbing",
        subCategory: "Boiler Repair",
        postcodeArea: "SW1A",
        preferredDate: "2026-12-21",
        quoteCount: 0,
        photosCount: 3,
        estimateMax: 450,
      };

      const poorFitJob = {
        id: "j_poor",
        category: "Plumbing",
        postcodeArea: "M1",
        preferredDate: "2026-12-20",
        quoteCount: 4,
      };

      const unrelatedJob = {
        id: "j_unrelated",
        category: "Roofing",
        postcodeArea: "SW1A",
        quoteCount: 0,
      };

      const greatScore = calculateJobFitForTrader(trader, greatJob);
      const poorScore = calculateJobFitForTrader(trader, poorFitJob);
      const unrelatedScore = calculateJobFitForTrader(trader, unrelatedJob);

      expect(greatScore.compositeScore).toBeGreaterThan(poorScore.compositeScore + 30);
      expect(poorScore.isCalendarConflict).toBe(true);
      expect(unrelatedScore.compositeScore).toBeLessThanOrEqual(10);

      // Homeowner-facing calculateTraderMatchScore reads totalReviews properly and rewards fast responders
      const fastTrader = { ...trader, avgResponseMinutes: 10, videoVerificationStatus: "verified" };
      const slowUnverifiedTrader = {
        ...trader,
        isVerified: false,
        totalReviews: 0,
        rating: 0,
        avgResponseMinutes: 500,
      };
      expect(calculateTraderMatchScore(fastTrader, greatJob).compositeScore).toBeGreaterThan(
        calculateTraderMatchScore(slowUnverifiedTrader, greatJob).compositeScore + 25
      );
    });
  });
});
