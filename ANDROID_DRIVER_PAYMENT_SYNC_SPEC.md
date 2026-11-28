# AnyRoller Android Driver App — Stripe Connect & Payment Sync Spec

**Scope**: Standalone Android Driver App (`Drivers-App-Android-`) synchronization with the hardened AnyRoller backend and Web Passenger/Driver Terminals.  
**Backend Status**: Live & verified in `server.ts`, `src/server/tripPaymentAuthorization.ts`, `src/server/rideLifecycleCommands.ts`, `src/server/rideFareCalculator.ts`, and `src/server/rideOfferDispatch.ts`.

---

## 1. What Changed on the Backend (Zero-Money-Loss Safeguards)

1. **Real `auto_card` Stripe Charge + Automatic QR Fallback** (`POST /api/rides/complete` with `action: "auto_card"`):
   - Backend now executes a real off-session Stripe Connect Destination Charge `PaymentIntent` against the passenger's verified saved card.
   - If the passenger has no attached card, the card declines, or 3DS/SCA (`authentication_required`) is needed, the endpoint returns **HTTP 200** with:
     ```json
     {
       "success": true,
       "rideId": "...",
       "status": "awaiting_payment",
       "fallbackToQr": true,
       "fallbackReason": "authentication_required",
       "fallbackMessage": "Passenger card requires confirmation. Show the QR code or ask passenger to tap Pay in app.",
       "paymentUrl": "https://checkout.stripe.com/c/pay/cs_...",
       "sessionId": "cs_...",
       "finalFare": 25.0,
       "tipAmount": 0.0,
       "totalFarePaid": 25.0
     }
     ```
2. **Live Stripe Verification on `qr_manual_close`** (`POST /api/rides/complete` with `action: "qr_manual_close"`):
   - Backend now checks Stripe Checkout Session `payment_status` live before closing.
   - If paid in Stripe (even if the webhook is slightly delayed), it reconciles immediately and returns `{ success: true, status: "completed", paymentStatus: "paid", verifiedByStripe: true }`.
   - If **unpaid**, it returns **HTTP 409 Conflict** with an actionable error message so an unpaid QR trip is never closed accidentally.
   - Dedicated endpoint `POST /api/rides/:rideId/verify-payment` is also available to poll/reconcile on demand.
3. **Automatic Cash-Commission Recovery & £50 Debt Cap**:
   - Card/QR trips automatically deduct owed `users/{driverId}.pendingPlatformFees` inside `application_fee_amount` (capped at 50% of the driver's base fare share; passenger tips are never touched) and atomically reduce `users/{driverId}.pendingPlatformFees` upon settlement.
   - Drivers whose `pendingPlatformFees >= 50` (configurable via `platform_config/rides.maxPendingPlatformFeesGbp`) or `chargesEnabled == false` are skipped by server ride dispatch (`reason: "pending_fees_limit"` / `"stripe_onboarding_incomplete"`).
4. **Fixed `GET /api/driver/fee-settlement-status` without `session_id`**:
   - Calling `GET /api/driver/fee-settlement-status` with NO `session_id` query param now returns **HTTP 200**:
     ```json
     {
       "settled": false,
       "status": "outstanding",
       "pendingPlatformFees": 12.5,
       "maxPendingPlatformFeesGbp": 50,
       "dispatchPaused": false,
       "lastFeeSettlementAmount": 0,
       "lastAutoFeeRecoveryAmount": 5.4
     }
     ```
5. **Fixed Redirect Routes**:
   - `/payment-success`, `/payment-failed` (publicly accessible for guest phone camera QR scans), `/driver-return`, and `/driver-dashboard` are now mounted on the web platform so neither Stripe Checkout nor Android Custom Tabs hit a 404.
   - `POST /api/driver/settle-fees` now uses `/billing` as `cancel_url`.

---

## 2. Required Android Driver App Updates (4 Surgical Changes)

### Change A — `DriverRepository.kt` / `CompleteRideResponse` DTO
Add the new optional response fields from `POST /api/rides/complete`:
```kotlin
data class CompleteRideResponse(
    val success: Boolean = false,
    val rideId: String? = null,
    val status: String? = null,
    val paymentStatus: String? = null,
    val paymentMethod: String? = null,
    val finalFare: Double? = null,
    val tipAmount: Double? = null,
    val totalFarePaid: Double? = null,
    val driverEarnings: Double? = null,
    val platformFee: Double? = null,
    val cashFeesRecoveredGbp: Double? = null,
    val fallbackToQr: Boolean = false,
    val fallbackReason: String? = null,
    val fallbackMessage: String? = null,
    val paymentUrl: String? = null,
    val sessionId: String? = null,
    val verifiedByStripe: Boolean = false
)
```
When calling `POST /api/rides/complete` with `action = "qr_pending"`, also include `checkoutSessionId = tripPaymentResponse.sessionId` in the JSON body (returned by `POST /api/rides/create-trip-payment`).

### Change B — `DriverTerminalViewModel.kt` (`auto_card` QR Fallback + Verified QR Close)
1. **In `completeRideWithAutoCard(...)`**:
   - If `response.fallbackToQr == true`:
     - Do **NOT** transition to `"review"` / `"idle"`.
     - Set `paymentUrl = response.paymentUrl`, keep the QR payment overlay open, and display `response.fallbackMessage ?: "Card needs confirmation — passenger can scan QR or pay in app"`.
   - Only transition to `"review"` when `response.status == "completed" && response.paymentStatus == "paid"`.
2. **In `confirmQrPaymentReceived(...)` (`action = "qr_manual_close"`)**:
   - If the server returns HTTP `409`:
     - Keep the QR overlay open!
     - Show a Snackbar/Toast with the server error message (*"Stripe has not confirmed payment yet — ask passenger to finish checkout or switch to Cash."*).
   - Continue listening to `ride_requests/{rideId}` via Firestore snapshot: as soon as `status == "completed" && paymentStatus == "paid"`, automatically dismiss the QR overlay and move to the Review screen.

### Change C — `ActiveRideOverlays.kt` (QR Payment Screen Copy)
- Rename the primary green button from `"MARK PAYMENT COMPLETE"` to `"CHECK / CONFIRM PAYMENT"` with a subtle helper label: *"Closes automatically once Stripe confirms payment."*
- Keep the existing `"Switch to Cash"` button directly below it so drivers can record cash payment if a passenger decides to pay cash instead of scanning.

### Change D — `DriverTerminalViewModel.kt` & `DriverEarningsScreen.kt` (Stripe Capability & Debt Cap Gate)
- **Going Online / Stripe Setup Check**: Check `profile.stripeAccountId != null && profile.chargesEnabled != false && profile.payoutsEnabled != false` (instead of checking `stripeAccountId != null` alone). If `chargesEnabled == false || payoutsEnabled == false`, display *"Finish Stripe Verification"* launching `POST /api/stripe/create-connect-account` with `{ "returnTarget": "driver-return" }`.
- **Fees Owed Card (`DriverEarningsScreen.kt`)**: Read `pendingPlatformFees` and `dispatchPaused` from `GET /api/driver/fee-settlement-status` (which now returns HTTP 200 without `session_id`!).
  - If `dispatchPaused == true` (`pendingPlatformFees >= 50.0`), show a red banner: *"Dispatch paused (£50 cash fee cap) — settle now to go online."*
  - Otherwise, if `pendingPlatformFees > 0`, show subtle caption: *"Auto-deducted from card trips, or settle anytime."*
