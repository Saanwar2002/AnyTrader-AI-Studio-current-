import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createBillingPortalSessionForUser,
  ensureStripeAccountForProvider,
  reconcileStripeAccountUpdatedWebhook,
  resolveStripeConnectBusinessType,
} from "../../src/server/stripeConnectHelpers.ts";
import { BadRequestError, ServiceUnavailableError } from "../../src/server/httpErrors.ts";

function createInMemoryDb(initial: Record<string, Record<string, any>> = {}) {
  const store: Record<string, Map<string, any>> = {};
  for (const [col, docs] of Object.entries(initial)) {
    store[col] = new Map(Object.entries(docs).map(([k, v]) => [k, structuredClone(v)]));
  }
  const ensureCol = (name: string) => {
    if (!store[name]) store[name] = new Map();
    return store[name];
  };

  const makeDocRef = (col: string, id: string): any => ({
    id,
    path: `${col}/${id}`,
    get: async () => {
      const data = ensureCol(col).get(id);
      return {
        id,
        ref: makeDocRef(col, id),
        exists: data !== undefined,
        data: () => (data !== undefined ? structuredClone(data) : undefined),
      };
    },
    set: async (data: any, opts?: { merge?: boolean }) => {
      const prev = ensureCol(col).get(id);
      ensureCol(col).set(id, opts?.merge && prev ? { ...prev, ...structuredClone(data) } : structuredClone(data));
    },
    update: async (patch: any) => {
      const prev = ensureCol(col).get(id);
      if (!prev) throw new Error(`Doc ${col}/${id} missing`);
      ensureCol(col).set(id, { ...prev, ...structuredClone(patch) });
    },
  });

  return {
    _store: store,
    collection: (name: string) => ({
      doc: (id: string) => makeDocRef(name, id),
      where: (field: string, _op: string, value: any) => ({
        limit: () => ({
          get: async () => {
            const entries = [...ensureCol(name).entries()].filter(([, d]) => d?.[field] === value);
            return {
              empty: entries.length === 0,
              size: entries.length,
              docs: entries.map(([id, d]) => ({ id, ref: makeDocRef(name, id), exists: true, data: () => structuredClone(d) })),
            };
          },
        }),
      }),
    }),
    runTransaction: async (fn: (tx: any) => Promise<any>) => {
      const tx = {
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, patch: any) => ref.update(patch),
      };
      return fn(tx);
    },
  };
}

