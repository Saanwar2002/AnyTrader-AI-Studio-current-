import { auth, db, collection, query, onSnapshot, doc, updateDoc, setDoc, addDoc, getDocs, getDoc, serverTimestamp } from "@/src/firebase";
import { FlashDeal } from "@/src/lib/flashDeals";
import { AiAgentAuditLogEntry } from "./aiAgentEcosystemService";

export interface FlashDealsTelemetry {
  totalDeals: number;
  activeDeals: number;
  claimedDeals: number;
  soldOutDeals: number;
  pausedDeals: number;
  totalClaimsCount: number;
  claimVelocity24h: number;
  avgDiscountPercentage: number;
  totalHomeownerSavingsEst: number;
  totalTraderDealRevenueEst: number;
  categoryDistribution: { category: string; count: number; claims: number; avgDiscount: number }[];
  dayOfWeekDistribution: { day: string; count: number; claims: number }[];
  hourlyClaimVelocity: { hour: string; claims: number; activeDeals: number }[];
  topPerformingTraders: { traderId: string; traderName: string; dealsCount: number; claimsCount: number; rating: number }[];
  unlimitedVsCappedRatio: { cappedDeals: number; unlimitedDeals: number; avgSlotFillRate: number };
}

export interface AiAgentsTelemetry {
  totalInvocations: number;
  invocations24h: number;
  avgResponseTimeMs: number;
  successRate: number;
  estimatedTokenUsage: number;
  activeAgentsCount: number;
  autonomousActionsExecuted24h: number;
  agentBreakdown: {
    agentId: string;
    name: string;
    icon: string;
    invocations: number;
    errorRate: number;
    avgLatencyMs: number;
    status: "healthy" | "degraded" | "throttled";
    lastActive: string;
    model: string;
    description: string;
  }[];
  hourlyInvocationVolume: { hour: string; count: number; tokens: number }[];
  agentCategoryDistribution: { name: string; value: number; color: string }[];
}

export interface PlatformAnomalyIncident {
  id: string;
  type: 
    | "flash_deal_hoarding" 
    | "circular_deal_exploit" 
    | "fake_pricing_inflation" 
    | "ai_prompt_injection" 
    | "ai_rate_limit_burst" 
    | "ai_scraping_attempt" 
    | "multi_account_ip_cluster" 
    | "rapid_phantom_booking" 
    | "abusive_chat_sentiment";
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  status: "active_investigation" | "mitigated" | "whitelisted" | "dismissed";
  targetUserId?: string;
  targetUserName?: string;
  targetUserEmail?: string;
  targetUserRole?: "homeowner" | "tradesperson" | "guest";
  targetDealId?: string;
  targetDealTitle?: string;
  targetAgentType?: string;
  title: string;
  description: string;
  detectedAt: string;
  riskScore: number; // 0 - 100
  triggerEvidence: Record<string, any>;
  suggestedAction: string;
  mitigationActionTaken?: string;
  mitigatedAt?: string;
  mitigatedBy?: string;
  ipHash?: string;
  deviceFingerprint?: string;
}

