import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { computeJobAnalysisVersionHash } from "../../src/server/intelligence/jobIntelligence";
import { PropertyIntelligenceService } from "../../src/server/intelligence/propertyIntelligence";
import { QualityReviewService } from "../../src/server/intelligence/qualityReview";
import { ContractorArchiveRightsService } from "../../src/server/intelligence/contractorArchiveRights";
import {
  DataRetentionService,
  DataRetentionNotFoundError,
  DataRetentionValidationError,
} from "../../src/server/intelligence/dataRetention";
import { DataRightsService } from "../../src/server/intelligence/dataRights";
import { ProvenanceGraphService } from "../../src/server/intelligence/provenanceGraph";
import { AiTrainingUsageControlsService } from "../../src/server/intelligence/aiTrainingUsageControls";
import { enqueueOutreachMessageCommand, listOutreachQueueCommand } from "../../src/server/outreachQueue";
import { executeBootstrapProfileCommand } from "../../src/server/accountBootstrap";
import { deriveVerifiedShopDiscount } from "../../src/server/ssoClaimIntegrity";
import { validateMonetizationOpportunitiesPayload } from "../../src/services/geminiServer";
import {
  assertFieldOwnershipImmutability,
  updateFieldEntityWithOwnershipGuard,
} from "../../src/server/fieldOperationsCommands";
import { purgeClientSessionOnUidTransition } from "../../src/lib/sessionIsolation";