describe("Task 12 — Stripe Customer Portal Auto-Provisioning & UK Ltd Connect Support", () => {
  it("auto-provisions stripeCustomerId when a brand-new user opens the Billing Customer Portal", async () => {
    const db = createInMemoryDb({
      users: {
        user_new: { uid: "user_new", role: "homeowner", email: "newuser@example.co.uk" },
      },
    });
    const stripe = {
      customers: {
        create: vi.fn().mockResolvedValue({ id: "cus_auto_123" }),
      },
      billingPortal: {
        sessions: {
          create: vi.fn().mockResolvedValue({ url: "https://billing.stripe.com/session/live_abc" }),
        },
      },
    };

    const result = await createBillingPortalSessionForUser({
      db,
      stripe,
      authUid: "user_new",
      returnUrl: "https://anytrader.co.uk/billing",
    });

    expect(result).toEqual({
      url: "https://billing.stripe.com/session/live_abc",
      customerId: "cus_auto_123",
    });
    expect(stripe.customers.create).toHaveBeenCalledTimes(1);
    expect(stripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: "newuser@example.co.uk", metadata: { firebaseUid: "user_new" } }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^cust_create_user_new_/) })
    );
    expect(db._store.users.get("user_new")?.stripeCustomerId).toBe("cus_auto_123");
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: "cus_auto_123",
      return_url: "https://anytrader.co.uk/billing",
    });
  });

  it("reuses an existing stripeCustomerId without creating a duplicate Stripe customer", async () => {
    const db = createInMemoryDb({
      users: {
        user_existing: { uid: "user_existing", role: "tradesperson", stripeCustomerId: "cus_existing_999" },
      },
    });
    const stripe = {
      customers: { create: vi.fn() },
      billingPortal: {
        sessions: {
          create: vi.fn().mockResolvedValue({ url: "https://billing.stripe.com/session/existing" }),
        },
      },
    };

    const result = await createBillingPortalSessionForUser({
      db,
      stripe,
      authUid: "user_existing",
      returnUrl: "https://anytrader.co.uk/billing",
    });

    expect(result.customerId).toBe("cus_existing_999");
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it("throws ServiceUnavailableError if Stripe Billing Portal returns no URL", async () => {
    const db = createInMemoryDb({
      users: {
        user_no_url: { uid: "user_no_url", stripeCustomerId: "cus_1" },
      },
    });
    const stripe = {
      customers: { create: vi.fn() },
      billingPortal: {
        sessions: { create: vi.fn().mockResolvedValue({}) },
      },
    };

    await expect(
      createBillingPortalSessionForUser({
        db,
        stripe,
        authUid: "user_no_url",
        returnUrl: "https://anytrader.co.uk/billing",
      })
    ).rejects.toThrow(ServiceUnavailableError);
  });

  it("resolves Stripe Connect business_type flexibly for UK Ltd companies, sole traders, and hosted selection", () => {
    expect(resolveStripeConnectBusinessType({ role: "tradesperson" })).toBeUndefined();
    expect(resolveStripeConnectBusinessType({ role: "business" }, "ltd")).toBe("company");
    expect(resolveStripeConnectBusinessType({ role: "business" }, "limited_company")).toBe("company");
    expect(resolveStripeConnectBusinessType({ role: "business" }, "company")).toBe("company");
    expect(resolveStripeConnectBusinessType({ role: "tradesperson" }, "sole_trader")).toBe("individual");
    expect(resolveStripeConnectBusinessType({ role: "tradesperson" }, "non_profit")).toBe("non_profit");
    expect(resolveStripeConnectBusinessType({ role: "business", businessEntityType: "ltd" })).toBe("company");

    expect(() => resolveStripeConnectBusinessType({ role: "business" }, "invalid_entity")).toThrow(BadRequestError);
  });

  it("omits business_type by default on stripe.accounts.create so Stripe Express lets UK Ltd & sole traders choose", async () => {
    const db = createInMemoryDb({
      users: {
        ltd_builder: {
          uid: "ltd_builder",
          role: "business",
          businessLayer: "field_services",
          email: "accounts@acmeltd.co.uk",
        },
      },
    });
    const stripe = {
      accounts: {
        create: vi.fn().mockResolvedValue({ id: "acct_express_flex_1" }),
      },
    };

    await ensureStripeAccountForProvider({
      db,
      stripe,
      authUid: "ltd_builder",
      userData: db._store.users.get("ltd_builder"),
    });

    const createPayload = stripe.accounts.create.mock.calls[0][0];
    expect(createPayload.type).toBe("express");
    expect(createPayload.country).toBe("GB");
    expect(createPayload.business_type).toBeUndefined();
    expect(createPayload.metadata).toEqual(
      expect.objectContaining({ firebaseUid: "ltd_builder", role: "business", businessLayer: "field_services" })
    );
  });

  it("passes business_type: 'company' when a UK Limited Company explicitly selects company onboarding and syncs via webhook", async () => {
    const db = createInMemoryDb({
      users: {
        uk_ltd_1: {
          uid: "uk_ltd_1",
          role: "business",
          businessLayer: "consultancy",
          email: "director@ukltd.co.uk",
        },
      },
    });
    const stripe = {
      accounts: {
        create: vi.fn().mockResolvedValue({ id: "acct_uk_ltd_1", business_type: "company" }),
      },
    };

    const created = await ensureStripeAccountForProvider({
      db,
      stripe,
      authUid: "uk_ltd_1",
      userData: db._store.users.get("uk_ltd_1"),
      requestedBusinessType: "ltd",
    });

    expect(created.accountId).toBe("acct_uk_ltd_1");
    expect(stripe.accounts.create.mock.calls[0][0].business_type).toBe("company");
    expect(db._store.users.get("uk_ltd_1")?.stripeBusinessType).toBe("company");

    // Reconcile account.updated webhook with company business_type
    const synced = await reconcileStripeAccountUpdatedWebhook({
      db,
      eventId: "evt_company_1",
      eventCreated: 5000,
      account: {
        id: "acct_uk_ltd_1",
        business_type: "company",
        payouts_enabled: true,
        charges_enabled: true,
        details_submitted: true,
        capabilities: { transfers: "active", card_payments: "active" },
      },
    });
    expect(synced.synced).toBe(true);
    expect(db._store.users.get("uk_ltd_1")?.stripeBusinessType).toBe("company");
    expect(db._store.users.get("uk_ltd_1")?.payoutsEnabled).toBe(true);
  });

  it("source regression: server.ts auto-provisions customerId in portal route and stripeConnectHelpers does not hardcode individual", () => {
    const serverSrc = fs.readFileSync(path.resolve(process.cwd(), "server.ts"), "utf8");
    const portalIdx = serverSrc.indexOf('"/api/create-customer-portal-session"');
    const portalBlock = serverSrc.slice(portalIdx, portalIdx + 1700);
    expect(portalBlock).toContain("ensureStripeCustomerIdForUser");
    expect(portalBlock).not.toContain("No active Stripe customer account found for this profile.");

    const connectHelpersSrc = fs.readFileSync(
      path.resolve(process.cwd(), "src/server/stripeConnectHelpers.ts"),
      "utf8"
    );
    expect(connectHelpersSrc).not.toContain('business_type: "individual"');
  });
});
