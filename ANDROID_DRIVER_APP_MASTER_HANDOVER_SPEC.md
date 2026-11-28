# AnyRoller Android Driver App — Complete Master Handover Specification

**Target Repository:** `https://github.com/Saanwar2002/Drivers-App-Android-.git` (audited against commit `6e706dd`)  
**Main Platform Sync Status:** 100% Complete & Verified across Web Passenger Terminal, Web Driver Terminal, Express Backend, Firestore Security Rules, and Admin Controls (`PricingFares.tsx`).  
**Firebase Project:** `anytradercombined`  
**Named Firestore Database:** `ai-studio-anytrader-44dab8b3-bbc9-4352-b725-2cbe7a1dfd2a`  
**Auth Header for All Backend Routes:** `Authorization: Bearer <Firebase ID Token>`

> **Note to Android Developer Agent:** This is the **single consolidated master handover document** superseding the earlier incremental specs (`ANDROID_DRIVER_MATCHING_SYNC_SPEC.md`, `ANDROID_DRIVER_PAYMENT_SYNC_SPEC.md`, `ANDROID_DRIVER_PRICING_AND_LIVE_SYNC_SPEC.md`). Every requirement below has been audited directly against commit `6e706dd` of `Drivers-App-Android-` and verified live on the main platform backend.  
> **Non-Negotiable UI Lock:** Preserve the locked transparent `#2563EB` Heads-Up Navigation HUD styling (dark blue `#2563EB` text with subtle white drop shadow, transparent background, no black box).

---

## PART 1: Complete Platform Architecture & Final Web/Backend Mapping

Every ride workflow on the AnyRoller Web Platform is now **100% server-authoritative** with zero client-side `PERMISSION_DENIED` writes:

### 1.1 Passenger Terminal (`PassengerBooking.tsx`, `PassengerRideHistory.tsx`, `RidePaymentResult.tsx`)
1. **Booking Creation (`POST /api/rides/create`)**:
   - Auto-GPS reverse-geocoding (`<= 1500m` accuracy) + Google Places autocomplete + up to 3 multi-stop waypoints.
   - Canonical **7-tier vehicle catalog**: `standard (1.0x)`, `electric (1.15x)`, `executive (1.5x)`, `luxury (2.2x)`, `6seater (1.4x)`, `8seater (2.0x)`, `wav (2.5x)`.
   - Flat add-ons (NOT multiplied by vehicle tier or surge): **Priority Dispatch** (`+£3.00`, admin-configurable) and **Pet Friendly** (`+£3.00`, admin-configurable).
   - Server computes `baseCalc` and `fareEstimate` authoritatively using live `platform_config/rides` + a **Haversine road-distance floor (`1.12x`)**, blocks passengers with unpaid `users/{uid}.pendingCharges > 0`, stamps `journeyRevision: 0`, and triggers immediate 3-Wave Fairness Dispatch.
2. **Nearby Drivers (`GET /api/rides/nearby-drivers`)**:
   - Returns sanitized coarse pins (`~110m` rounded), `availableSoonCount` (stackable drivers), `availableCategories`, and `estimatedWaitEta` without exposing driver PII.
3. **Pre-Journey & Mid-Journey Edits (`POST /api/rides/:rideId/passenger-update`)**:
   - Enforces Admin `allowMidJourneyEdits` toggle during `in_progress`.
   - Pre-accept edits reset `offered` rides to `pending` and re-dispatch immediately.
   - Active-ride edits lock pickup, vehicle category, Priority/Pet add-ons, and already-completed stops (`< currentStopIndex`).
   - During `in_progress`, reads `live_tracking/{assignedDriverId}` live GPS inside the Firestore transaction and enforces an **actual-driven + remaining route** Haversine floor (`routePricingMode: "mid_journey_actual_plus_remaining"`) so miles already driven are never lost.
   - Atomically stamps `journeyRevision` (+1), `previousFareEstimate`, `fareDeltaGbp`, `lastPassengerEditSummary`, `priorityFee`, `petFee`, syncs `live_tracking/{driverId}.dropoffLat/Lng`, and sends high-priority FCM **`ride_journey_updated`**.
