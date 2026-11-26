import { describe, it, expect, vi } from "vitest";
import { resolveAuthoritativeLineItem } from "../../src/server/pricingCatalog.ts";
import { executeCreateTripPaymentCommand } from "../../src/server/tripPaymentAuthorization.ts";
import { PaymentLedgerEngine } from "../../src/server/paymentLedger.ts";
import { ForbiddenError } from "../../src/server/httpErrors.ts";

function createMockDb(store: Record<string, any>) {
  const buildDocRef = (path: string) => ({
    id: path.split("/").pop() || "",
    path,
    async get() {
      const data = store[path];
      return {
        id: path.split("/").pop() || "",
        exists: data !== undefined && data !== null,
        data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
      };
    },
    collection(subCol: string) {
      return {
        doc(subId: string) {
          return buildDocRef(`${path}/${subCol}/${subId}`);
        },
      };
    },
  });

  return {
    collection(colName: string) {
      return {
        doc(docId: string) {
          return buildDocRef(`${colName}/${docId}`);
        },
      };
    },
  };
}

describe("Task 13: Defense-in-Depth Self-Payment Rejection (payerUid !== payeeUid)", () => {
  describe("Milestone Escrow Funding (pricingCatalog.ts)", () => {
    it("rejects milestone funding when dual-role caller attempts to fund their own quote", async () => {
      const db = createMockDb({
        "jobs/job_self_1": {
          homeownerId: "user_dual_1",
          jobNo: "AT-1001",
          status: "accepted",
        },
        "jobs/job_self_1/quotes/quote_self_1": {
          jobId: "job_self_1",
          tradespersonId: "user_dual_1",
          status: "accepted",
          milestones: [
            { id: "m1", title: "Deposit", amount: 250, status: "pending" },
          ],
        },
        "users/user_dual_1": {
          uid: "user_dual_1",
          stripeAccountId: "acct_dual_12345",
        },
      });

      await expect(
        resolveAuthoritativeLineItem(
          {
            metadata: {
              type: "milestone_funding",
              jobId: "job_self_1",
              quoteId: "quote_self_1",
              milestoneId: "m1",
            },
          },
          "user_dual_1",
          db
        )
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects milestone funding even when job owner uses userId alias matching tradespersonId", async () => {
      const db = createMockDb({
        "jobs/job_self_2": {
          userId: "user_dual_2",
          homeownerId: "user_dual_2",
          jobNo: "AT-1002",
        },
        "jobs/job_self_2/quotes/quote_self_2": {
          jobId: "job_self_2",
          tradespersonId: " user_dual_2 ",
          status: "accepted",
          milestones: [
            { id: "m1", title: "Stage 1", amount: 500, status: "pending" },
          ],
        },
        "users/ user_dual_2 ": {
          uid: "user_dual_2",
          stripeAccountId: "acct_dual_67890",
        },
      });

      await expect(
        resolveAuthoritativeLineItem(
          {
            metadata: {
              type: "milestone_funding",
              jobId: "job_self_2",
              quoteId: "quote_self_2",
              milestoneId: "m1",
            },
          },
          "user_dual_2",
          db
        )
      ).rejects.toThrow(/Self-payment is prohibited/i);
    });

    it("allows legitimate milestone funding when homeowner and tradesperson are distinct accounts", async () => {
      const db = createMockDb({
        "jobs/job_legit_1": {
          homeownerId: "homeowner_alice",
          jobNo: "AT-1003",
        },
        "jobs/job_legit_1/quotes/quote_legit_1": {
          jobId: "job_legit_1",
          tradespersonId: "trader_bob",
          status: "accepted",
          milestones: [
            { id: "m1", title: "First Fix", amount: 400, status: "pending" },
          ],
        },
        "users/trader_bob": {
          uid: "trader_bob",
          stripeAccountId: "acct_trader_bob_123",
        },
      });

      const resolved = await resolveAuthoritativeLineItem(
        {
          metadata: {
            type: "milestone_funding",
            jobId: "job_legit_1",
            quoteId: "quote_legit_1",
            milestoneId: "m1",
          },
        },
        "homeowner_alice",
        db
      );

      expect(resolved.authoritativeAmountPence).toBe(40000);
      expect(resolved.paymentIntentData?.transfer_data?.destination).toBe("acct_trader_bob_123");
      expect(resolved.metadata.traderId).toBe("trader_bob");
    });
  });

  describe("Trip Payment Authorization (tripPaymentAuthorization.ts)", () => {
    const createMockStripe = () => ({
      checkout: {
        sessions: {
          create: vi.fn(async () => ({
            id: "cs_test_legit_1",
            url: "https://checkout.stripe.com/c/pay/cs_test_legit_1",
            payment_intent: "pi_test_legit_1",
          })),
        },
      },
    });

    it("rejects self-booked trip payment when passengerId equals driverId", async () => {
      const db = createMockDb({
        "ride_requests/ride_self_1": {
          passengerId: "driver_self_1",
          driverId: "driver_self_1",
          assignedDriverId: "driver_self_1",
          status: "completed",
          fare: 30,
        },
        "users/driver_self_1": {
          uid: "driver_self_1",
          stripeAccountId: "acct_driver_self_1",
        },
      });
      const mockStripe = createMockStripe();

      await expect(
        executeCreateTripPaymentCommand({
          db,
          caller: { uid: "driver_self_1" },
          body: { rideId: "ride_self_1" },
          stripeClient: mockStripe as any,
        })
      ).rejects.toThrow(ForbiddenError);
      expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it("rejects self-payment on a corrupted passengerId === driverId ride even when invoked by an admin", async () => {
      const db = createMockDb({
        "ride_requests/ride_self_admin": {
          passengerId: "driver_self_2",
          driverId: "driver_self_2",
          status: "completed",
          fare: 45,
        },
        "users/driver_self_2": {
          uid: "driver_self_2",
          stripeAccountId: "acct_driver_self_2",
        },
      });
      const mockStripe = createMockStripe();

      await expect(
        executeCreateTripPaymentCommand({
          db,
          caller: { uid: "admin_user_1", isAdmin: true },
          body: { rideId: "ride_self_admin" },
          stripeClient: mockStripe as any,
        })
      ).rejects.toThrow(/Self-payment is prohibited/i);
      expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it("rejects driver-initiated checkout when passengerId is missing (effective payer === driver)", async () => {
      const db = createMockDb({
        "ride_requests/ride_no_passenger": {
          driverId: "driver_self_3",
          status: "completed",
          fare: 20,
        },
        "users/driver_self_3": {
          uid: "driver_self_3",
          stripeAccountId: "acct_driver_self_3",
        },
      });
      const mockStripe = createMockStripe();

      await expect(
        executeCreateTripPaymentCommand({
          db,
          caller: { uid: "driver_self_3" },
          body: { rideId: "ride_no_passenger" },
          stripeClient: mockStripe as any,
        })
      ).rejects.toThrow(ForbiddenError);
      expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it("allows legitimate driver-initiated QR/abandonment checkout for a distinct passenger", async () => {
      const db = createMockDb({
        "ride_requests/ride_distinct_1": {
          passengerId: "passenger_charlie",
          driverId: "driver_alice",
          assignedDriverId: "driver_alice",
          status: "in_transit",
          fare: 28,
        },
        "users/driver_alice": {
          uid: "driver_alice",
          stripeAccountId: "acct_driver_alice_1",
        },
      });
      const mockStripe = createMockStripe();

      const res = await executeCreateTripPaymentCommand({
        db,
        caller: { uid: "driver_alice" },
        body: { rideId: "ride_distinct_1" },
        stripeClient: mockStripe as any,
      });

      expect(res.success).toBe(true);
      expect(res.driverId).toBe("driver_alice");
      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("Payment Ledger Defense-in-Depth (paymentLedger.ts)", () => {
    it("rejects recordEscrowFunding when customerId equals traderId", async () => {
      const db = createMockDb({});

      await expect(
        PaymentLedgerEngine.recordEscrowFunding(db, {
          jobId: "job_ledger_self",
          milestoneId: "m1",
          customerId: "dual_user_9",
          traderId: "dual_user_9",
          verifiedAmount: 15000,
          currency: "gbp",
          paymentIntentId: "pi_self_1",
          idempotencyKey: "idem_self_1",
        })
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects releaseEscrowFunds when job homeownerId equals acceptedTradespersonId", async () => {
      const db = createMockDb({
        "jobs/job_release_self": {
          homeownerId: "dual_user_10",
          acceptedTradespersonId: "dual_user_10",
          acceptedQuoteId: "q_self_10",
          status: "in_progress",
        },
      });

      await expect(
        PaymentLedgerEngine.releaseEscrowFunds(db, {
          jobId: "job_release_self",
          quoteId: "q_self_10",
          milestoneId: "m1",
          authUid: "dual_user_10",
          idempotencyKey: "idem_rel_self_1",
        })
      ).rejects.toThrow(/Self-payment is prohibited/i);
    });

    it("rejects releaseEscrowFunds for self-owned job even when invoked by an admin", async () => {
      const db = createMockDb({
        "jobs/job_release_self_admin": {
          homeownerId: "dual_user_11",
          acceptedTradespersonId: "dual_user_11",
          acceptedQuoteId: "q_self_11",
          status: "in_progress",
        },
      });

      await expect(
        PaymentLedgerEngine.releaseEscrowFunds(db, {
          jobId: "job_release_self_admin",
          quoteId: "q_self_11",
          milestoneId: "m1",
          authUid: "admin_uid_1",
          isAdmin: true,
          idempotencyKey: "idem_rel_self_admin_1",
        })
      ).rejects.toThrow(ForbiddenError);
    });
  });
});
