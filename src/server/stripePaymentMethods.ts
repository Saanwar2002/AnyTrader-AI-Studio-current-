/**
 * Authoritative Stripe Saved Payment Methods helpers.
 *
 * Centralizes validation, customer ownership verification, real Stripe default
 * payment method resolution/updates, and safe card detachment (with automatic
 * default-card promotion when the current default is removed).
 */

export interface SavedPaymentMethodDTO {
  id: string;
  brand: string;
  last4: string;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

const STRIPE_PM_ID_REGEX = /^pm_[A-Za-z0-9_]+$/;

export function isValidStripePaymentMethodId(value: unknown): value is string {
  return typeof value === "string" && STRIPE_PM_ID_REGEX.test(value.trim());
}

/**
 * Extracts the real default payment method ID from a Stripe Customer object.
 * Handles both unexpanded string IDs and expanded PaymentMethod objects, and
 * returns null for deleted customers or customers with no default set.
 */
export function extractCustomerDefaultPaymentMethodId(customer: any): string | null {
  if (!customer || customer.deleted === true) return null;
  const raw = customer.invoice_settings?.default_payment_method;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  if (raw && typeof raw === "object" && typeof raw.id === "string" && raw.id.trim().length > 0) {
    return raw.id.trim();
  }
  return null;
}

/**
 * Formats Stripe card payment methods into client DTOs with an authoritative
 * `isDefault` flag derived strictly from Stripe's customer default_payment_method.
 * Sorts the active default card first for display clarity without fabricating a
 * default when Stripe has none configured.
 */
export function formatSavedPaymentMethods(
  paymentMethods: any[],
  defaultPaymentMethodId: string | null
): SavedPaymentMethodDTO[] {
  const formatted: SavedPaymentMethodDTO[] = (Array.isArray(paymentMethods) ? paymentMethods : []).map((pm) => ({
    id: String(pm.id),
    brand: String(pm.card?.brand || "card"),
    last4: String(pm.card?.last4 || "••••"),
    expMonth: typeof pm.card?.exp_month === "number" ? pm.card.exp_month : null,
    expYear: typeof pm.card?.exp_year === "number" ? pm.card.exp_year : null,
    isDefault: Boolean(defaultPaymentMethodId && pm.id === defaultPaymentMethodId),
  }));

  formatted.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return formatted;
}

export class PaymentMethodRouteError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = "PaymentMethodRouteError";
  }
}

export async function listCustomerPaymentMethods(params: {
  stripe: any;
  stripeCustomerId: string;
}): Promise<{ paymentMethods: SavedPaymentMethodDTO[]; defaultPaymentMethodId: string | null }> {
  const { stripe, stripeCustomerId } = params;

  const [customer, listResult] = await Promise.all([
    stripe.customers.retrieve(stripeCustomerId),
    stripe.paymentMethods.list({
      customer: stripeCustomerId,
      type: "card",
    }),
  ]);

  if (customer && (customer as any).deleted === true) {
    return { paymentMethods: [], defaultPaymentMethodId: null };
  }

  const rawList = Array.isArray(listResult?.data) ? listResult.data : [];
  let defaultPaymentMethodId = extractCustomerDefaultPaymentMethodId(customer);

  // If Stripe's default points to a detached/removed card no longer in list, treat as unset.
  if (defaultPaymentMethodId && !rawList.some((pm: any) => pm.id === defaultPaymentMethodId)) {
    defaultPaymentMethodId = null;
  }

  return {
    paymentMethods: formatSavedPaymentMethods(rawList, defaultPaymentMethodId),
    defaultPaymentMethodId,
  };
}

