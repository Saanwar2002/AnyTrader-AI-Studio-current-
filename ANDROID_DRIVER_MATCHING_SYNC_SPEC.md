# AnyRoller Android Driver App — Matching Terminal Sync & Hardening Spec

**Target Repository:** `https://github.com/Saanwar2002/Drivers-App-Android-.git` (baseline commit `6e706dd`)
**Main Platform Sync Status:** Backend unified into a single **3-Wave Hybrid Fairness + Broadcast Matching Engine** (`src/server/rideOfferDispatch.ts`, `src/server/driverAuthorization.ts`, `server.ts`, `PricingFares.tsx`) with canonical 7-tier vehicle categories including **Electric (`electric`, 1.15x)**.
**Firestore Project / Named DB:** `anytradercombined` / `ai-studio-anytrader-44dab8b3-bbc9-4352-b725-2cbe7a1dfd2a`

---

## Summary of Main Platform Changes Now Live

1. **Unified 3-Wave Hybrid Dispatch Engine (replaces competing broadcast vs fairness loops)**:
   - **Wave 1 (0–15s)**: Exclusive Fairness offer (`status: "offered"`, `assignedDriverId`, `offerExpiresAt` / `offerExpiresAtMs`, `dispatchWave: 1`, `dispatchMode: "fairness_exclusive"`) to the #1 eligible driver scored across Proximity (35%), Earnings Fairness (25%), Real Idle Time (20%), Rating & Acceptance Reliability (10%), and Destination/Stacking Route Efficiency (10%).
   - **Wave 2 (15–30s)**: Instant rollover to #2 eligible driver immediately on `POST /api/rides/decline` (no 10s cron wait) or on 15s timeout expiry.
   - **Wave 3 (30s+)**: Controlled broadcast fallback (`status: "pending"`, `dispatchMode: "broadcast_fallback"`) to top 5 fairness-ranked eligible drivers with expanded radius (`20 mi`) and relaxed `waitTolerance`.
   - **Priority Boost & Scheduled Rides**: Priority rides (`isPriority: true`) are dispatched ahead of standard rides; scheduled rides (`scheduledTime`) > 25 minutes in the future are held out of instant dispatch.
2. **Canonical 7 Vehicle Categories Synced in `platform_config/rides`**:
   - Both `vehicleMultipliers` (map) and `vehicleTypes` (array) now publish:
     - `standard` — Standard (`1.0x`)
     - `electric` — Electric (EV) (`1.15x`)
     - `executive` — Executive (`1.5x`)
     - `luxury` — Luxury / VIP (`2.2x`)
     - `6seater` — 6-Seater XL (`1.4x`)
     - `8seater` — 8-Seater Minibus (`1.8x`)
     - `wav` — Wheelchair Accessible (`1.2x`)
3. **Enriched FCM Offer Push `data` Payload (`channelId: "ride_offers_urgent"`)**:
   - Now always includes real `pickupAddress`, `dropoffAddress`, `fareEstimate`, `vehicleCategory`, `isPriority`, `isPetFriendly`, `stopCount`, `passengerRating`, `paymentMethod`, `dispatchMode`, `distanceMiles`, `offeredAtMs`, and `expiresAtMs`.
4. **Fairness Telemetry on Accept & Decline**:
   - `POST /api/rides/accept` now stamps `driver_metrics/{uid}.lastAssignmentAt`, `lastAssignmentAtMs`, and increments `acceptedOffersCount`.
   - `POST /api/rides/decline` increments `driver_metrics/{uid}.declinedOffersCount` and immediately triggers Wave 2/3 re-dispatch.

---

## Required Changes in the Android Driver App

### P0-1: Add Strict Client-Side Eligibility Guardrails on `validPending`, FCM Offers & Auto-Accept
**Files:** `data/model/DriverModels.kt`, `data/repository/DriverFirestoreRepository.kt`, `viewmodel/DriverTerminalViewModel.kt`