function createInMemoryDb(seed: Record<string, Record<string, any>> = {}) {
  const store: Record<string, Map<string, any>> = {};
  for (const [col, docs] of Object.entries(seed)) {
    store[col] = new Map(Object.entries(docs).map(([id, data]) => [id, { ...data }]));
  }
  const ensureCol = (name: string) => {
    if (!store[name]) store[name] = new Map();
    return store[name];
  };
  let autoId = 1;

  const makeDocRef = (col: string, id: string) => ({
    id,
    path: `${col}/${id}`,
    get: async () => {
      const m = ensureCol(col);
      return {
        id,
        exists: m.has(id),
        data: () => (m.has(id) ? { ...m.get(id) } : undefined),
      };
    },
    set: async (data: any, opts?: { merge?: boolean }) => {
      const m = ensureCol(col);
      if (opts?.merge && m.has(id)) {
        m.set(id, { ...m.get(id), ...data });
      } else {
        m.set(id, { ...data });
      }
    },
    update: async (patch: any) => {
      const m = ensureCol(col);
      if (!m.has(id)) throw new Error(`Not found: ${col}/${id}`);
      m.set(id, { ...m.get(id), ...patch });
    },
    delete: async () => {
      ensureCol(col).delete(id);
    },
  });

  const makeQuery = (col: string, filters: Array<{ f: string; op: string; v: any }> = [], limitN?: number, orderDir?: "asc" | "desc", orderField?: string) => {
    const q: any = {
      where: (f: string, op: string, v: any) => makeQuery(col, [...filters, { f, op, v }], limitN, orderDir, orderField),
      orderBy: (f: string, dir: "asc" | "desc" = "asc") => makeQuery(col, filters, limitN, dir, f),
      limit: (n: number) => makeQuery(col, filters, n, orderDir, orderField),
      get: async () => {
        const m = ensureCol(col);
        let entries = Array.from(m.entries()).filter(([, d]) =>
          filters.every(({ f, op, v }) => (op === "==" ? d[f] === v : true))
        );
        if (orderField) {
          entries.sort((a, b) => {
            const av = String(a[1][orderField] || "");
            const bv = String(b[1][orderField] || "");
            return orderDir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv);
          });
        }
        if (limitN !== undefined) entries = entries.slice(0, limitN);
        const docs = entries.map(([id, d]) => ({ id, exists: true, data: () => ({ ...d }) }));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    };
    return q;
  };

  return {
    _store: store,
    collection: (name: string) => ({
      doc: (id?: string) => makeDocRef(name, id || `${name}_${autoId++}`),
      add: async (data: any) => {
        const id = `${name}_${autoId++}`;
        ensureCol(name).set(id, { ...data });
        return { id };
      },
      ...makeQuery(name),
    }),
    runTransaction: async (fn: (tx: any) => Promise<any>) => {
      // Snapshot rollback support for true atomic transaction verification
      const snapshot: Record<string, Map<string, any>> = {};
      for (const [k, m] of Object.entries(store)) {
        snapshot[k] = new Map(Array.from(m.entries()).map(([id, v]) => [id, { ...v }]));
      }
      const tx = {
        get: async (ref: any) => ref.get(),
        set: async (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: async (ref: any, patch: any) => ref.update(patch),
        delete: async (ref: any) => ref.delete(),
      };
      try {
        return await fn(tx);
      } catch (err) {
        // Roll back store on transaction failure
        for (const k of Object.keys(store)) delete store[k];
        for (const [k, m] of Object.entries(snapshot)) store[k] = m;
        throw err;
      }
    },
  };
}

describe("Batch 13 — Intelligence Provenance, Outreach, Leads, Referral, SSO & Field Security", () => {
  it("AT-INTEL-JOB-01: computes dynamic job source content/version SHA-256 hash instead of hardcoded v1", () => {
    const h1 = computeJobAnalysisVersionHash({
      jobId: "job_1",
      title: "Boiler leak",
      description: "Dripping pipe under boiler",
      category: "Plumbing",
      postcode: "M14 5TP",
      sourceVersion: 1,
    });
    const h1Repeat = computeJobAnalysisVersionHash({
      jobId: "job_1",
      title: "Boiler leak",
      description: "Dripping pipe under boiler",
      category: "Plumbing",
      postcode: "m14 5tp",
      sourceVersion: "1",
    });
    const h2Edited = computeJobAnalysisVersionHash({
      jobId: "job_1",
      title: "Boiler leak",
      description: "Dripping pipe under boiler + pressure drop to 0 bar",
      category: "Plumbing",
      postcode: "M14 5TP",
      sourceVersion: 1,
    });

    expect(h1).toMatch(/^cv_[a-f0-9]{16}$/);
    expect(h1).toBe(h1Repeat);
    expect(h2Edited).not.toBe(h1);
  });

  it("AT-INTEL-PROP-01: rejects missing target properties cleanly without creating placeholder properties and rejects cross-property job contamination", async () => {
    const db = createInMemoryDb({ properties: {} });
    const svc = new PropertyIntelligenceService(undefined, { firestoreDb: db });

    await expect(
      svc.aggregatePropertyIntelligence({ propertyId: "missing_prop_999", propertyType: "Flat" }, [], undefined, {
        firestoreDb: db,
        persist: true,
      })
    ).rejects.toThrow(/not found|placeholder property creation is forbidden/i);

    // Must NOT have synthesized a placeholder property doc
    expect(db._store.properties.has("missing_prop_999")).toBe(false);

    // Cross-property job lineage must still fail closed immediately
    await expect(
      svc.aggregatePropertyIntelligence(
        { propertyId: "prop_A" },
        [{ jobId: "job_foreign", propertyId: "prop_B" } as any],
        undefined,
        { firestoreDb: db, persist: false }
      )
    ).rejects.toThrow(/PropertyLineage Violation/i);
  });

  it("AT-INTEL-QUALITY-01: commits intelligence quality review AND immutable audit log atomically and fails closed when DB is missing or transaction fails", async () => {
    const reviewSvc = new QualityReviewService();

    // Missing DB fails closed
    await expect(
      reviewSvc.applyAndPersistReview(
        {
          targetCollection: "intelligence_jobs",
          targetId: "job_q1",
          action: "approve",
          reviewerId: "admin_1",
          reason: "Verified accurate",
          originalCandidate: { category: "Plumbing" },
        },
        null
      )
    ).rejects.toThrow(/Fail Closed/i);

    // Atomic persistence writes BOTH review doc and immutable audit event
    const db = createInMemoryDb();
    const res = await reviewSvc.applyAndPersistReview(
      {
        targetCollection: "intelligence_jobs",
        targetId: "job_q1",
        action: "correct",
        reviewerId: "admin_1",
        reason: "Corrected boiler type",
        originalCandidate: { component: "Combi" },
        correctedResult: { component: "System Boiler" },
      },
      db as any
    );

    expect(db._store.intelligence_quality.has(res.review.qualityId)).toBe(true);
    expect(db._store.intelligence_events.has(res.auditEvent.eventId)).toBe(true);
  });

  it("AT-INTEL-ARCHIVE-01: registers archive + components atomically with conservative fail-closed child inheritance and zero partial state on invalid component", async () => {
    const db = createInMemoryDb();
    const archiveSvc = new ContractorArchiveRightsService(db);

    // Invalid second component must abort BEFORE creating parent archive rights
    await expect(
      archiveSvc.registerArchiveRights({
        tenantId: "contractor_1",
        contractorUid: "contractor_1",
        archiveReference: "arch_bad_comp",
        allowInternalAi: true,
        linkProvenance: false,
        components: [
          { componentKey: "ok_photo", originType: "contractor_owned", category: "photograph" },
          { componentKey: "bad_comp", originType: "invalid_origin" as any, category: "photograph" },
        ],
      })
    ).rejects.toThrow(/Invalid originType/i);

    expect((db._store.data_rights?.size || 0)).toBe(0);

    // Parent archive with allowInternalAi: false MUST cascade denied to child component even if child requests allowed
    const reg = await archiveSvc.registerArchiveRights({
      tenantId: "contractor_1",
      contractorUid: "contractor_1",
      archiveReference: "arch_restricted",
      allowInternalAi: false,
      linkProvenance: false,
      components: [
        {
          componentKey: "cust_invoice",
          originType: "customer_or_subject_data",
          category: "invoice",
          purposes: { internal_ai_use: "allowed", external_ai_training: "allowed" },
        },
      ],
    });

    expect(reg.rightsRecord.purposes.internal_ai_use).toBe("denied");
    expect(reg.componentRights?.length).toBe(1);
    expect(reg.componentRights![0].purposes.internal_ai_use).toBe("denied");
    expect(reg.componentRights![0].purposes.external_ai_training).toBe("unknown");
    expect(reg.componentRights![0].restrictions).toContain("restrict_internal_ai_use");
    expect(reg.componentRights![0].restrictions).toContain("subject_privacy_protected");
  });

  it("AT-INTEL-LIFECYCLE-01: rejects missing revocation targets with DataRetentionNotFoundError and empty target requests with validation error", async () => {
    const db = createInMemoryDb();
    const rightsSvc = new DataRightsService(db);
    const provSvc = new ProvenanceGraphService(db);
    const aiSvc = new AiTrainingUsageControlsService(db as any);
    const retentionSvc = new DataRetentionService(db, rightsSvc, provSvc, undefined, undefined, aiSvc);

    await expect(
      retentionSvc.revokeDataLifecycleRights({
        tenantId: "tenant_1",
        reason: "No target passed",
      })
    ).rejects.toThrow(DataRetentionValidationError);

    await expect(
      retentionSvc.revokeDataLifecycleRights({
        tenantId: "tenant_1",
        rightsId: "rights_nonexistent_123",
        reason: "Testing missing rights target",
      })
    ).rejects.toThrow(DataRetentionNotFoundError);

    await expect(
      retentionSvc.revokeDataLifecycleRights({
        tenantId: "tenant_1",
        controlId: "ctrl_nonexistent_456",
        reason: "Testing missing control target",
      })
    ).rejects.toThrow(DataRetentionNotFoundError);

    await expect(
      retentionSvc.revokeDataLifecycleRights({
        tenantId: "tenant_1",
        provenanceNodeId: "pnode_nonexistent_789",
        reason: "Testing missing node target",
      })
    ).rejects.toThrow(DataRetentionNotFoundError);
  });

  it("AT-OUTREACH-01 & AT-OUTREACH-02: purges outreach session storage on logout/account switch and persists honest server outbound queue delivery statuses", async () => {
    // Test sessionIsolation purges both localStorage and sessionStorage anytrader_outreach_* keys
    const fakeStore = () => {
      const m = new Map<string, string>();
      return {
        get length() { return m.size; },
        key: (i: number) => Array.from(m.keys())[i] ?? null,
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => m.set(k, v),
        removeItem: (k: string) => m.delete(k),
      };
    };
    const origLocal = (globalThis as any).localStorage;
    const origSession = (globalThis as any).sessionStorage;
    const ls = fakeStore();
    const ss = fakeStore();
    (globalThis as any).localStorage = ls;
    (globalThis as any).sessionStorage = ss;
    try {
      ls.setItem("anytrader_outreach_leads", "[]");
      ss.setItem("anytrader_outreach_admin1_leads", "[{\"id\":\"1\"}]");
      purgeClientSessionOnUidTransition("admin1", "admin2");
      expect(ls.getItem("anytrader_outreach_leads")).toBeNull();
      expect(ss.getItem("anytrader_outreach_admin1_leads")).toBeNull();
    } finally {
      (globalThis as any).localStorage = origLocal;
      (globalThis as any).sessionStorage = origSession;
    }

    // Server outreach queue honestly records skipped_no_provider vs queued (never fabricates sent)
    const db = createInMemoryDb();
    const unconfigured = await enqueueOutreachMessageCommand({
      db,
      adminUid: "admin_1",
      leadId: "lead_1",
      businessName: "Apex Plumbing",
      channel: "email",
      recipient: "dave@apex.co.uk",
      body: "Hello Dave",
      providerConfig: { emailConfigured: false },
    });
    expect(unconfigured.deliveryStatus).toBe("skipped_no_provider");
    expect(unconfigured.providerConfigured).toBe(false);

    const configured = await enqueueOutreachMessageCommand({
      db,
      adminUid: "admin_1",
      leadId: "lead_2",
      businessName: "Spark Ltd",
      channel: "email",
      recipient: "info@spark.co.uk",
      body: "Hello Spark",
      providerConfig: { emailConfigured: true },
    });
    expect(configured.deliveryStatus).toBe("queued");
    expect(configured.providerConfigured).toBe(true);

    const listed = await listOutreachQueueCommand(db, 10);
    expect(listed.length).toBe(2);
  });

  it("AT-REF-02: resolves and validates referral & affiliate codes server-side inside executeBootstrapProfileCommand and blocks self/suspended referrals", async () => {
    const db = createInMemoryDb({
      affiliates: {
        aff_uk_1: { code: "partner2026", status: "active" },
        aff_paused: { code: "pausedcode", status: "inactive" },
      },
      users: {
        ref_active: { referralCode: "ACTIVE01", isSuspended: false },
        ref_suspended: { referralCode: "BANNED01", isSuspended: true },
      },
    });

    // Valid active user referral code
    await executeBootstrapProfileCommand(db, { uid: "new_user_1", email: "u1@test.uk" }, {
      role: "homeowner",
      name: "Alice",
      referralCode: "active01",
    });
    expect(db._store.users.get("new_user_1").referredBy).toBe("ref_active");
    expect(db._store.users.get("new_user_1").affiliateId).toBeNull();

    // Valid active affiliate code
    await executeBootstrapProfileCommand(db, { uid: "new_user_2", email: "u2@test.uk" }, {
      role: "homeowner",
      name: "Bob",
      referralCode: "PARTNER2026",
    });
    expect(db._store.users.get("new_user_2").affiliateId).toBe("aff_uk_1");
    expect(db._store.users.get("new_user_2").referredBy).toBeNull();

    // Suspended referrer & forged unknown referrerUid are rejected cleanly (null attribution)
    await executeBootstrapProfileCommand(db, { uid: "new_user_3", email: "u3@test.uk" }, {
      role: "homeowner",
      name: "Charlie",
      referralCode: "BANNED01",
    });
    expect(db._store.users.get("new_user_3").referredBy).toBeNull();

    await executeBootstrapProfileCommand(db, { uid: "new_user_4", email: "u4@test.uk" }, {
      role: "homeowner",
      name: "Dana",
      referrerUid: "ghost_uid_does_not_exist",
    });
    expect(db._store.users.get("new_user_4").referredBy).toBeNull();
  });

  it("AT-SSO-01: derives TradeShop SSO discount strictly from active verified entitlements rather than stale tierId strings", () => {
    const config = {
      feeTiers: [
        { name: "Free Explorer", shopDiscount: 0 },
        { name: "Platinum", shopDiscount: 15 },
        { name: "Pro", shopDiscount: 10 },
      ],
    };

    // Stale tierId with canceled subscription -> MUST return 0
    expect(
      deriveVerifiedShopDiscount(
        { tierId: "Platinum", subscriptionStatus: "canceled" },
        "tradesperson",
        config
      )
    ).toBe(0);

    // Stale tierId with NO active subscription status or entitlement -> MUST return 0
    expect(
      deriveVerifiedShopDiscount({ tierId: "Platinum" }, "tradesperson", config)
    ).toBe(0);

    // Expired subscription timestamp -> MUST return 0
    expect(
      deriveVerifiedShopDiscount(
        {
          tierId: "Platinum",
          subscriptionStatus: "active",
          subscriptionExpiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
        "tradesperson",
        config
      )
    ).toBe(0);

    // Active verified subscription -> grants tier discount
    expect(
      deriveVerifiedShopDiscount(
        {
          tierId: "Platinum",
          subscriptionStatus: "active",
          subscriptionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        "tradesperson",
        config
      )
    ).toBe(15);
  });

  it("AT-ECOSYSTEM-02: validates MonetizationOpportunity payload against all required campaign UI fields", () => {
    const valid = validateMonetizationOpportunitiesPayload([
      {
        id: "opp-1",
        type: "subscription_upgrade",
        title: "TradeOS Pro Winter Push",
        description: "Upgrade active plumbers to Pro with reduced 5% commission.",
        impact: "High",
        targetRole: "tradesperson",
        action: "Create Pro Campaign",
        potentialMonthlyValueGBP: 2400,
        unlockedFeatures: ["5% commission", "Priority alerts"],
        conversionTips: ["Highlight fee savings"],
      },
    ]);
    expect(valid[0].impact).toBe("High");
    expect(valid[0].targetRole).toBe("tradesperson");
    expect(valid[0].action).toBe("Create Pro Campaign");

    // Missing UI-required fields (impact/targetRole/action) must fail Zod validation
    expect(() =>
      validateMonetizationOpportunitiesPayload([
        {
          id: "opp-bad",
          type: "fast_pass",
          title: "Incomplete",
          description: "Missing impact/targetRole/action",
          potentialMonthlyValueGBP: 100,
          unlockedFeatures: [],
          conversionTips: [],
        },
      ])
    ).toThrow(/Invalid MonetizationOpportunity payload/i);
  });

  it("AT-FIELD-01: enforces ownership immutability (businessId/ownerId) on field_agents and dispatch_routes updates", async () => {
    expect(() =>
      assertFieldOwnershipImmutability({ businessId: "biz_A", ownerId: "biz_A" }, { businessId: "biz_B" })
    ).toThrow(/immutable/i);

    const db = createInMemoryDb({
      field_agents: {
        agent_1: { businessId: "biz_A", ownerId: "biz_A", name: "Sam", status: "available" },
      },
      dispatch_routes: {
        route_1: { businessId: "biz_A", title: "North Loop", status: "planned" },
      },
    });

    // Cross-tenant attempt blocked
    await expect(
      updateFieldEntityWithOwnershipGuard({
        db,
        collectionName: "field_agents",
        entityId: "agent_1",
        callerUid: "biz_B",
        updates: { status: "busy" },
      })
    ).rejects.toThrow(/permission/i);

    // Owner attempting to reassign businessId blocked
    await expect(
      updateFieldEntityWithOwnershipGuard({
        db,
        collectionName: "dispatch_routes",
        entityId: "route_1",
        callerUid: "biz_A",
        updates: { businessId: "biz_B", status: "active" },
      })
    ).rejects.toThrow(/immutable/i);

    // Legitimate non-ownership update succeeds
    const ok = await updateFieldEntityWithOwnershipGuard({
      db,
      collectionName: "field_agents",
      entityId: "agent_1",
      callerUid: "biz_A",
      updates: { status: "en_route" },
    });
    expect(ok.id).toBe("agent_1");
    expect(db._store.field_agents.get("agent_1").status).toBe("en_route");
    expect(db._store.field_agents.get("agent_1").businessId).toBe("biz_A");
  });

  it("AT-FIRESTORE-SEARCH-01, AT-LEAD-02, AT-SSO-02, AT-ECOSYSTEM-01: verifies Firestore rules, server routes, and client components enforce fail-closed controls", () => {
    const rules = fs.readFileSync(path.resolve("firestore.rules"), "utf8");
    const serverSrc = fs.readFileSync(path.resolve("server.ts"), "utf8");
    const layoutSrc = fs.readFileSync(path.resolve("src/components/Layout.tsx"), "utf8");
    const ecoSrc = fs.readFileSync(path.resolve("src/components/EcosystemAdmin.tsx"), "utf8");
    const leadSvcSrc = fs.readFileSync(path.resolve("src/services/leadService.ts"), "utf8");

    // AT-FIRESTORE-SEARCH-01
    expect(rules).toContain("match /search_logs/{logId}");
    expect(rules).toContain("request.resource.data.keys().hasOnly(['query', 'timestamp', 'category', 'userId'])");
    expect(serverSrc).toContain('app.post("/api/telemetry/search-log"');

    // AT-LEAD-02
    expect(rules).toMatch(/match \/leads\/\{leadId\}[\s\S]*?allow create:\s*if false;/);
    expect(rules).toMatch(/match \/campaigns\/\{campaignId\}[\s\S]*?allow create, update, delete:\s*if isAdmin\(\);/);
    expect(serverSrc).toContain('app.post("/api/partner-leads"');
    expect(leadSvcSrc).toContain('fetch("/api/partner-leads"');

    // AT-FIELD-01 rules
    expect(rules).toMatch(/match \/field_agents\/\{agentId\}[\s\S]*?!request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)\.hasAny\(\['businessId', 'ownerId'/);
    expect(rules).toMatch(/match \/dispatch_routes\/\{routeId\}[\s\S]*?!request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)\.hasAny\(\['businessId', 'ownerId'/);

    // AT-SSO-02: no insecure ?uid= fallback in Layout.tsx
    expect(layoutSrc).not.toContain("shop.tradequote.uk/?uid=");

    // AT-ECOSYSTEM-01: no hardcoded mock 1250/450 counts in EcosystemAdmin.tsx
    expect(ecoSrc).not.toContain("totalUsers: 1250");
    expect(ecoSrc).toContain("/api/admin/ecosystem/stats");
    expect(serverSrc).toContain('app.get("/api/admin/ecosystem/stats"');
  });
});