export async function setCustomerDefaultPaymentMethod(params: {
  stripe: any;
  stripeCustomerId: string;
  paymentMethodId: string;
}): Promise<{ defaultPaymentMethodId: string }> {
  const { stripe, stripeCustomerId, paymentMethodId } = params;

  if (!isValidStripePaymentMethodId(paymentMethodId)) {
    throw new PaymentMethodRouteError(400, "Invalid payment method identifier.");
  }

  const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
  const pmCustomerId =
    typeof paymentMethod?.customer === "string"
      ? paymentMethod.customer
      : paymentMethod?.customer?.id || null;

  if (pmCustomerId !== stripeCustomerId) {
    throw new PaymentMethodRouteError(403, "Forbidden: Payment method does not belong to your account.");
  }

  await stripe.customers.update(stripeCustomerId, {
    invoice_settings: {
      default_payment_method: paymentMethodId,
    },
  });

  return { defaultPaymentMethodId: paymentMethodId };
}

export async function detachCustomerPaymentMethod(params: {
  stripe: any;
  stripeCustomerId: string;
  paymentMethodId: string;
}): Promise<{ detachedId: string; defaultPaymentMethodId: string | null }> {
  const { stripe, stripeCustomerId, paymentMethodId } = params;

  if (!isValidStripePaymentMethodId(paymentMethodId)) {
    throw new PaymentMethodRouteError(400, "Invalid payment method identifier.");
  }

  const [customer, paymentMethod] = await Promise.all([
    stripe.customers.retrieve(stripeCustomerId),
    stripe.paymentMethods.retrieve(paymentMethodId),
  ]);

  const pmCustomerId =
    typeof paymentMethod?.customer === "string"
      ? paymentMethod.customer
      : paymentMethod?.customer?.id || null;

  if (pmCustomerId !== stripeCustomerId) {
    throw new PaymentMethodRouteError(403, "Forbidden: Payment method does not belong to your account.");
  }

  const currentDefault = extractCustomerDefaultPaymentMethodId(customer);
  await stripe.paymentMethods.detach(paymentMethodId);

  let nextDefaultId: string | null = currentDefault;
  if (currentDefault === paymentMethodId) {
    const remaining = await stripe.paymentMethods.list({
      customer: stripeCustomerId,
      type: "card",
    });
    const remainingCards = Array.isArray(remaining?.data) ? remaining.data : [];
    nextDefaultId = remainingCards.length > 0 ? String(remainingCards[0].id) : null;

    if (nextDefaultId) {
      await stripe.customers.update(stripeCustomerId, {
        invoice_settings: {
          default_payment_method: nextDefaultId,
        },
      });
    }
  }

  return { detachedId: paymentMethodId, defaultPaymentMethodId: nextDefaultId };
}

/**
 * When a Stripe Checkout Session in `mode: "setup"` completes, automatically
 * promote the newly saved card to `customer.invoice_settings.default_payment_method`
 * if the customer does not yet have a default payment method set.
 */
export async function syncDefaultPaymentMethodFromSetupSession(params: {
  stripe: any;
  session: any;
}): Promise<{ updated: boolean; defaultPaymentMethodId: string | null }> {
  const { stripe, session } = params;
  if (!session || session.mode !== "setup") {
    return { updated: false, defaultPaymentMethodId: null };
  }

  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id || null;
  const setupIntentId =
    typeof session.setup_intent === "string"
      ? session.setup_intent
      : session.setup_intent?.id || null;

  if (!customerId || !setupIntentId) {
    return { updated: false, defaultPaymentMethodId: null };
  }

  const [customer, setupIntent] = await Promise.all([
    stripe.customers.retrieve(customerId),
    stripe.setupIntents.retrieve(setupIntentId),
  ]);

  if (customer && (customer as any).deleted === true) {
    return { updated: false, defaultPaymentMethodId: null };
  }

  const existingDefault = extractCustomerDefaultPaymentMethodId(customer);
  if (existingDefault) {
    return { updated: false, defaultPaymentMethodId: existingDefault };
  }

  const pmId =
    typeof setupIntent?.payment_method === "string"
      ? setupIntent.payment_method
      : setupIntent?.payment_method?.id || null;

  if (!pmId || !isValidStripePaymentMethodId(pmId)) {
    return { updated: false, defaultPaymentMethodId: null };
  }

  await stripe.customers.update(customerId, {
    invoice_settings: {
      default_payment_method: pmId,
    },
  });

  return { updated: true, defaultPaymentMethodId: pmId };
}
