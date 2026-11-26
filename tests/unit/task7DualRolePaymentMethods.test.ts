import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  isValidStripePaymentMethodId,
  extractCustomerDefaultPaymentMethodId,
  formatSavedPaymentMethods,
  listCustomerPaymentMethods,
  setCustomerDefaultPaymentMethod,
  detachCustomerPaymentMethod,
  syncDefaultPaymentMethodFromSetupSession,
  PaymentMethodRouteError,
} from "../../src/server/stripePaymentMethods";

const ROOT = process.cwd();
function readSource(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

describe("Task 7 — Authoritative Stripe Saved Payment Methods (src/server/stripePaymentMethods.ts)", () => {
  it("validates Stripe payment method IDs strictly", () => {
    expect(isValidStripePaymentMethodId("pm_1Qabc123_XYZ")).toBe(true);
    expect(isValidStripePaymentMethodId("pm_card_visa")).toBe(true);
    expect(isValidStripePaymentMethodId("")).toBe(false);
    expect(isValidStripePaymentMethodId("card_123")).toBe(false);
    expect(isValidStripePaymentMethodId("pm_123/../admin")).toBe(false);
    expect(isValidStripePaymentMethodId(null)).toBe(false);
  });

  it("extracts real default payment method IDs from string, expanded object, or deleted customer", () => {
    expect(
      extractCustomerDefaultPaymentMethodId({ invoice_settings: { default_payment_method: "pm_111" } })
    ).toBe("pm_111");
    expect(
      extractCustomerDefaultPaymentMethodId({ invoice_settings: { default_payment_method: { id: "pm_222" } } })
    ).toBe("pm_222");
    expect(
      extractCustomerDefaultPaymentMethodId({ deleted: true, invoice_settings: { default_payment_method: "pm_333" } })
    ).toBeNull();
    expect(extractCustomerDefaultPaymentMethodId({ invoice_settings: {} })).toBeNull();
  });

  it("formats saved cards using real default without fabricating index === 0 as default", () => {
    const raw = [
      { id: "pm_first", card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2029 } },
      { id: "pm_second", card: { brand: "mastercard", last4: "5555", exp_month: 8, exp_year: 2028 } },
    ];

    const noDefault = formatSavedPaymentMethods(raw, null);
    expect(noDefault.every((c) => c.isDefault === false)).toBe(true);

    const secondDefault = formatSavedPaymentMethods(raw, "pm_second");
    expect(secondDefault[0].id).toBe("pm_second");
    expect(secondDefault[0].isDefault).toBe(true);
    expect(secondDefault[1].id).toBe("pm_first");
    expect(secondDefault[1].isDefault).toBe(false);
  });

  it("lists customer payment methods and clears stale default IDs not present in active cards", async () => {
    const stripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          id: "cus_1",
          invoice_settings: { default_payment_method: "pm_stale" },
        }),
      },
      paymentMethods: {
        list: vi.fn().mockResolvedValue({
          data: [{ id: "pm_live", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } }],
        }),
      },
    };

    const result = await listCustomerPaymentMethods({ stripe, stripeCustomerId: "cus_1" });
    expect(result.defaultPaymentMethodId).toBeNull();
    expect(result.paymentMethods).toHaveLength(1);
    expect(result.paymentMethods[0].isDefault).toBe(false);
  });

  it("sets default payment method after verifying ownership and rejects cross-customer IDs", async () => {
    const updateMock = vi.fn().mockResolvedValue({});
    const stripe = {
      paymentMethods: {
        retrieve: vi.fn().mockResolvedValue({ id: "pm_owned", customer: "cus_owner" }),
      },
      customers: {
        update: updateMock,
      },
    };

    const ok = await setCustomerDefaultPaymentMethod({
      stripe,
      stripeCustomerId: "cus_owner",
      paymentMethodId: "pm_owned",
    });
    expect(ok.defaultPaymentMethodId).toBe("pm_owned");
    expect(updateMock).toHaveBeenCalledWith("cus_owner", {
      invoice_settings: { default_payment_method: "pm_owned" },
    });

    await expect(
      setCustomerDefaultPaymentMethod({
        stripe,
        stripeCustomerId: "cus_attacker",
        paymentMethodId: "pm_owned",
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      setCustomerDefaultPaymentMethod({
        stripe,
        stripeCustomerId: "cus_owner",
        paymentMethodId: "invalid_id",
      })
    ).rejects.toBeInstanceOf(PaymentMethodRouteError);
  });

  it("detaches default card and promotes remaining card in Stripe; rejects cross-customer detach", async () => {
    const updateMock = vi.fn().mockResolvedValue({});
    const detachMock = vi.fn().mockResolvedValue({});
    const stripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          id: "cus_1",
          invoice_settings: { default_payment_method: "pm_old_default" },
        }),
        update: updateMock,
      },
      paymentMethods: {
        retrieve: vi.fn().mockResolvedValue({ id: "pm_old_default", customer: "cus_1" }),
        detach: detachMock,
        list: vi.fn().mockResolvedValue({
          data: [{ id: "pm_backup", card: { brand: "mastercard", last4: "9999" } }],
        }),
      },
    };

    const res = await detachCustomerPaymentMethod({
      stripe,
      stripeCustomerId: "cus_1",
      paymentMethodId: "pm_old_default",
    });

    expect(detachMock).toHaveBeenCalledWith("pm_old_default");
    expect(updateMock).toHaveBeenCalledWith("cus_1", {
      invoice_settings: { default_payment_method: "pm_backup" },
    });
    expect(res).toEqual({ detachedId: "pm_old_default", defaultPaymentMethodId: "pm_backup" });

    // Cross-customer detach must throw 403 without calling detach
    detachMock.mockClear();
    await expect(
      detachCustomerPaymentMethod({
        stripe,
        stripeCustomerId: "cus_other",
        paymentMethodId: "pm_old_default",
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(detachMock).not.toHaveBeenCalled();
  });

  it("detaches final card without issuing an invalid empty-string customers.update", async () => {
    const updateMock = vi.fn().mockResolvedValue({});
    const detachMock = vi.fn().mockResolvedValue({});
    const stripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          id: "cus_1",
          invoice_settings: { default_payment_method: "pm_only" },
        }),
        update: updateMock,
      },
      paymentMethods: {
        retrieve: vi.fn().mockResolvedValue({ id: "pm_only", customer: "cus_1" }),
        detach: detachMock,
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
    };

    const res = await detachCustomerPaymentMethod({
      stripe,
      stripeCustomerId: "cus_1",
      paymentMethodId: "pm_only",
    });

    expect(detachMock).toHaveBeenCalledWith("pm_only");
    expect(updateMock).not.toHaveBeenCalled();
    expect(res).toEqual({ detachedId: "pm_only", defaultPaymentMethodId: null });
  });

  it("syncs first saved card as default on setup checkout completion while preserving existing default", async () => {
    const updateMock = vi.fn().mockResolvedValue({});
    const stripeNoDefault = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({ id: "cus_1", invoice_settings: { default_payment_method: null } }),
        update: updateMock,
      },
      setupIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "seti_1", payment_method: "pm_new" }),
      },
    };

    const synced = await syncDefaultPaymentMethodFromSetupSession({
      stripe: stripeNoDefault,
      session: { mode: "setup", customer: "cus_1", setup_intent: "seti_1" },
    });
    expect(synced).toEqual({ updated: true, defaultPaymentMethodId: "pm_new" });
    expect(updateMock).toHaveBeenCalledWith("cus_1", {
      invoice_settings: { default_payment_method: "pm_new" },
    });

    // Preserve existing default when adding a second card
    const updateExistingMock = vi.fn();
    const stripeWithDefault = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({ id: "cus_1", invoice_settings: { default_payment_method: "pm_existing" } }),
        update: updateExistingMock,
      },
      setupIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "seti_2", payment_method: "pm_second" }),
      },
    };
    const preserved = await syncDefaultPaymentMethodFromSetupSession({
      stripe: stripeWithDefault,
      session: { mode: "setup", customer: "cus_1", setup_intent: "seti_2" },
    });
    expect(preserved).toEqual({ updated: false, defaultPaymentMethodId: "pm_existing" });
    expect(updateExistingMock).not.toHaveBeenCalled();
  });
});

