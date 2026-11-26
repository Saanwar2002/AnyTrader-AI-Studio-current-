/**
 * AnyTrader Intelligent Matching Engine Wrapper
 *
 * Delegates all scoring, distance math, category alignment, certification checks,
 * and behavioral velocity directly to the single canonical unified engine
 * (`src/lib/unifiedJobMatching.ts`), enriched with read-only category metadata
 * from `fuzzyMatch.ts` and `categoryRegistrySync.ts`.
 *
 * Exports TWO purpose-built honest scores:
 * 1. `calculateTraderMatchScore(trader, job)` — Homeowner-facing & dispatch trader rank score
 * 2. `calculateJobFitForTrader(trader, job)` — Trader-facing Job Feed & Dashboard opportunity fit score
 */

import { getCategoryMetadata } from "../lib/fuzzyMatch.ts";
import { categoryRegistry } from "./categoryRegistrySync.ts";
import {
  scoreJobFitForTrader,
  scoreTraderForJob,
  type UnifiedMatchFactor,
  type UnifiedMatchResult,
} from "../lib/unifiedJobMatching.ts";

export type MatchFactor = UnifiedMatchFactor;
export type MatchEngineResult = UnifiedMatchResult;

function resolveCategoryTerms(category: string | undefined): {
  categorySynonyms: string[];
  categoryRelatedTerms: string[];
} {
  if (!category || typeof category !== "string") {
    return { categorySynonyms: [], categoryRelatedTerms: [] };
  }
  const meta = getCategoryMetadata(category);
  const reg = categoryRegistry.getCategoryByName(category);
  const categorySynonyms = Array.from(
    new Set([...(meta?.synonyms || []), ...(reg?.synonyms || [])])
  ).filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  const categoryRelatedTerms = Array.from(
    new Set([
      ...(meta?.related_terms || []),
      ...(reg?.related_terms || []),
      ...(reg?.relatedTerms || []),
    ])
  ).filter((s): s is string => typeof s === "string" && s.trim().length > 0);

  return { categorySynonyms, categoryRelatedTerms };
}

/**
 * Homeowner-facing & Quote-Comparison Trader Match Score (0-100).
 * Uses real geodesic/postcode-centroid distance, totalReviews, verified video status,
 * compliance/certification checks, and real behavioral velocity (zero fake constants).
 */
export function calculateTraderMatchScore(
  trader: any,
  job: any,
  options?: {
    explicitTraderCoords?: { lat: number; lng: number } | null;
    mode?: "strict" | "relaxed";
  }
): MatchEngineResult {
  const { categorySynonyms, categoryRelatedTerms } = resolveCategoryTerms(job?.category);
  return scoreTraderForJob(trader, job, {
    explicitTraderCoords: options?.explicitTraderCoords,
    categorySynonyms,
    categoryRelatedTerms,
    mode: options?.mode || "strict",
  });
}

/**
 * Trader-facing Job Fit Score (0-100) for Job Feed & TradesDashboard.
 * Every dimension differentiates Job A vs Job B for the logged-in tradesperson:
 * Trade/Subcategory (35%), Geodesic Distance vs Radius (30%), Calendar Availability (15%),
 * Urgency/Emergency Fit (10%), and Quote Competition / Brief Quality (10%).
 */
export function calculateJobFitForTrader(
  trader: any,
  job: any,
  options?: {
    explicitTraderCoords?: { lat: number; lng: number } | null;
    mode?: "strict" | "relaxed";
    nowMs?: number;
  }
): MatchEngineResult {
  const { categorySynonyms, categoryRelatedTerms } = resolveCategoryTerms(job?.category);
  return scoreJobFitForTrader(trader, job, {
    explicitTraderCoords: options?.explicitTraderCoords,
    categorySynonyms,
    categoryRelatedTerms,
    mode: options?.mode || "relaxed",
    nowMs: options?.nowMs,
  });
}
