/**
 * Multi-word trade category shortlisting engine for onboarding & trade selection.
 *
 * Uses fuzzyMatch.ts's strict front-of-word prefix rules (`tokenize` + `tokenMatches`)
 * so partial inner substrings never cause false positives (e.g. "pet" matches
 * "Pet Sitting" and never "Carpet").
 */

import {
  getCategoryMetadata,
  scoreCategorySearchMatch,
  tokenize,
  tokenMatches,
} from "./fuzzyMatch.ts";

export interface ShortlistableCategory {
  id: string | number;
  name: string;
  icon?: string;
  subcategories?: string[];
  requiredCertifications?: string[];
  synonyms?: string[];
  related_terms?: string[];
  isUrgent?: boolean;
  description?: string;
}

export interface ShortlistedCategoryResult<T extends ShortlistableCategory = ShortlistableCategory> {
  category: T;
  score: number;
  matchedTokenCount: number;
  totalQueryTokens: number;
  matchedSubcategories: string[];
  matchedReasons: string[];
}

const STOP_WORDS = new Set([
  "and",
  "or",
  "the",
  "for",
  "with",
  "my",
  "i",
  "am",
  "a",
  "an",
  "do",
  "does",
  "in",
  "on",
  "of",
  "to",
  "all",
  "work",
  "jobs",
  "job",
  "trade",
  "trades",
  "services",
  "service",
]);

function extractMeaningfulTokens(query: string): string[] {
  const all = tokenize(query);
  const meaningful = all.filter((tok) => tok.length >= 2 && !STOP_WORDS.has(tok));
  return meaningful.length > 0 ? meaningful : all;
}

/**
 * Shortlists and ranks categories matching one or more typed keywords.
 *
 * Example:
 *  - "boiler leak radiator" -> shortlists Gas & Heating / Plumbing ranked first
 *    with matched subcategories/terms shown.
 *  - "pet" -> matches Pet Services, never Carpet.
 *  - Empty query -> returns all categories with score 0 in their original order.
 */
export function shortlistTradeCategories<T extends ShortlistableCategory>(
  categories: T[],
  rawQuery: string
): ShortlistedCategoryResult<T>[] {
  const trimmed = (rawQuery || "").trim();
  if (!trimmed) {
    return categories.map((category) => ({
      category,
      score: 0,
      matchedTokenCount: 0,
      totalQueryTokens: 0,
      matchedSubcategories: [],
      matchedReasons: [],
    }));
  }

  const queryLower = trimmed.toLowerCase();
  const queryTokens = extractMeaningfulTokens(trimmed);
  const results: ShortlistedCategoryResult<T>[] = [];

  for (const category of categories) {
    const baseScore = scoreCategorySearchMatch(category, trimmed);
    const meta = getCategoryMetadata(category.name);

    const nameTokens = tokenize(category.name);
    const certList = category.requiredCertifications || [];
    const subList = category.subcategories || [];
    const synList = [
      ...(category.synonyms || []),
      ...(category.related_terms || []),
      ...(meta?.synonyms || []),
      ...(meta?.related_terms || []),
    ];

    const matchedTokens = new Set<string>();
    const matchedSubcategories: string[] = [];
    const matchedSubSet = new Set<string>();
    const matchedReasons: string[] = [];
    const matchedReasonSet = new Set<string>();

    let tokenScore = 0;

    // Direct phrase match bonuses
    const catNameLower = category.name.toLowerCase();
    if (catNameLower === queryLower) {
      tokenScore += 220;
    } else if (catNameLower.startsWith(queryLower)) {
      tokenScore += 150;
    }

    for (const qTok of queryTokens) {
      let bestHitForToken = 0;

      // 1. Category name match (strongest signal)
      if (nameTokens.some((nt) => tokenMatches(qTok, nt))) {
        bestHitForToken = Math.max(bestHitForToken, 70);
        if (!matchedReasonSet.has(category.name)) {
          matchedReasonSet.add(category.name);
          matchedReasons.push(category.name);
        }
      }

      // 2. Subcategory match (high signal + surfaced in UI pills)
      for (const sub of subList) {
        const subTokens = tokenize(sub);
        if (subTokens.some((st) => tokenMatches(qTok, st))) {
          bestHitForToken = Math.max(bestHitForToken, 55);
          if (!matchedSubSet.has(sub)) {
            matchedSubSet.add(sub);
            matchedSubcategories.push(sub);
          }
        }
      }

      // 3. Synonym & related terms match
      for (const syn of synList) {
        const synTokens = tokenize(syn);
        if (synTokens.some((st) => tokenMatches(qTok, st))) {
          bestHitForToken = Math.max(bestHitForToken, 50);
          const cleanSyn = syn.trim();
          if (cleanSyn && !matchedReasonSet.has(cleanSyn.toLowerCase())) {
            matchedReasonSet.add(cleanSyn.toLowerCase());
            matchedReasons.push(cleanSyn);
          }
        }
      }

      // 4. Certification match (e.g. "gas safe", "niceic", "cscs")
      for (const cert of certList) {
        const certTokens = tokenize(cert);
        if (certTokens.some((ct) => tokenMatches(qTok, ct))) {
          bestHitForToken = Math.max(bestHitForToken, 45);
          if (!matchedReasonSet.has(cert.toLowerCase())) {
            matchedReasonSet.add(cert.toLowerCase());
            matchedReasons.push(cert);
          }
        }
      }

      if (bestHitForToken > 0) {
        matchedTokens.add(qTok);
        tokenScore += bestHitForToken;
      }
    }

    // Coverage bonus: reward categories matching multiple words of the user's query
    const matchedTokenCount = matchedTokens.size;
    if (matchedTokenCount > 1) {
      tokenScore += matchedTokenCount * 35;
    }
    if (queryTokens.length > 0 && matchedTokenCount === queryTokens.length) {
      tokenScore += 60;
    }

    const totalScore = Math.max(baseScore, tokenScore) + (baseScore > 0 && tokenScore > 0 ? Math.min(baseScore, 60) : 0);

    if (totalScore > 0) {
      results.push({
        category,
        score: totalScore,
        matchedTokenCount,
        totalQueryTokens: queryTokens.length,
        matchedSubcategories: matchedSubcategories.slice(0, 4),
        matchedReasons: matchedReasons.slice(0, 4),
      });
    }
  }

  results.sort((a, b) => {
    if (b.matchedTokenCount !== a.matchedTokenCount) {
      return b.matchedTokenCount - a.matchedTokenCount;
    }
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.category.name.localeCompare(b.category.name);
  });

  return results;
}