4. **Passenger Tips (`POST /api/rides/:rideId/tip`)**:
   - Strictly enforces **`0 <= tipAmount <= min(£50.00, platform_config/rides.maxTipGbp)`** across Passenger UI, keypad, server endpoint, and settlement calculator.
   - Tips are blocked once `awaiting_payment`/`completed` starts, receive **0% platform commission** (100% driver earnings), and fire an immediate FCM **`ride_tip_added`** push.
5. **Payment & Post-Ride (`RidePaymentResult.tsx`, `/payment-success`, `/payment-failed`)**:
   - Verified attached cards checked via `GET /api/payment-methods/:userId` (`hasCardOnFile`).
   - Automatic off-session Destination Charge (`auto_card`) with seamless fallback to live Stripe Checkout QR (`awaiting_payment`) on missing card, decline, or 3DS/SCA.
   - Public `/payment-success` & `/payment-failed` routes support logged-out guest phone camera QR scans via `GET /api/rides/payment-session-status?rideId=...&session_id=cs_...`.
   - Outstanding passenger balances settled via `POST /api/passenger/settle-pending-charges`.

### 1.2 Web Driver Terminal (`DriverTerminal.tsx`, `DriverMenu.tsx`, `DriverEarnings.tsx`) & Backend
1. **Unified 3-Wave Hybrid Fairness & Matching Engine (`rideOfferDispatch.ts`)**:
   - **Waves 1 & 2 (`dispatchAttempts < 2`)**: Exclusive 15s fairness-scored offers (`status: "offered"`, `dispatchMode: "fairness_exclusive"`) to the #1 approved, online, non-break driver (Proximity 35%, Earnings Fairness 25%, Real Idle Time 20%, Rating & Acceptance 10%, Destination/Stacking 10%).
   - **Wave 3 (`dispatchAttempts >= 2`)**: Controlled broadcast fallback (`status: "pending"`, `dispatchMode: "broadcast_fallback"`, top 5 drivers, `20 mi` radius, relaxed wait tolerance).
   - Hard eligibility gates: `driverApproved == true`, `onBreak != true`, `isLastJob != true`, `maxDailyDriverHours`, `chargesEnabled != false`, `pendingPlatformFees < maxPendingPlatformFeesGbp` (£50 default), vehicle category match (7 tiers including `electric`), `isPetFriendly` match, working zone (both pickup & dropoff), destination mode, and `<= 3.5 mi` stacking radius.
2. **Authoritative Lifecycle Endpoints (ZERO direct driver `updateDoc` calls on `ride_requests`)**:
   - `POST /api/rides/accept` — atomic accept/stacked-accept, preserves active ride dropoff on stack, links `live_tracking/{passengerId}`, updates `driver_metrics`.
   - `POST /api/rides/decline` — records decline & immediately triggers Wave 2/3 rollover (<1s).
   - `POST /api/rides/transition` — actions: `arrived`, `in_progress`, `stop_progress`, `early_completion_reason`, `update_eta`, **`sync_wait`** (syncs `paidWaitSeconds`), and **`cancel_cash_confirm`** (reverts `awaiting_cash_confirm` -> `in_progress` if driver taps back).
   - `POST /api/rides/create-trip-payment` — creates Stripe Connect Destination Charge Checkout link (Apple Pay / Google Pay / Link / Card enabled automatically; enforces `2.9% + £0.25` processing-fee floor + up to 50% automatic cash-commission debt recovery, never touching tips).
   - `POST /api/rides/complete` — actions: `auto_card` (returns `fallbackToQr: true` + `paymentUrl` on decline/3DS), `qr_pending` (accepts `checkoutSessionId`), `qr_manual_close` (verifies Stripe Checkout live; returns `409 Conflict` if unpaid), `cash_report`, `cash_finalize`, `abandonment`.
   - `POST /api/rides/:rideId/verify-payment` — live on-demand Stripe reconciliation.
   - `GET /api/driver/fee-settlement-status` — works **with or without `session_id`**, returning `{ pendingPlatformFees, maxPendingPlatformFeesGbp, dispatchPaused, lastAutoFeeRecoveryAmount }`.
   - `POST /api/rides/cancel` & `POST /api/rides/rate-passenger`.