**Problem:** Currently `observePendingRideOffers()` streams up to 25 rides globally (`status in ["offered", "pending", "searching"]`) and `reconcileRidesAndOffers()` filters ONLY by `declinedOfferIds` and `assignedDriverId`. As a result, broadcast `"pending"` rides (Wave 3) from anywhere in the country—or mismatched vehicle categories, pet-friendly rides, out-of-zone rides, or `isLastJob` rides—can pop up or even be **auto-accepted**!

**Fix:**
1. In `DriverModels.kt` (`RideRequest`), add fields:
   - `val isPetFriendly: Boolean = false`
   - `val isPriority: Boolean = false`
   - `val declinedBy: List<String> = emptyList()`
   - `val dispatchMode: String? = null`
2. In `DriverFirestoreRepository.kt` (`parseRideRequest`), parse:
   - `isPetFriendly = doc.getBoolean("isPetFriendly") ?: doc.getBoolean("petFriendly") ?: false`
   - `isPriority = doc.getBoolean("isPriority") ?: false`
   - `declinedBy`: merge string arrays `declinedBy` + `declinedDriverIds`
   - `dispatchMode = doc.getString("dispatchMode")`
3. In `DriverTerminalViewModel.kt`, create a single helper `isOfferEligibleForDriver(offer: RideRequest, state: DriverTerminalUiState, isStacked: Boolean): Boolean` and enforce it on **all three entry points** (`validPending`, `UrgentPushEvent.RideOffer`, and `Auto-Accept`):
   - Reject if `!state.isOnline || state.isOnBreak`.
   - Reject if `offer.passengerId == state.uid` (self-ride).
   - Reject if `offer.id in declinedOfferIds || state.uid in offer.declinedBy`.
   - Reject if `offer.status.equals("offered", true) && offer.assignedDriverId != state.uid`.
   - Reject if `offer.status.equals("offered", true) && offer.expiresAtMs in 1..System.currentTimeMillis()`.
   - Reject if `state.profile.lastJob` is true (do not show new idle OR stacked offers when Last Job is active).
   - Reject if `offer.isPetFriendly && !state.localPetFriendly`.
   - Reject if `offer.vehicleCategory.lowercase()` is not in `state.localVehicleCategories.map { it.lowercase() }` (except when `offer.vehicleCategory` is blank/`any`).
   - Reject future scheduled rides (`offer.scheduledTime` > 25 minutes from now) from instant pop-up offers (display those only in the Scheduled Jobs screen).
   - Distance check (when `state.driverLocation.hasRealFix` and pickup coords valid):
     - If `isStacked`: compute distance from `activeRide.dropoffLat/Lng` to `offer.pickupLat/Lng` and reject if `> 3.5 miles`.
     - If idle: compute distance from `driverLocation` to `offer.pickupLat/Lng` and reject if `> state.platformConfig.dispatchRadiusMiles.coerceAtLeast(15.0)` (or `20.0` for `dispatchMode == "broadcast_fallback"`).
   - Working Zone check (`state.profile.zoneEnabled` with valid `homeLat`/`homeLng`): reject if pickup OR dropoff distance from home `> state.profile.zoneMaxDistance`.
   - Destination Mode check (`state.profile.destinationModeActive` with valid `homeLat`/`homeLng`): reject if `dist(dropoff, home) > dist(pickup, home)`.
   - **Sort eligible offers**: directed `status == "offered"` first, then `isPriority == true`, then closest pickup distance!

---

### P0-2: Sync Canonical 7 Vehicle Categories (Including Electric) & Parse `vehicleMultipliers`
**Files:** `data/model/DriverModels.kt`, `data/repository/DriverFirestoreRepository.kt`

**Problem:** `defaultVehicleTypes()` currently uses `mpv`, `van`, `vip` instead of `6seater`, `8seater`, `luxury`, and is missing `electric` and `wav`. Also `parseRideConfig()` only reads `vehicleTypes` (missing fallback to `vehicleMultipliers` map).