export function calculateFlashDealsTelemetry(deals: FlashDeal[], jobs: any[] = []): FlashDealsTelemetry {
  const totalDeals = deals.length;
  let activeDeals = 0;
  let soldOutDeals = 0;
  let pausedDeals = 0;
  let totalClaimsCount = 0;
  let totalDiscountSum = 0;
  let totalSavings = 0;
  let totalRevenue = 0;
  let cappedDeals = 0;
  let unlimitedDeals = 0;
  let totalCappedCapacity = 0;
  let totalCappedClaims = 0;

  const categoryMap: Record<string, { count: number; claims: number; discountSum: number }> = {};
  const dayMap: Record<string, { count: number; claims: number }> = {
    "Monday": { count: 0, claims: 0 },
    "Tuesday": { count: 0, claims: 0 },
    "Wednesday": { count: 0, claims: 0 },
    "Thursday": { count: 0, claims: 0 },
    "Friday": { count: 0, claims: 0 },
    "Saturday": { count: 0, claims: 0 },
    "Sunday": { count: 0, claims: 0 }
  };
  const traderMap: Record<string, { traderName: string; dealsCount: number; claimsCount: number; rating: number }> = {};

  deals.forEach((deal) => {
    const claims = Number(deal.claimedCount) || 0;
    totalClaimsCount += claims;
    totalDiscountSum += Number(deal.discountPercentage) || 0;

    if (deal.status === "active") activeDeals++;
    else if (deal.status === "sold_out") soldOutDeals++;
    else if (deal.status === "paused") pausedDeals++;

    // Savings and revenue calculations
    const origPrice = Number(deal.originalPrice) || 120;
    const discPrice = Number(deal.discountedPrice) || (origPrice * (1 - (deal.discountPercentage || 20) / 100));
    const savingsPerClaim = Math.max(0, origPrice - discPrice);
    totalSavings += savingsPerClaim * (claims || 1);
    totalRevenue += discPrice * claims;

    // Capacity tracking
    if (deal.maxClaims === null || deal.maxClaims === undefined || (deal as any).maxClaims === "unlimited") {
      unlimitedDeals++;
    } else {
      cappedDeals++;
      const maxSlots = Number(deal.maxClaims) || 5;
      totalCappedCapacity += maxSlots;
      totalCappedClaims += Math.min(claims, maxSlots);
    }

    // Category tracking
    const cat = deal.category || deal.service || "General Maintenance";
    if (!categoryMap[cat]) {
      categoryMap[cat] = { count: 0, claims: 0, discountSum: 0 };
    }
    categoryMap[cat].count++;
    categoryMap[cat].claims += claims;
    categoryMap[cat].discountSum += Number(deal.discountPercentage) || 0;

    // Day of week tracking
    const rawDay = (deal.dayOfWeek || "Monday").trim().toLowerCase();
    if (rawDay === "all week" || rawDay === "7 days / week" || rawDay === "7 days") {
      ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].forEach(d => {
        if (dayMap[d]) {
          dayMap[d].count++;
          dayMap[d].claims += claims;
        }
      });
    } else if (rawDay === "weekdays" || rawDay === "mon - fri") {
      ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].forEach(d => {
        if (dayMap[d]) {
          dayMap[d].count++;
          dayMap[d].claims += claims;
        }
      });
    } else if (rawDay === "weekend" || rawDay === "weekends" || rawDay === "sat - sun") {
      ["Saturday", "Sunday"].forEach(d => {
        if (dayMap[d]) {
          dayMap[d].count++;
          dayMap[d].claims += claims;
        }
      });
    } else {
      const matchedKey = Object.keys(dayMap).find(k => k.toLowerCase() === rawDay) || (dayMap[deal.dayOfWeek] ? deal.dayOfWeek : "Monday");
      if (dayMap[matchedKey]) {
        dayMap[matchedKey].count++;
        dayMap[matchedKey].claims += claims;
      }
    }

    // Trader tracking
    const tid = deal.traderId || "unknown";
    if (!traderMap[tid]) {
      traderMap[tid] = {
        traderName: deal.traderName || "Verified Trader",
        dealsCount: 0,
        claimsCount: 0,
        rating: deal.rating || 4.9
      };
    }
    traderMap[tid].dealsCount++;
    traderMap[tid].claimsCount += claims;
  });

  const avgDiscountPercentage = totalDeals > 0 ? Math.round(totalDiscountSum / totalDeals) : 0;
  const avgSlotFillRate = totalCappedCapacity > 0 ? Math.round((totalCappedClaims / totalCappedCapacity) * 100) : 0;

  const categoryDistribution = Object.entries(categoryMap)
    .map(([category, data]) => ({
      category,
      count: data.count,
      claims: data.claims,
      avgDiscount: data.count > 0 ? Math.round(data.discountSum / data.count) : 0
    }))
    .sort((a, b) => b.claims - a.claims)
    .slice(0, 8);

  const dayOfWeekDistribution = Object.entries(dayMap).map(([day, data]) => ({
    day: day.substring(0, 3),
    count: data.count,
    claims: data.claims
  }));

  const topPerformingTraders = Object.entries(traderMap)
    .map(([traderId, data]) => ({
      traderId,
      traderName: data.traderName,
      dealsCount: data.dealsCount,
      claimsCount: data.claimsCount,
      rating: data.rating
    }))
    .sort((a, b) => b.claimsCount - a.claimsCount)
    .slice(0, 6);

  const hours = ["00:00", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00"];
  const hourlyClaimVelocity = hours.map((hour) => ({
    hour,
    claims: 0,
    activeDeals
  }));
  deals.forEach((deal: any) => {
    const rawTs = deal.updatedAt || deal.createdAt;
    const ms = typeof rawTs === "string" ? Date.parse(rawTs) : typeof rawTs?.toMillis === "function" ? rawTs.toMillis() : NaN;
    if (Number.isFinite(ms)) {
      const bucketIdx = Math.min(7, Math.floor(new Date(ms).getHours() / 3));
      hourlyClaimVelocity[bucketIdx].claims += Number(deal.claimedCount) || 0;
    }
  });

  const last24hMs = Date.now() - 24 * 60 * 60 * 1000;
  const claimVelocity24h = deals.reduce((sum, d: any) => {
    const rawTs = d.updatedAt || d.createdAt;
    const ms = typeof rawTs === "string" ? Date.parse(rawTs) : typeof rawTs?.toMillis === "function" ? rawTs.toMillis() : NaN;
    if (Number.isFinite(ms) && ms >= last24hMs) {
      return sum + (Number(d.claimedCount) || 0);
    }
    return sum;
  }, 0);

  return {
    totalDeals,
    activeDeals,
    claimedDeals: deals.filter(d => (Number(d.claimedCount) || 0) > 0).length,
    soldOutDeals,
    pausedDeals,
    totalClaimsCount,
    claimVelocity24h,
    avgDiscountPercentage,
    totalHomeownerSavingsEst: Math.round(totalSavings),
    totalTraderDealRevenueEst: Math.round(totalRevenue),
    categoryDistribution,
    dayOfWeekDistribution,
    hourlyClaimVelocity,
    topPerformingTraders,
    unlimitedVsCappedRatio: {
      cappedDeals,
      unlimitedDeals,
      avgSlotFillRate
    }
  };
}