3. **Admin Controls (`PricingFares.tsx` → `platform_config/rides`)**:
   - Live-publishes `baseFare`, `distanceRate`, `timeRate`, `waitRatePerMinute`, `minFare`, `commissionRate`, `fixedTripFee` (`0.00` default), `priorityFee` (`3.00`), `petFee` (`3.00`), `maxTipGbp` (`0–50`, hard-capped at `50.00`), `freeWaitMinutes` (`3`), `freeWaitSeconds` (`180` mirrored), `driverWaitTimeLimitMins` (`5`), `abandonmentFee` (`5.00`), `maxPendingPlatformFeesGbp` (`50.00`), `allowMidJourneyEdits` (`true`), `vehicleMultipliers`, and canonical 7-tier `vehicleTypes`.

---

## PART 2: Exact Required Changes in the Android Driver App

Implement the **5 Workstreams** below in `Drivers-App-Android-`. Every file path and bug reference was verified directly against commit `6e706dd`.

---

### WORKSTREAM 1: Matching Terminal Eligibility, Canonical 7 Vehicle Tiers & Break/Stacking Fixes

#### 1.1 Sync Canonical 7 Vehicle Categories (Including Electric) & `vehicleMultipliers`
- **Files:** `data/model/DriverModels.kt`, `data/repository/DriverFirestoreRepository.kt`, `data/repository/DriverPreferencesStore.kt`
- **Problem in `6e706dd`:** `defaultVehicleTypes()` uses legacy IDs (`mpv`, `van`, `vip`), omits `electric` and `wav`, and `parseRideConfig()` ignores `vehicleMultipliers` if `vehicleTypes` is absent.
- **Changes:**
  1. Replace `defaultVehicleTypes()` in `DriverModels.kt`:
     ```kotlin
     fun defaultVehicleTypes(): List<VehicleTypeConfig> = listOf(
         VehicleTypeConfig("standard", "Standard", 1.0),
         VehicleTypeConfig("electric", "Electric (EV)", 1.15),
         VehicleTypeConfig("executive", "Executive", 1.5),
         VehicleTypeConfig("luxury", "Luxury / VIP", 2.2),
         VehicleTypeConfig("6seater", "6-Seater XL", 1.4),
         VehicleTypeConfig("8seater", "8-Seater Minibus", 2.0),
         VehicleTypeConfig("wav", "Wheelchair Accessible", 2.5)
     )
     ```
  2. In `DriverFirestoreRepository.kt` (`parseRideConfig`), fall back to `doc.get("vehicleMultipliers") as? Map<*, *>` overlaid onto `defaultVehicleTypes()` when `vehicleTypes` is empty.
  3. In `DriverPreferencesStore.kt`, auto-migrate any cached legacy IDs on read: `"mpv" -> "6seater"`, `"van" -> "8seater"`, `"vip" -> "luxury"`.