**Fix:**
1. Update `defaultVehicleTypes()` in `DriverModels.kt`:
```kotlin
fun defaultVehicleTypes(): List<VehicleTypeConfig> = listOf(
    VehicleTypeConfig("standard", "Standard", 1.0),
    VehicleTypeConfig("electric", "Electric (EV)", 1.15),
    VehicleTypeConfig("executive", "Executive", 1.5),
    VehicleTypeConfig("luxury", "Luxury / VIP", 2.2),
    VehicleTypeConfig("6seater", "6-Seater XL", 1.4),
    VehicleTypeConfig("8seater", "8-Seater Minibus", 1.8),
    VehicleTypeConfig("wav", "Wheelchair Accessible", 1.2)
)
```
2. In `DriverFirestoreRepository.kt` (`parseRideConfig`):
   - If `doc.get("vehicleTypes")` is non-empty, parse it as before.
   - Otherwise, if `doc.get("vehicleMultipliers")` is a `Map<String, Any?>`, overlay its multiplier values onto `defaultVehicleTypes()` so admin rate changes always sync.
3. Migrate any legacy locally cached category IDs in `DriverPreferencesStore`:
   - `"mpv"` → `"6seater"`, `"van"` → `"8seater"`, `"vip"` → `"luxury"`.

---

### P0-3: Prevent `DriverLocationService` GPS Ticks from Overwriting Coffee Cup Break
**Files:** `service/DriverLocationService.kt`, `data/repository/DriverFirestoreRepository.kt`, `viewmodel/DriverTerminalViewModel.kt`

**Problem:** Every 4.5 seconds, `DriverLocationService` calls `mergeLiveTracking(..., isOnline = true, isOnRide = false)`, which unconditionally writes `live_tracking.status = "available"` and `driver_status.status = "online"`, `isBusy = false`—silently cancelling Coffee Cup Break on the backend! Also `setDriverBreakStatus` does not write `onBreak` to `live_tracking`.

**Fix:**
1. Add `isOnBreak: Boolean = false` to `DriverLocationService` state + `DriverLocationService.updateState(context, driverName, isOnRide, isOnBreak)` (call it inside `startBreak()` and `endBreak()` in `DriverTerminalViewModel`).
2. Update `mergeLiveTracking(...)` in `DriverFirestoreRepository.kt` to accept `isOnBreak: Boolean = false`:
   - Write `"onBreak" to isOnBreak` and `"lastHeartbeatAtMs" to System.currentTimeMillis()` to `live_tracking/{uid}`.
   - Set `live_tracking.status`: if `!isOnline` → `"offline"`, else if `isOnRide` → leave untouched, else if `isOnBreak` → `"busy"`, else `"available"`.
   - Set `driver_status.isBusy = isOnRide || isOnBreak`, `driver_status.onBreak = isOnBreak`, and `driver_status.status = if (!isOnline) "offline" else if (isOnRide) "on_ride" else if (isOnBreak) "busy" else "online"`.
3. Update `setDriverBreakStatus(uid, onBreak)` to ALSO write `"onBreak" to onBreak` on `live_tracking/{uid}`.

---

### P0-4: Fix Stacked Ride Accept Clobbering Active Ride's Dropoff Coordinates
**File:** `viewmodel/DriverTerminalViewModel.kt` (line ~2196–2198)

**Problem:** On stacked accept (`isStacked == true`), `acceptOffer()` calls `repository.syncActiveRideDropoff(uid, offer.dropoffLat, offer.dropoffLng)` using the **queued** offer's dropoff! That overwrites the active passenger's dropoff in `live_tracking/{uid}`.

**Fix:**
- Remove `if (isStacked && uid.isNotBlank()) { repository.syncActiveRideDropoff(uid, offer.dropoffLat, offer.dropoffLng) }` from `acceptOffer()`. The backend `POST /api/rides/accept` already preserves the active ride's `dropoffLat`/`dropoffLng` and writes `queuedRideId`/`queuedPassengerId` atomically. Only update `dropoffLat`/`dropoffLng` when the queued ride is promoted to active after the current trip completes.

---