export function calculateAiAgentsTelemetry(auditLogs: AiAgentAuditLogEntry[] = [], settings: any = null): AiAgentsTelemetry {
  const totalInvocations = auditLogs.length;
  const nowMs = Date.now();
  const cutoff24hMs = nowMs - 24 * 60 * 60 * 1000;

  const formatLastActive = (isoOrUndefined?: string) => {
    if (!isoOrUndefined) return "No runs logged";
    const ms = Date.parse(isoOrUndefined);
    if (!Number.isFinite(ms)) return "No runs logged";
    const diffMin = Math.max(0, Math.round((nowMs - ms) / 60000));
    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin} min${diffMin === 1 ? "" : "s"} ago`;
    const diffHours = Math.round(diffMin / 60);
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  };

  const agentTemplates = [
    {
      agentId: "sentinel_guard",
      matchTokens: ["sentinel"],
      name: "Sentinel Threat Guard",
      icon: "ShieldAlert",
      model: "gemini-2.5-flash",
      description: "Real-time KYC verification, fraud risk scoring, IP anomaly detection",
      category: "Security & KYC"
    },
    {
      agentId: "compliance_guardian",
      matchTokens: ["compliance"],
      name: "Compliance Guardian",
      icon: "ShieldCheck",
      model: "gemini-2.5-flash",
      description: "Gas Safe, CSCS card, EICR & Public Liability expiration auditing",
      category: "Security & KYC"
    },
    {
      agentId: "materials_arbitrage",
      matchTokens: ["arbitrage", "materials"],
      name: "Materials Arbitrage Bot",
      icon: "ShoppingBag",
      model: "gemini-2.5-flash",
      description: "Travis Perkins, Screwfix, Wickes real-time price & rebate optimization",
      category: "Supply Arbitrage"
    },
    {
      agentId: "dispute_mediator",
      matchTokens: ["dispute"],
      name: "Dispute Mediator & Claims",
      icon: "AlertTriangle",
      model: "gemini-2.5-flash",
      description: "Autonomous contract evidence analysis, fault allocation & settlement drafting",
      category: "Disputes & Legal"
    },
    {
      agentId: "demand_surge",
      matchTokens: ["surge", "weather"],
      name: "Demand Surge & Weather Bot",
      icon: "CloudLightning",
      model: "gemini-2.5-flash",
      description: "Met Office freeze/storm weather spike forecasting & emergency rate matching",
      category: "Weather & Surge"
    },
    {
      agentId: "trader_churn",
      matchTokens: ["churn", "retention"],
      name: "Trader Retention & Churn Bot",
      icon: "Users",
      model: "gemini-2.5-flash",
      description: "Predictive trader engagement scoring & automated tier upgrade promotions",
      category: "Customer Concierge"
    },
    {
      agentId: "social_campaigns",
      matchTokens: ["social", "growth", "outreach"],
      name: "Multi-Channel Social Agent",
      icon: "Megaphone",
      model: "gemini-2.5-flash",
      description: "Automated hyper-local Facebook, Nextdoor & Instagram trade campaign drafting",
      category: "Customer Concierge"
    },
    {
      agentId: "customer_concierge",
      matchTokens: ["concierge", "lead", "tradebot"],
      name: "TradeBot Concierge",
      icon: "Bot",
      model: "gemini-2.5-flash",
      description: "24/7 Homeowner job diagnostic, photo triage & pre-quote estimate builder",
      category: "Customer Concierge"
    }
  ];

  const agentStats = agentTemplates.map((tpl) => {
    const matching = auditLogs.filter((log) => {
      const normalizedType = String(log.agentType || "").toLowerCase();
      return tpl.matchTokens.some((token) => normalizedType.includes(token));
    });
    const failedCount = matching.filter((log) => String(log.status || "").toLowerCase() === "failed" || String(log.status || "").toLowerCase() === "error").length;
    const latestTs = matching
      .map((l) => l.timestamp)
      .filter(Boolean)
      .sort()
      .pop();
    const errorRate = matching.length > 0 ? Math.round((failedCount / matching.length) * 1000) / 10 : 0;
    const status: "healthy" | "degraded" | "throttled" =
      errorRate >= 25 ? "degraded" : "healthy";

    return {
      agentId: tpl.agentId,
      name: tpl.name,
      icon: tpl.icon,
      invocations: matching.length,
      errorRate,
      avgLatencyMs: 0,
      status,
      lastActive: formatLastActive(latestTs),
      model: tpl.model,
      description: tpl.description,
      _category: tpl.category,
    };
  });

  const logs24h = auditLogs.filter((log) => {
    const ms = log.timestamp ? Date.parse(log.timestamp) : NaN;
    return Number.isFinite(ms) && ms >= cutoff24hMs;
  });
  const invocations24h = logs24h.length;
  const autonomousActionsExecuted24h = logs24h.filter((log) => log.status === "executed" || log.status === "success").length;
  const successfulLogs = auditLogs.filter((log) => {
    const statusLower = String(log.status || "").toLowerCase();
    return statusLower !== "failed" && statusLower !== "error";
  }).length;
  const successRate = totalInvocations > 0 ? Math.round((successfulLogs / totalInvocations) * 1000) / 10 : 0;

  const hourBuckets = ["02:00", "05:00", "08:00", "11:00", "14:00", "17:00", "20:00", "23:00"].map((hour) => ({
    hour,
    count: 0,
    tokens: 0,
  }));
  auditLogs.forEach((log) => {
    const ms = log.timestamp ? Date.parse(log.timestamp) : NaN;
    if (Number.isFinite(ms)) {
      const idx = Math.min(7, Math.floor(new Date(ms).getHours() / 3));
      hourBuckets[idx].count += 1;
    }
  });

  const categoryTotals: Record<string, number> = {};
  agentStats.forEach((a) => {
    categoryTotals[a._category] = (categoryTotals[a._category] || 0) + a.invocations;
  });
  const colorByCat: Record<string, string> = {
    "Security & KYC": "#ef4444",
    "Customer Concierge": "#3b82f6",
    "Supply Arbitrage": "#10b981",
    "Disputes & Legal": "#f59e0b",
    "Weather & Surge": "#8b5cf6",
  };
  const agentCategoryDistribution = Object.entries(categoryTotals)
    .filter(([, val]) => val > 0)
    .map(([name, value]) => ({
      name,
      value,
      color: colorByCat[name] || "#64748b",
    }));

  return {
    totalInvocations,
    invocations24h,
    avgResponseTimeMs: 0,
    successRate,
    estimatedTokenUsage: 0,
    activeAgentsCount: agentStats.filter(a => a.invocations > 0 && a.status === "healthy").length,
    autonomousActionsExecuted24h,
    agentBreakdown: agentStats.map(({ _category, ...rest }) => rest),
    hourlyInvocationVolume: hourBuckets,
    agentCategoryDistribution
  };
}

export function detectPlatformAnomalies(
  deals: FlashDeal[] = [],
  users: any[] = [],
  jobs: any[] = [],
  auditLogs: any[] = []
): PlatformAnomalyIncident[] {
  const anomalies: PlatformAnomalyIncident[] = [];

  // 1. Flash Deal Discount Inflation & Capacity Exhaustion Signals
  deals.forEach(deal => {
    const claims = Number(deal.claimedCount) || 0;
    const max = Number(deal.maxClaims) || 5;

    if (deal.discountPercentage >= 75) {
      anomalies.push({
        id: `anom-disc-${deal.id}`,
        type: "fake_pricing_inflation",
        severity: "MEDIUM",
        status: "active_investigation",
        targetDealId: deal.id,
        targetDealTitle: `${deal.service} (${deal.discountPercentage}% OFF)`,
        targetUserId: deal.traderId,
        targetUserName: deal.traderName || "Unknown Trader",
        targetUserRole: "tradesperson",
        title: "Abnormal Flash Deal Discount Depth",
        description: `Flash deal published with an aggressive ${deal.discountPercentage}% discount. Potential artificial original price inflation to bypass organic ranking filters.`,
        detectedAt: (deal as any).updatedAt || (deal as any).createdAt || new Date().toISOString(),
        riskScore: 68,
        triggerEvidence: {
          discountPercentage: deal.discountPercentage,
          originalPrice: deal.originalPrice,
          discountedPrice: deal.discountedPrice,
          dealId: deal.id
        },
        suggestedAction: "Audit original rate card baseline or request invoice verification for stated original price."
      });
    }

    if (claims >= max && max > 0 && deal.maxClaims !== null && deal.maxClaims !== undefined) {
      anomalies.push({
        id: `anom-velocity-${deal.id}`,
        type: "flash_deal_hoarding",
        severity: "LOW",
        status: "active_investigation",
        targetDealId: deal.id,
        targetDealTitle: `${deal.service}`,
        targetUserId: deal.traderId,
        targetUserName: deal.traderName,
        targetUserRole: "tradesperson",
        title: "Flash Deal Slot Exhaustion",
        description: `All ${max} available slots for ${deal.service} have been claimed.`,
        detectedAt: (deal as any).updatedAt || (deal as any).createdAt || new Date().toISOString(),
        riskScore: 35,
        triggerEvidence: {
          claimedCount: claims,
          maxClaims: max
        },
        suggestedAction: "Verify unique claimant UIDs for this deal or prompt trader to expand slots."
      });
    }
  });

  // 2. Duplicate Phone / Shared Account Clusters from real user records
  const usersByPhone: Record<string, any[]> = {};
  users.forEach(u => {
    const rawPhone = String(u.phone || u.phoneNumber || "").replace(/\s+/g, "");
    if (rawPhone.length >= 8) {
      if (!usersByPhone[rawPhone]) usersByPhone[rawPhone] = [];
      usersByPhone[rawPhone].push(u);
    }
  });
  Object.entries(usersByPhone).forEach(([phone, cluster]) => {
    if (cluster.length > 1) {
      anomalies.push({
        id: `anom-phone-cluster-${phone.slice(-4)}`,
        type: "multi_account_ip_cluster",
        severity: "MEDIUM",
        status: "active_investigation",
        targetUserId: cluster[0].uid || cluster[0].id,
        targetUserName: cluster[0].name || cluster[0].email || "User Cluster",
        targetUserRole: cluster[0].role === "tradesperson" ? "tradesperson" : "homeowner",
        title: "Duplicate Phone Multi-Account Cluster",
        description: `${cluster.length} separate accounts share the same normalized contact number ending in ${phone.slice(-4)}.`,
        detectedAt: new Date().toISOString(),
        riskScore: 72,
        triggerEvidence: {
          accountCount: cluster.length,
          userIds: cluster.map(u => u.uid || u.id),
        },
        suggestedAction: "Review linked accounts for duplicate referral or promotional perk abuse."
      });
    }
  });

  // 3. Real AI / Security Audit Log Flagged Events
  auditLogs.forEach((log: any, idx: number) => {
    const actionLower = String(log.action || log.actionTaken || "").toLowerCase();
    const statusLower = String(log.status || "").toLowerCase();
    const detailsLower = String(log.details || "").toLowerCase();
    if (
      statusLower === "failed" ||
      statusLower === "error" ||
      actionLower.includes("injection") ||
      actionLower.includes("rate_limit") ||
      detailsLower.includes("sybil")
    ) {
      anomalies.push({
        id: log.id ? `anom-log-${log.id}` : `anom-log-${idx}`,
        type: actionLower.includes("injection") ? "ai_prompt_injection" : "ai_rate_limit_burst",
        severity: statusLower === "failed" ? "HIGH" : "MEDIUM",
        status: "active_investigation",
        targetAgentType: log.agentType || "Platform Sentinel",
        title: `Audit Log Security Signal: ${log.action || log.actionTaken || "Security Event"}`,
        description: log.details || log.summary || "Flagged entry recorded in AI agent audit logs.",
        detectedAt: log.timestamp || log.isoTimestamp || new Date().toISOString(),
        riskScore: statusLower === "failed" ? 78 : 55,
        triggerEvidence: {
          auditLogId: log.id || null,
          agentType: log.agentType,
          status: log.status,
        },
        suggestedAction: "Inspect audit log payload and verify rate-limit / security control outcome."
      });
    }
  });

  return anomalies;
}

export async function executeAnomalyMitigation(
  anomalyId: string,
  actionType: "freeze_account" | "revoke_deal" | "throttle_ai" | "flag_kyc" | "dismiss" | "whitelist",
  details: { targetUserId?: string; targetDealId?: string; adminName?: string; note?: string }
): Promise<{ success: boolean; message: string }> {
  try {
    const adminUser = details.adminName || "System Admin";
    const now = new Date().toISOString();

    // 1. If freezing an account, delegate atomically to the server account-lifecycle freeze command
    if (actionType === "freeze_account" && details.targetUserId) {
      const idToken = auth?.currentUser ? await auth.currentUser.getIdToken() : "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (idToken) headers.Authorization = `Bearer ${idToken}`;

      const res = await fetch(`/api/admin/users/${encodeURIComponent(details.targetUserId)}/suspend`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          reason: `Security Anomaly Mitigation: ${details.note || "Platform Misuse"}`,
        }),
      });
      const freezePayload = await res.json().catch(() => ({} as any));
      if (!res.ok || !freezePayload?.success) {
        throw new Error(freezePayload?.error || `Failed to execute server account freeze (${res.status})`);
      }
    }

    // 2. If revoking a flash deal
    if (actionType === "revoke_deal" && details.targetDealId) {
      const dealRef = doc(db, "flash_deals", details.targetDealId);
      await updateDoc(dealRef, {
        status: "paused",
        revokedByAdmin: true,
        revokedReason: details.note || "Administrative compliance review",
        updatedAt: now
      }).catch(() => {});
    }

    // 3. Log mitigation to Firestore
    const logRef = collection(db, "ai_agent_audit_logs");
    await addDoc(logRef, {
      agentType: "Sentinel Security Sentinel",
      actionTaken: `Mitigated Anomaly [${anomalyId}]: ${actionType}`,
      details: `Action: ${actionType}. Target: User: ${details.targetUserId || 'N/A'}, Deal: ${details.targetDealId || 'N/A'}. Note: ${details.note || 'None'}`,
      executedBy: adminUser,
      timestamp: serverTimestamp(),
      isoTimestamp: now,
      status: "success",
      triggerSource: "admin_manual_action"
    }).catch(() => {});

    return {
      success: true,
      message: `Successfully executed mitigation action: ${actionType.replace('_', ' ').toUpperCase()}`
    };
  } catch (error: any) {
    console.error("Error executing anomaly mitigation:", error);
    return {
      success: false,
      message: error.message || "Failed to execute mitigation action"
    };
  }
}