#### 1.2 Strict Client-Side Offer Eligibility Guardrail (Pending Stream, FCM Push & Auto-Accept)
- **Files:** `data/model/DriverModels.kt`, `data/repository/DriverFirestoreRepository.kt`, `viewmodel/DriverTerminalViewModel.kt`
- **Problem in `6e706dd`:** `observePendingRideOffers()` streams up to 25 global `"pending"`/`"offered"` rides and only filters by `declinedOfferIds`/`assignedDriverId`, allowing Wave 3 broadcast rides from mismatched categories, pet-friendly rides, distant cities, or while `lastJob` is active to pop up or be **auto-accepted**.
- **Changes:**
  1. Add fields to `RideRequest` (`DriverModels.kt`) and parse them in `parseRideRequest()` (`DriverFirestoreRepository.kt`):
     - `isPetFriendly: Boolean = false` (`doc.getBoolean("isPetFriendly") ?: doc.getBoolean("petFriendly") ?: false`)
     - `isPriority: Boolean = false` (`doc.getBoolean("isPriority") ?: false`)
     - `priorityFee: Double? = null` (`doc.getDouble("priorityFee")`)
     - `petFee: Double? = null` (`doc.getDouble("petFee")`)
     - `declinedBy: List<String> = emptyList()` (merge `declinedBy` + `declinedDriverIds`)
     - `dispatchMode: String? = null`
     - `journeyRevision: Int = 0` (`(doc.getLong("journeyRevision") ?: 0L).toInt()`)
     - `previousFareEstimate: Double? = null` (`doc.getDouble("previousFareEstimate")`)
     - `fareDeltaGbp: Double? = null` (`doc.getDouble("fareDeltaGbp")`)
     - `lastPassengerEditSummary: String? = null` (`doc.getString("lastPassengerEditSummary")`)
     - `routePricingMode: String? = null` (`doc.getString("routePricingMode")`)
  2. Add single helper `isOfferEligibleForDriver(offer: RideRequest, state: DriverTerminalUiState, isStacked: Boolean): Boolean` in `DriverTerminalViewModel.kt` and call it for `validPending`, `UrgentPushEvent.RideOffer`, AND `Auto-Accept`:
     - Reject if `!state.isOnline || state.isOnBreak || state.profile.lastJob`.
     - Reject if `offer.passengerId == state.uid` or `offer.id in declinedOfferIds` or `state.uid in offer.declinedBy`.
     - Reject if `offer.status.equals("offered", true)` and (`offer.assignedDriverId != state.uid` or `offer.expiresAtMs in 1..System.currentTimeMillis()`).
     - Reject if `offer.isPetFriendly && !state.localPetFriendly`.
     - Reject if `offer.vehicleCategory` is non-blank/`!= "any"` and not in `state.localVehicleCategories` (case-insensitive).
     - Reject future scheduled rides (`scheduledTime > now + 25 min`) from instant offers.
     - Distance check (when GPS fix valid): `<= 3.5 mi` from `activeRide.dropoffLat/Lng` when `isStacked`; else `<= max(15.0, platformConfig.dispatchRadiusMiles)` (or `20.0` for `broadcast_fallback`).
     - Working Zone check (`zoneEnabled`): both pickup and dropoff within `zoneMaxDistance` of `homeLat/Lng`.
     - Destination Mode check (`destinationModeActive`): `dist(dropoff, home) <= dist(pickup, home)`.
     - Sort eligible offers: directed `offered` first → `isPriority` → closest pickup.
  3. Optional Auto-Accept guardrails (Auto-Accept remains OFF by default): `autoAcceptMinGbpPerHour`, `autoAcceptAllowMultiStop`, `autoAcceptOnlyTowardHome` — always gated behind `isOfferEligibleForDriver()`.

#### 1.3 Fix Coffee Cup Break GPS Overwrite, Stacked Dropoff Clobber & Instant Timeout Decline
- **Files:** `service/DriverLocationService.kt`, `data/repository/DriverFirestoreRepository.kt`, `viewmodel/DriverTerminalViewModel.kt`
- **Fixes:**
  1. **Coffee Cup Break GPS Overwrite:** Add `isOnBreak: Boolean` to `DriverLocationService` state and `mergeLiveTracking(...)`. When `isOnBreak == true`, write `live_tracking.onBreak = true`, `live_tracking.status = "busy"`, `driver_status.isBusy = true`, `driver_status.onBreak = true`, `driver_status.status = "busy"`, and stamp `lastHeartbeatAtMs`. Also write `"onBreak" to onBreak` onto `live_tracking/{uid}` inside `setDriverBreakStatus()`.
  2. **Stacked Accept Dropoff Clobber:** In `DriverTerminalViewModel.acceptOffer()`, **remove** `repository.syncActiveRideDropoff(uid, offer.dropoffLat, offer.dropoffLng)` when `isStacked == true` (backend `POST /api/rides/accept` already preserves active dropoff and promotes queued dropoff automatically when the active trip ends). Also remove legacy `claimOfferedRideTransaction` direct-Firestore fallback — `POST /api/rides/accept` handles `"offered"` rides atomically.
  3. **Instant Timeout Rollover:** Inside `handleOfferTimedOut(offerId)`, invoke `ApiClient.service.declineRide(RideDeclineRequest(rideId = offerId))` so Wave 2/3 rolls over in `<1s`.