### P1-1: Call `POST /api/rides/decline` When an Offer Times Out for Instant Rollover
**File:** `viewmodel/DriverTerminalViewModel.kt` (`handleOfferTimedOut`, line ~1151)

**Fix:**
- Inside `handleOfferTimedOut(offerId: String)`, call `ApiClient.safeCall { ApiClient.service.declineRide(RideDeclineRequest(rideId = offerId)) }` (falling back to `repository.recordDriverDeclineStatus(uid)` only on network error).
- Because the backend `POST /api/rides/decline` now triggers Wave 2/3 rollover immediately, the next driver receives the ride within **<1 second** instead of waiting for the 10-second expiry sweep.

---

### P1-2: Enrich Incoming & Floating Overlay Offer Cards with Priority, Pet, Multi-Stop & Rating Chips
**Files:** `data/model/DriverModels.kt`, `service/AnyRollerMessagingService.kt`, `ui/screens/DriverTerminalScreen.kt`, `service/FloatingRideOverlayController.kt`

**Fix:**
1. Parse `isPriority`, `isPetFriendly`, `stopCount`, `passengerRating`, and `paymentMethod` in `IncomingOfferPush` (`AnyRollerMessagingService.kt`) and map them onto the synthetic `RideRequest` in `DriverTerminalViewModel.kt`.
2. Render compact high-contrast chips on both the in-app offer sheet and floating overlay card:
   - **`⚡ PRIORITY`** (amber/gold pill when `offer.isPriority`)
   - **`🐾 PET FRIENDLY`** (emerald pill when `offer.isPetFriendly`)
   - **`📍 N STOPS`** (blue pill when `offer.stops.isNotEmpty()` or `stopCount > 0`)
   - **`EV` / Vehicle Tier badge** (e.g., green `⚡ ELECTRIC` for `electric`)
   - **`★ 4.9`** passenger rating & **`CARD` / `CASH`** badge.

---

### P1-3: Clean Up Legacy Accept Fallback & Add Smart Auto-Accept Filters
**Files:** `viewmodel/DriverTerminalViewModel.kt`, `data/repository/DriverPreferencesStore.kt`, `ui/screens/DriverMenuScreen.kt`

1. Remove the legacy `claimOfferedRideTransaction` direct-Firestore fallback in `acceptOffer()` (lines ~2224–2278) — `POST /api/rides/accept` already handles `"offered"` rides atomically and stamps authoritative driver fields.
2. Enhance **Auto-Accept Mode** (still OFF by default) with optional guardrails:
   - `autoAcceptMinGbpPerHour` (using `OfferIntelligenceHelper.estimatedGbpPerHour`)
   - `autoAcceptAllowMultiStop` (Boolean, default `true`)
   - `autoAcceptOnlyTowardHome` (Boolean, default `false` — uses `intel.isHeadingTowardHome`)
   - Always pass through `isOfferEligibleForDriver()` FIRST so Auto-Accept can never accept an ineligible category, pet-friendly, out-of-zone, or distant ride.

---

## Verification Checklist for Android Agent
- [ ] Driver with only `standard` selected does NOT see or auto-accept `electric`, `6seater`, `8seater`, `luxury`, `wav`, or `isPetFriendly: true` rides.
- [ ] Driver can toggle `Electric (EV) (1.2x / 1.15x)` and all 7 canonical tiers in Vehicle & Service Tiers menu, writing exact canonical IDs (`electric`, `6seater`, `8seater`, `luxury`, `wav`) to `live_tracking/{uid}.vehicleCategories`.
- [ ] Toggling Coffee Cup Break keeps `live_tracking.status == "busy"` and `onBreak == true` across multiple 4.5s GPS location ticks.
- [ ] Accepting a stacked ride preserves the active trip's `dropoffLat`/`dropoffLng` in `live_tracking`.
- [ ] Letting a 15s offer time out invokes `POST /api/rides/decline` and rolls over to Wave 2 immediately.
- [ ] Incoming & floating offer cards display `PRIORITY`, `PET FRIENDLY`, `STOPS`, `ELECTRIC`, `CARD/CASH`, and passenger rating chips accurately.