describe("Task 7 — Source Regression Checks (server.ts, BillingManager.tsx, Profile.tsx)", () => {
  it("server.ts exposes rate-limited default-card route and handles setup checkout webhooks", () => {
    const src = readSource("server.ts");
    expect(src).toContain('app.post("/api/payment-methods/:userId/:paymentMethodId/default", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter');
    expect(src).toContain('app.delete("/api/payment-methods/:userId/:paymentMethodId", requireAuth, paymentLimiter, paymentAttemptAbuseLimiter');
    expect(src).toContain("syncDefaultPaymentMethodFromSetupSession");
    expect(src).toContain("if (session.mode === 'setup')");
    expect(src).toContain("listCustomerPaymentMethods");
    expect(src).toContain("setCustomerDefaultPaymentMethod");
    expect(src).toContain("detachCustomerPaymentMethod");
  });

  it("BillingManager.tsx removes fake index===0 default, unifies Dual-Role Payment Methods + Connect, checks res.ok, and hides Gold Driver Tier from non-drivers", () => {
    const src = readSource("src/components/BillingManager.tsx");
    expect(src).not.toContain("isDefault: index === 0");
    expect(src).toContain("SavedPaymentCardsPanel");
    expect(src).toContain("handleSetDefaultPaymentMethod");
    expect(src).toContain("/default");
    expect(src).toContain("if (!res.ok)");
    expect(src).toContain("Receiving Payouts (Stripe Connect)");
    expect(src).toContain("const isDriverAccount = isAnyRollerDriverAccount(profile);");
    expect(src).toContain("const showGoldDriverCard = isDriverAccount || isGoldDriverActive;");
    expect(src).toContain("{showGoldDriverCard && (");
    expect(src).toContain("if (!isDriverAccount && !isCurrentlyActive)");
  });

  it("Profile.tsx uses SavedPaymentCardsPanel, supports real Stripe default card, checks res.ok on delete, and handles setup=success", () => {
    const src = readSource("src/components/Profile.tsx");
    expect(src).toContain("SavedPaymentCardsPanel");
    expect(src).toContain("handleSetDefaultPaymentMethod");
    expect(src).toContain('if (setupParam === "success")');
    expect(src).toContain("if (!res.ok)");
  });
});