---

### WORKSTREAM 2: Stripe Connect Zero-Money-Loss Payment Hardening

#### 2.1 Update Network DTOs & API Service
- **Files:** `data/network/ApiDtos.kt`, `data/network/AnyRollerApiService.kt`
- **Changes:**
  1. Add `val sessionId: String? = null` to `CreateTripPaymentResponse`.
  2. Add `val checkoutSessionId: String? = null` to `RideCompleteRequest` and pass `payRes.data.sessionId` when calling `completeRide(action = "qr_pending")`.
  3. Extend `CompleteRideResponse` with:
     ```kotlin
     val rideId: String? = null,
     val paymentStatus: String? = null,
     val paymentMethod: String? = null,
     val cashFeesRecoveredGbp: Double? = null,
     val fallbackToQr: Boolean = false,
     val fallbackReason: String? = null,
     val fallbackMessage: String? = null,
     val paymentUrl: String? = null,
     val sessionId: String? = null,
     val verifiedByStripe: Boolean = false
     ```
  4. Extend `FeeSettlementStatusResponse` with:
     ```kotlin
     val settled: Boolean = false,
     val status: String? = null,
     val maxPendingPlatformFeesGbp: Double = 50.0,
     val dispatchPaused: Boolean = false,
     val lastFeeSettlementAmount: Double = 0.0,
     val lastAutoFeeRecoveryAmount: Double = 0.0
     ```
  5. Add endpoint to `AnyRollerApiService.kt`:
     ```kotlin
     @POST("/api/rides/{rideId}/verify-payment")
     suspend fun verifyRidePayment(@Path("rideId") rideId: String): Response<CompleteRideResponse>
     ```
  6. Update `RideTransitionRequest` action doc/usage to include `"sync_wait"` (passing `paidWaitSeconds`) and `"cancel_cash_confirm"` (never write `paidWaitSeconds` or `reportedCashCollected` directly to Firestore!).

#### 2.2 Handle `auto_card` → QR Fallback & Verified `qr_manual_close` (CRITICAL BUG FIX)
- **Files:** `viewmodel/DriverTerminalViewModel.kt`, `ui/screens/ActiveRideOverlays.kt`
- **Bugs caught in `6e706dd`:**
  - `DriverTerminalViewModel.kt:2758` unconditionally calls `finishIntoReview(...)` on `auto_card` HTTP 200 without checking `res.data.fallbackToQr == true`!
  - `ActiveRideOverlays.kt:1752` computes `val action = if (ride.hasCardOnFile) "auto_card" else "qr_manual_close"` — if `auto_card` fell back to QR (`paymentQrUrl != null`), `ride.hasCardOnFile` is STILL `true`, trapping the driver in a 3DS retry loop!
- **Fixes:**
  1. In `DriverTerminalViewModel.kt` (`completeRide` for `auto_card` AND `completeTripWithAction`):
     - Check `if (res.data.fallbackToQr)`: do **NOT** jump to `REVIEW`! Stay on `COMPLETED_PAYMENT`, update `activeRide = applyCompleteResponse(ride, res.data)`, set `paymentQrUrl = res.data.paymentUrl`, and show `toastMessage = res.data.fallbackMessage ?: "Card needs confirmation — passenger can scan QR or pay in app."`.
     - Only call `finishIntoReview(...)` when `res.data.status == "completed" && !res.data.fallbackToQr`.
     - For `qr_manual_close`: if server returns HTTP `409 Conflict`, keep QR overlay open and display the server message (*"Stripe has not confirmed payment yet — ask passenger to finish checkout or switch to Cash"*). Keep Firestore listener active so it auto-advances to `REVIEW` the moment `status == "completed" && paymentStatus == "paid"`.
  2. In `ActiveRideOverlays.kt:1752`:
     ```kotlin
     val isQrFallbackOrQr = !state.paymentQrUrl.isNullOrBlank() || !ride.hasCardOnFile
     val action = if (isQrFallbackOrQr) "qr_manual_close" else "auto_card"
     ```
     Rename the QR confirmation button copy to **`"CHECK / CONFIRM PAYMENT"`** with helper caption *"Auto-finishes as soon as Stripe confirms payment"*, keeping `"Switch to Cash"` directly underneath.

