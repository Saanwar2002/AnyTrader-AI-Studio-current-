import { describe, it, expect } from "vitest";
import { resolveAuthoritativeLineItem, SERVER_PRICING_CATALOG, calculateGothamSaaSPlanServer } from "../../src/server/pricingCatalog";
import { publishPlatformPricingConfigAtomic } from "../../src/server/pricingConfigPublish";
import { PaymentLedgerEngine } from "../../src/server/paymentLedger";
import { executeQuoteCommand } from "../../src/server/quoteCommands";

describe("Stripe Connect & Financial Flow Invariants", () => {
  const checkoutDb = (ownerId: string, status = "open") => ({
    collection: (col: string) => ({
      doc: (id: string) => ({
        get: async () => col === "jobs" ? ({
          exists: true,
          data: () => ({ homeownerId: ownerId, acceptedTradespersonId: "trader_999", status }),
        }) : ({ exists: false, data: () => ({}) }),
      }),
    }),
  });
  it("enforces that all platform catalog products route 100% of fees to platform account", async () => {
    const catalogEntries = [
      { body: { metadata: { type: "boost", tier: "emergency_boost", jobId: "job_test" } }, expectedAmount: 500 },
      { body: { metadata: { type: "boost", tier: "instant_match", jobId: "job_test" } }, expectedAmount: 299 },
      { body: { priceId: "price_landlord" }, expectedAmount: 1900 },
      { body: { priceId: "price_pro" }, expectedAmount: 1999 },
      { body: { priceId: "price_premium" }, expectedAmount: 4999 },
      { body: { priceId: "price_platinum" }, expectedAmount: 9999 },
      { body: { priceId: "price_driver_gold" }, expectedAmount: 4999 },
      { body: { metadata: { type: "mediation_stake", jobId: "job_test" } }, expectedAmount: 2500 },
      { body: { priceId: "price_video_pro" }, expectedAmount: 1500 },
      { body: { priceId: "price_exclusive_leads" }, expectedAmount: 2900 },
    ];

    for (const item of catalogEntries) {
      const lineItem = await resolveAuthoritativeLineItem(item.body, "user_test_123", checkoutDb("user_test_123", item.body.metadata?.type === "mediation_stake" ? "disputed" : "open"));
      expect(lineItem.authoritativeAmountPence).toBe(item.expectedAmount);
      expect(lineItem.lineItem.price_data.currency).toBe("gbp");
      // Platform owns these products: NEVER client money
      expect(lineItem.isClientMoney).toBe(false);
      expect(lineItem.paymentIntentData).toBeUndefined();
    }
  });

  it("strictly enforces Stripe Connect destination routing when handling Client Money (milestone escrow)", async () => {
    const traderStripeAccountId = "acct_1NZX456789ABCDEF";

    // Mock Firestore DB for milestone lookup
    const mockDb = {
      collection: (col: string) => ({
        doc: (id: string) => ({
          get: async () => {
            if (col === "jobs") {
              return {
                exists: true,
                data: () => ({ homeownerId: "cust_111", jobNo: "1001" })
              };
            }
            if (col === "users") {
              return {
                exists: true,
                data: () => ({ stripeAccountId: traderStripeAccountId, tier: "payg" })
              };
            }
            return { exists: false };
          },
          collection: () => ({
            doc: () => ({
              get: async () => ({
                exists: true,
                data: () => ({
                  tradespersonId: "trader_999",
                  milestones: [
                    { id: "m1", title: "Phase 1 - Prep", amount: 500.00, status: "pending" }
                  ]
                })
              })
            })
          })
        })
      })
    };

    const lineItem = await resolveAuthoritativeLineItem({
      metadata: {
        type: "milestone_funding",
        jobId: "job_xyz_123",
        quoteId: "quote_456",
        milestoneId: "m1"
      }
    }, "cust_111", mockDb);

    expect(lineItem.authoritativeAmountPence).toBe(50000);
    expect(lineItem.isClientMoney).toBe(true);

    // Platform NEVER holds client funds:
    // Destination charge routes directly to the tradesperson's connected account
    expect(lineItem.paymentIntentData).toBeDefined();
    expect(lineItem.paymentIntentData?.transfer_data?.destination).toBe(traderStripeAccountId);
    
    // Platform fee is deducted automatically by Stripe as application_fee_amount (canonical 5% PAYG of £500 = £25)
    expect(lineItem.paymentIntentData?.application_fee_amount).toBe(2500);
  });

  it("calculates volume-tiered B2B Gotham SaaS monthly licensing accurately", () => {
    // 50 doors @ £4.50 = £225.00 (22500p)
    const tier1 = calculateGothamSaaSPlanServer(50, "monthly");
    expect(tier1.chargeAmountPence).toBe(22500);

    // 200 doors @ £3.50 = £700.00 (70000p)
    const tier2 = calculateGothamSaaSPlanServer(200, "monthly");
    expect(tier2.chargeAmountPence).toBe(70000);

    // 1500 doors @ £2.50 = £3,750.00 (375000p)
    const tier3 = calculateGothamSaaSPlanServer(1500, "monthly");
    expect(tier3.chargeAmountPence).toBe(375000);
  });

  it("prevents client-side price tampering by ignoring arbitrary client inputs", async () => {
    // Malicious attacker sends £1.00 for emergency boost
    const tamperedPayload = {
      metadata: {
        type: "boost",
        tier: "emergency_boost",
        jobId: "job_test",
      },
      price_data: {
        unit_amount: 100, // Attacker tries £1.00
      },
      amount: 1.00,
      customAmount: 1
    };

    const authoritative = await resolveAuthoritativeLineItem(tamperedPayload, "owner_uid", checkoutDb("owner_uid"));
    // Server must strictly return the canonical catalog price (£5.00 = 500p)
    expect(authoritative.authoritativeAmountPence).toBe(500);
  });

  it("prevents client-side price tampering on dispute mediation stake", async () => {
    // Malicious attacker attempts to pay £0.01 for dispute mediation
    const tamperedPayload = {
      metadata: {
        type: "mediation_stake",
        jobId: "job_test",
      },
      price_data: {
        unit_amount: 1
      },
      amount: 0.01,
    };

    const authoritative = await resolveAuthoritativeLineItem(tamperedPayload, "user_test_123", checkoutDb("user_test_123", "disputed"));
    // Server must strictly return £25.00 (2500p)
    expect(authoritative.authoritativeAmountPence).toBe(2500);
  });

  it("authoritatively honors dynamic admin pricing and commission overrides saved in Firestore", async () => {
    // Mock Firestore containing custom admin-configured pricing in platform_config
    const mockDbWithAdminOverrides = {
      collection: (col: string) => ({
        doc: (docId: string) => ({
          get: async () => {
            if (col === "platform_config" && docId === "global_tiers") {
              return {
                exists: true,
                data: () => ({
                  providerModels: {
                    one_off_trades: {
                      tiers: {
                        pro: { price: 35.00, commission: 0.02 }, // Admin customized Pro to £35/mo and 2% commission
                      }
                    }
                  }
                })
              };
            }
            if (col === "platform_config" && docId === "global") {
              return {
                exists: true,
                data: () => ({
                  paidAddons: {
                    emergencyBoost: { price: 7.50 }, // Admin customized Emergency Boost to £7.50
                  }
                })
              };
            }
            if (col === "jobs" && docId === "job_override_1") {
              return {
                exists: true,
                data: () => ({ homeownerId: "homeowner_user", acceptedTradespersonId: "trader_pro_override", jobNo: "9001", status: "open" })
              };
            }
            if (col === "users" && docId === "trader_pro_override") {
              return {
                exists: true,
                data: () => ({ stripeAccountId: "acct_trader_pro_custom", tier: "pro" })
              };
            }
            return { exists: false };
          },
          collection: () => ({
            doc: () => ({
              get: async () => ({
                exists: true,
                data: () => ({
                  tradespersonId: "trader_pro_override",
                  milestones: [
                    { id: "m_custom", title: "Custom Stage", amount: 1000.00, status: "pending" }
                  ]
                })
              })
            })
          })
        })
      })
    };

    // 1. Subscription tier price dynamically honors admin's £35.00 override
    const proSubResult = await resolveAuthoritativeLineItem({
      priceId: "price_pro",
    }, "trader_pro_user", mockDbWithAdminOverrides);
    expect(proSubResult.authoritativeAmountPence).toBe(3500); // £35.00

    // 2. Emergency boost dynamically honors admin's £7.50 override
    const boostResult = await resolveAuthoritativeLineItem({
      metadata: { type: "boost", tier: "emergency_boost", jobId: "job_override_1" },
      price_data: { unit_amount: 100 } // Attacker attempts to tamper, ignored!
    }, "homeowner_user", mockDbWithAdminOverrides);
    expect(boostResult.authoritativeAmountPence).toBe(750); // £7.50

    // 3. Milestone escrow funding calculates 2% commission based on admin's tier override
    const milestoneResult = await resolveAuthoritativeLineItem({
      metadata: {
        type: "milestone_funding",
        jobId: "job_override_1",
        quoteId: "quote_override_1",
        milestoneId: "m_custom"
      }
    }, "homeowner_user", mockDbWithAdminOverrides);
    expect(milestoneResult.authoritativeAmountPence).toBe(100000); // £1,000.00
    // 2% of £1,000 = £20.00 (2000p)
    expect(milestoneResult.paymentIntentData?.application_fee_amount).toBe(2000);
  });

  it("enforces configurable Admin commissionCapGbp (default £250, custom cap, and 0 = uncapped)", async () => {
    const buildCapDb = (capGbp?: number) => ({
      collection: (col: string) => ({
        doc: (docId: string) => ({
          get: async () => {
            if (col === "platform_config" && docId === "global_tiers") {
              return {
                exists: capGbp !== undefined,
                data: () => ({
                  commissionCapGbp: capGbp,
                  providerModels: {
                    one_off_trades: {
                      commissionCapGbp: capGbp,
                      tiers: { payg: { price: 0, commission: 0.05 } },
                    },
                  },
                }),
              };
            }
            if (col === "jobs") {
              return { exists: true, data: () => ({ homeownerId: "cust_cap", jobNo: "777" }) };
            }
            if (col === "users") {
              return { exists: true, data: () => ({ stripeAccountId: "acct_cap_trader", tier: "payg" }) };
            }
            return { exists: false };
          },
          collection: () => ({
            doc: () => ({
              get: async () => ({
                exists: true,
                data: () => ({
                  tradespersonId: "trader_cap",
                  milestones: [{ id: "m_big", title: "Full Extension", amount: 10000, status: "pending" }],
                }),
              }),
            }),
          }),
        }),
      }),
    });

    // Default £250 cap on £10,000 PAYG (5% = £500 -> capped at £250 = 25000p)
    const defaultCapRes = await resolveAuthoritativeLineItem(
      { metadata: { type: "milestone_funding", jobId: "j1", quoteId: "q1", milestoneId: "m_big" } },
      "cust_cap",
      buildCapDb(undefined)
    );
    expect(defaultCapRes.paymentIntentData?.application_fee_amount).toBe(25000);

    // Custom Admin £150 cap on £10,000 PAYG -> capped at £150 = 15000p
    const customCapRes = await resolveAuthoritativeLineItem(
      { metadata: { type: "milestone_funding", jobId: "j1", quoteId: "q1", milestoneId: "m_big" } },
      "cust_cap",
      buildCapDb(150)
    );
    expect(customCapRes.paymentIntentData?.application_fee_amount).toBe(15000);

    // Admin sets 0 (uncapped) on £10,000 PAYG -> full 5% = £500 = 50000p
    const uncappedRes = await resolveAuthoritativeLineItem(
      { metadata: { type: "milestone_funding", jobId: "j1", quoteId: "q1", milestoneId: "m_big" } },
      "cust_cap",
      buildCapDb(0)
    );
    expect(uncappedRes.paymentIntentData?.application_fee_amount).toBe(50000);
  });

  it("propagates Admin commission, promo <= 1% rate, and cap changes identically across Quote -> Stripe Checkout -> Funding -> Release (0p drift)", async () => {
    const store = new Map<string, any>();
    const makeDocRef = (path: string): any => ({
      id: path.split("/").pop() || path,
      path,
      get: async () => ({
        exists: store.has(path),
        id: path.split("/").pop() || path,
        data: () => store.get(path),
      }),
      set: async (data: any, opts?: any) => {
        store.set(path, opts?.merge ? { ...(store.get(path) || {}), ...data } : data);
      },
      update: async (data: any) => {
        store.set(path, { ...(store.get(path) || {}), ...data });
      },
      delete: async () => {
        store.delete(path);
      },
      collection: (subCol: string) => makeColRef(`${path}/${subCol}`),
    });
    let autoId = 0;
    const makeColRef = (colPath: string): any => ({
      doc: (id?: string) => makeDocRef(`${colPath}/${id || `auto_${++autoId}`}`),
      where: (field: string, _op: string, val: any) => ({
        get: async () => {
          const docs = Array.from(store.entries())
            .filter(([k, v]) => k.startsWith(`${colPath}/`) && k.slice(colPath.length + 1).indexOf("/") === -1 && v?.[field] === val)
            .map(([k, v]) => ({ id: k.split("/").pop(), data: () => v }));
          return { docs, empty: docs.length === 0, size: docs.length };
        },
      }),
    });
    const unifiedDb: any = {
      collection: (col: string) => makeColRef(col),
      runTransaction: async (fn: any) => {
        const tx = {
          get: async (ref: any) => ({
            exists: store.has(ref.path),
            id: ref.id,
            data: () => store.get(ref.path),
          }),
          set: (ref: any, data: any, opts?: any) => {
            store.set(ref.path, opts?.merge ? { ...(store.get(ref.path) || {}), ...data } : data);
          },
          update: (ref: any, data: any) => {
            store.set(ref.path, { ...(store.get(ref.path) || {}), ...data });
          },
          delete: (ref: any) => {
            store.delete(ref.path);
          },
        };
        return await fn(tx);
      },
    };

    // Seed homeowner, Gold Elite trader, and open job
    store.set("users/trader_gold", {
      uid: "trader_gold",
      role: "tradesperson",
      tier: "premium",
      tierId: "Gold Elite",
      stripeAccountId: "acct_gold_trader_live",
      isVerified: true,
      verificationStatus: "verified",
    });
    store.set("jobs/job_sync_1", {
      homeownerId: "homeowner_sync",
      jobNo: "SYNC-101",
      status: "open",
      quoteCount: 0,
    });

    // 1. Admin publishes promo Gold Elite = 1% and Commission Cap = £120 (tests <= 1% bug fix too!)
    await publishPlatformPricingConfigAtomic({
      db: unifiedDb,
      adminUid: "admin_super",
      tempConfig: { monetizationEnabled: true, commissionCapGbp: 120 },
      feeTiers: [
        { name: "Free Explorer", price: 0, commission: 4, maxQuotes: 5 },
        { name: "Gold Elite", price: 45, commission: 1, maxQuotes: 9999 },
      ],
    });

    // 2. Trader creates a £20,000 quote (1% = £200 -> capped at Admin's £120!)
    const quoteRes = await executeQuoteCommand({
      db: unifiedDb,
      identity: {
        uid: "trader_gold",
        email: "gold@example.com",
        accountType: "service_provider",
        capabilities: ["tradesperson"],
        verification: { status: "verified" },
      } as any,
      command: {
        type: "CreateQuote",
        payload: {
          jobId: "job_sync_1",
          amount: 20000,
          coverNote: "Full house rewire",
          milestones: [{ id: "m_stage_1", title: "Full Rewire", amount: 20000, description: "All stages" }],
        },
      },
      idempotencyKey: "sync_quote_create_key_1",
    });
    expect(quoteRes.quote?.platformFee).toBe(120); // £120 cap
    expect(quoteRes.quote?.netPayout).toBe(19880);
    expect(quoteRes.quote?.appliedCommissionRate).toBe(0.01);
    expect(quoteRes.quote?.commissionCapGbp).toBe(120);

    // 3. Stripe Checkout milestone funding resolves the EXACT same £120 (12000p) fee
    const checkoutLineItem = await resolveAuthoritativeLineItem(
      {
        metadata: {
          type: "milestone_funding",
          jobId: "job_sync_1",
          quoteId: quoteRes.quoteId,
          milestoneId: "m_stage_1",
        },
      },
      "homeowner_sync",
      unifiedDb
    );
    expect(checkoutLineItem.paymentIntentData?.application_fee_amount).toBe(12000);
    expect(checkoutLineItem.metadata.appliedCommissionRate).toBe("0.01");
    expect(checkoutLineItem.metadata.commissionCapGbp).toBe("120");

    // 4. Ledger funding records the EXACT same 12000p fee
    const fundEntry = await PaymentLedgerEngine.recordEscrowFunding(unifiedDb, {
      jobId: "job_sync_1",
      milestoneId: "m_stage_1",
      customerId: "homeowner_sync",
      traderId: "trader_gold",
      verifiedAmount: 2000000,
      currency: "gbp",
      paymentIntentId: "pi_sync_1",
      idempotencyKey: "sync_fund_key_1",
    });
    expect(fundEntry.platformFee).toBe(12000);
    expect(fundEntry.netPayout).toBe(1988000);

    // 5. Mark quote accepted & milestone funded, then release -> EXACT same 12000p fee (0p drift!)
    store.set("jobs/job_sync_1", {
      ...store.get("jobs/job_sync_1"),
      status: "in_progress",
      acceptedQuoteId: quoteRes.quoteId,
      acceptedTradespersonId: "trader_gold",
    });
    const quotePath = `jobs/job_sync_1/quotes/${quoteRes.quoteId}`;
    const qDoc = store.get(quotePath);
    store.set(quotePath, {
      ...qDoc,
      status: "accepted",
      milestones: qDoc.milestones.map((m: any) => ({ ...m, status: "funded" })),
    });

    const releaseRes = await PaymentLedgerEngine.releaseEscrowFunds(unifiedDb, {
      jobId: "job_sync_1",
      quoteId: quoteRes.quoteId,
      milestoneId: "m_stage_1",
      authUid: "homeowner_sync",
      idempotencyKey: "sync_release_key_1",
    });
    expect(releaseRes.platformFeePence).toBe(12000);
    expect(releaseRes.netPayoutPence).toBe(1988000);
  });
});