#### 2.3 Stripe Capability Check & £50 Cash-Fee Cap Banner
- **Files:** `viewmodel/DriverTerminalViewModel.kt`, `ui/screens/DriverEarningsScreen.kt`
- **Changes:**
  1. Require `profile.stripeAccountId != null && profile.chargesEnabled != false && profile.payoutsEnabled != false` before treating payouts/card acceptance as ready. Otherwise show *"Finish Stripe Verification"* calling `POST /api/stripe/create-connect-account` (`returnTarget: "driver-return"`).
  2. In `DriverEarningsScreen.kt`, read `pendingPlatformFees`, `maxPendingPlatformFeesGbp`, and `dispatchPaused` from `GET /api/driver/fee-settlement-status` (now returns HTTP 200 without `session_id`):
     - If `dispatchPaused == true`, show red warning banner: *"Dispatch paused (£${maxPendingPlatformFeesGbp.toInt()} cash fee cap) — settle now to resume rides."*
     - If `pendingPlatformFees > 0 && !dispatchPaused`, show caption: *"Auto-deducted from card trips, or settle anytime."*

---

### WORKSTREAM 3: Pricing Parity, £50.00 Maximum Tip Cap & Live `platform_config/rides` Fields

- **Files:** `data/model/DriverModels.kt`, `data/model/RideFinancialResolver.kt`, `data/repository/DriverFirestoreRepository.kt`, `ui/screens/ActiveRideOverlays.kt`
- **Changes:**
  1. Extend `RidePlatformConfig` (`DriverModels.kt`) and `parseRideConfig()` (`DriverFirestoreRepository.kt`) with:
     - `val petFee: Double = 3.0` (`doc.getDouble("petFee") ?: 3.0`)
     - `val maxTipGbp: Double = 50.0` (`(doc.getDouble("maxTipGbp") ?: 50.0).coerceIn(0.0, 50.0)`)
     - `val freeWaitMinutes: Int = 3` (`(doc.getLong("freeWaitMinutes") ?: 3L).toInt()`)
     - `freeWaitSeconds`: compute as `(doc.getLong("freeWaitSeconds") ?: ((doc.getLong("freeWaitMinutes") ?: 3L) * 60L)).toInt()`
     - `val driverWaitTimeLimitMins: Int = 5` (`(doc.getLong("driverWaitTimeLimitMins") ?: 5L).toInt()`)
     - `val abandonmentFee: Double = 5.0` (`doc.getDouble("abandonmentFee") ?: 5.0`)
     - `val maxPendingPlatformFeesGbp: Double = 50.0` (`doc.getDouble("maxPendingPlatformFeesGbp") ?: 50.0`)
     - `val allowMidJourneyEdits: Boolean = true` (`doc.getBoolean("allowMidJourneyEdits") ?: true`)
     - Align defaults: `baseFare = 3.5`, `distanceRate = 1.3`, `fixedTripFee = 0.0`.
  2. **£50.00 Tip Cap Enforcement:**
     - In `DriverFirestoreRepository.parseRideRequest()` and `RideFinancialResolver.kt`, clamp `tipAmount = rawTip.coerceIn(0.0, 50.0)` (and `<= platformConfig.maxTipGbp`).
     - Tips remain 100% driver-owned (0% platform commission).
  3. **Trip Summary & Breakdown UI (`ActiveRideOverlays.kt`)**:
     - Show **Pet Friendly (`+£petFee`)** row whenever `ride.isPetFriendly == true`.
     - Show **Priority (`+£priorityFee`)** row whenever `ride.isPriority == true`.
     - Display dynamic `platformConfig.abandonmentFee` (instead of hardcoded `£5.00`) on `rider_abandoned` rides.
     - Always prefer authoritative `ride.totalFarePaid` on the Payment QR headline total once set.

---

### WORKSTREAM 4: Instant Real-Time Pre-Journey & Mid-Journey Passenger Sync (Zero Alert Loops, Zero 60s Route Lag)

- **Files:** `service/AnyRollerMessagingService.kt`, `service/UrgentPushEventBus.kt`, `viewmodel/DriverTerminalViewModel.kt`, `data/repository/DirectionsRepository.kt`, `ui/screens/ActiveRideOverlays.kt`, `ui/screens/DriverTerminalScreen.kt`, `service/FloatingRideOverlayController.kt`
- **Bugs caught in `6e706dd`:**
  1. `DriverTerminalViewModel.kt:1326` checks `... || currentActive.isModifiedByPassenger`. Because `firestore.rules` forbids drivers from clearing `isModifiedByPassenger`, it stays `true` forever and fires repeated false alerts on every snapshot!
  2. `AnyRollerMessagingService.kt` falls through to `else` for `"ride_journey_updated"` and `"ride_tip_added"`, misclassifying them as chat messages instead of triggering instant route refresh + TTS!
  3. Stop-only edits (same final dropoff) do not invalidate the Directions throttle/cache immediately.
- **Changes:**
  1. **Add Dedicated FCM Event Types (`UrgentPushEventBus.kt` & `AnyRollerMessagingService.kt`)**:
     - Add to `UrgentPushEvent`:
       ```kotlin
       data class JourneyUpdated(
           val rideId: String,
           val journeyRevision: Int,
           val fareEstimate: Double?,
           val fareDeltaGbp: Double?,
           val dropoff: String?,
           val dropoffLat: Double?,
           val dropoffLng: Double?,
           val stopsCount: Int?,
           val editSummary: String?
       ) : UrgentPushEvent()

       data class TipAdded(
           val rideId: String,
           val tipAmount: Double
       ) : UrgentPushEvent()
       ```
     - Handle `when (type)` in `AnyRollerMessagingService.onMessageReceived()`:
       - `"ride_journey_updated"` → parse `journeyRevision`, `fareEstimate`, `fareDeltaGbp`, `dropoff`, `dropoffLat`, `dropoffLng`, `stopsCount`, `editSummary` and emit `UrgentPushEvent.JourneyUpdated(...)` + show heads-up notification on `CHANNEL_CHAT_UPDATES`.
       - `"ride_tip_added"` → parse `tipAmount` (clamped `0.0..50.0`) and emit `UrgentPushEvent.TipAdded(rideId, tipAmount)` + show notification.
  2. **Monotonic Revision Tracking (`DriverTerminalViewModel.kt`)**:
     - Maintain `private var lastSeenJourneyRevision: Int = 0` and `private var lastSeenTipAmount: Double = 0.0` (reset when `activeRide?.id` changes).
     - **NEVER** write `isModifiedByPassenger = false` from Android!
     - On Firestore snapshot OR `UrgentPushEvent.JourneyUpdated`:
       - Trigger edit alert ONLY when `incomingRevision > lastSeenJourneyRevision` (or fallback content diff `stopsChanged || dropoffChanged || pickupChanged || fareChanged` when `incomingRevision == 0`).
       - Advance `lastSeenJourneyRevision = max(lastSeenJourneyRevision, incomingRevision)`.
       - **Immediately invalidate Directions fetch cache/throttle** (include `stopsSignature` + `journeyRevision` in route cache key, bypass 60s cooldown, reset `recalcCount = 0`) and immediately call `DirectionsRepository` with updated `stops` waypoints & `dropoffLat/Lng` so polyline, Heads-Up Navigation HUD, and ETA refresh instantaneously!
       - Display `lastPassengerEditSummary` + signed `fareDeltaGbp` (`+£X.XX` / `-£X.XX`) + updated `£fareEstimate` in a dismissible 14-second amber banner inside the active trip sheet, play alert chime, and speak via TTS: `"Journey updated by passenger. $summary"`.
       - If driver had external navigation open (Google Maps/Waze), warn driver to restart navigation with the new destination.
     - On Firestore snapshot OR `UrgentPushEvent.TipAdded`:
       - Trigger ONLY when `incomingTip > lastSeenTipAmount + 0.009`.
       - Advance `lastSeenTipAmount = incomingTip`, play chime, speak `"Passenger added a £%.2f tip!".format(incomingTip)`, and show celebratory toast/banner.
     - Also update `syncActiveRideDropoff` note: backend `/passenger-update` already syncs `live_tracking/{driverId}.dropoffLat/Lng` atomically, so no redundant client write is needed.

---

### WORKSTREAM 5: Rich Offer Badges & Zero Direct Driver `ride_requests` Writes

- **Files:** `service/AnyRollerMessagingService.kt`, `data/model/DriverModels.kt`, `ui/screens/DriverTerminalScreen.kt`, `service/FloatingRideOverlayController.kt`, `viewmodel/DriverTerminalViewModel.kt`
- **Changes:**
  1. Parse `isPriority`, `isPetFriendly`, `stopCount`, `passengerRating`, `paymentMethod`, and `dispatchMode` in `IncomingOfferPush` (`AnyRollerMessagingService.kt`) and map onto the synthetic `RideRequest`.
  2. Render compact chips on both the in-app offer sheet and floating overlay:
     - **`⚡ PRIORITY`** when `offer.isPriority`
     - **`🐾 PET (+£3.00)`** when `offer.isPetFriendly`
     - **`📍 N STOPS`** when `stops.isNotEmpty() || stopCount > 0`
     - **`⚡ ELECTRIC`** (or tier label) for `electric` / upgraded tiers
     - **`★ 4.9`** rating + **`AUTO CARD` / `QR / CASH`** badge.
  3. Audit all driver writes in `DriverFirestoreRepository.kt`: ensure **zero** direct Firestore updates to `ride_requests/{rideId}` outside safe status/location (use `POST /api/rides/transition` with `action = "sync_wait"` for wait time updates and `action = "cancel_cash_confirm"` if reverting a cash discrepancy confirmation).

---

## PART 3: Final End-to-End Verification Checklist for Android Agent

- [ ] **Matching & Categories**: Driver with only `standard` enabled NEVER sees or auto-accepts `electric`, `6seater`, `8seater`, `luxury`, `wav`, or `isPetFriendly: true` rides (including Wave 3 broadcasts). Selecting `Electric (EV)` writes `"electric"` to `live_tracking/{uid}.vehicleCategories`.
- [ ] **Break & Stacking**: Coffee Cup Break keeps `live_tracking.status == "busy"` and `onBreak == true` across multiple 4.5s GPS ticks. Accepting a stacked ride preserves active ride `dropoffLat/Lng`. Letting an offer time out invokes `POST /api/rides/decline` for instant `<1s` rollover.
- [ ] **Payments & Zero-Money-Loss**:
  - `auto_card` returning `fallbackToQr: true` keeps driver on QR Payment screen with live `paymentUrl` and switches the green CTA to `"CHECK / CONFIRM PAYMENT"` (`qr_manual_close`), never looping back to `auto_card`.
  - `qr_manual_close` returning HTTP `409` keeps QR open and alerts driver; auto-advances to Review as soon as Stripe webhook marks `status == "completed" && paymentStatus == "paid"`.
  - `GET /api/driver/fee-settlement-status` (no query params) populates `pendingPlatformFees` and shows the £50 dispatch-pause warning when `dispatchPaused == true`.
  - Stripe capability check enforces `chargesEnabled != false && payoutsEnabled != false`.
- [ ] **£50.00 Tip Cap & Pet Line Item**: Tips are capped at `<= £50.00`, receive 0% commission, trigger live TTS/toast on addition, and Pet Friendly (`+£petFee`) renders on both offer cards and trip summary breakdown.
- [ ] **Real-Time Pre-Journey & Mid-Journey Sync**:
  - Adding a stop or changing dropoff on the Passenger Terminal immediately triggers `ride_journey_updated` FCM + Firestore `journeyRevision` increment, redraws polyline/HUD/ETA immediately (bypassing 60s throttle), displays the fare delta banner, and fires **exactly once** per revision with zero `PERMISSION_DENIED` errors.
  - Locked transparent `#2563EB` Heads-Up Navigation HUD styling remains completely untouched.
