# Android Driver App — Pricing Parity, £50 Tip Cap & Real-Time Passenger Edit Sync Spec

This specification brings the **Android Driver App** (`https://github.com/Saanwar2002/Drivers-App-Android-.git`) into 100% real-time parity with the AnyRoller Passenger Terminal, Web Driver Terminal, Server Pricing Engine, and Admin Controls (`platform_config/rides`).

---

## 1. Live `platform_config/rides` Fields (Admin-Controlled)

Listen to Firestore document `platform_config/rides` (or fetch via existing config repository) and bind the following live fields with safe defaults:

| Field | Type | Default | Constraints / Purpose |
|---|---|---|---|
| `baseFare` | `Double` | `3.50` | Flagfall / base fare (£) |
| `distanceRate` | `Double` | `1.30` | Rate per mile (£/mi) |
| `timeRate` | `Double` | `0.15` | Rate per minute (£/min) |
| `minFare` | `Double` | `5.00` | Minimum fare floor before vehicle multiplier |
| `waitRatePerMinute` | `Double` | `0.25` | Paid wait rate after free grace period |
| `freeWaitMinutes` | `Int` | `3` | Free grace wait window at pickup before paid wait ticks |
| `driverWaitTimeLimitMins` | `Int` | `5` | Wait threshold before abandonment/no-show option unlocks |
| `abandonmentFee` | `Double` | `5.00` | Rider no-show / abandonment fee (£) |
| `priorityFee` | `Double` | `3.00` | Flat Priority Dispatch add-on (£, NOT multiplied by vehicle/surge) |
| `petFee` | `Double` | `3.00` | Flat Pet Friendly add-on (£, NOT multiplied by vehicle/surge) |
| `maxTipGbp` | `Double` | `50.00` | Maximum passenger card tip — **hard-capped at £50.00** (`min(50.0, max(0.0, value))`) |
| `maxPendingPlatformFeesGbp` | `Double` | `25.00` | Max unpaid cash-trip platform commission balance before driver cash restriction |
| `allowMidJourneyEdits` | `Boolean` | `true` | Admin master toggle for passenger mid-journey route/stop edits |
| `commissionRate` | `Double` | `0.12` | Platform commission (12%). Applies to fare + wait ONLY; **0% on tips** |
| `fixedTripFee` | `Double` | `0.00` | Optional fixed booking fee (£0.00 default) |
| `vehicleMultipliers` | `Map<String, Double>` | `{ standard: 1.0, electric: 1.15, executive: 1.5, luxury: 2.2, 6seater: 1.4, 8seater: 2.0, wav: 2.5 }` | Category multipliers (includes `electric: 1.15`) |

---

## 2. £50.00 Maximum Passenger Card Tip Cap

- Server-authoritative passenger tips are written exclusively through `POST /api/rides/:rideId/tip` (`executeAddRideTipCommand`), which enforces `0 <= tipAmount <= min(50.00, config.maxTipGbp)`.
- In the Android Driver App:
  - Always sanitize displayed `tipAmount` with `tipAmount.coerceIn(0.0, minOf(50.0, config.maxTipGbp))`.
  - Tips remain **100% Driver-owned** (0% platform commission).
  - Never mutate `tipAmount` from the driver client; treat Firestore `ride_requests/{rideId}.tipAmount` and server settlement responses (`finalFare`, `tipAmount`, `totalFarePaid`, `driverEarnings`, `platformFee`, `fareContractVersion: "v2_excl_tip"`) as authoritative.

---

## 3. Real-Time Passenger Journey & Fare Sync (Pre-Journey & Mid-Journey)

### 3.1 Firestore Fields Written Atomically by `POST /api/rides/:rideId/passenger-update`

Whenever a passenger edits pickup (pre-pickup only), destination, stops, or notes (before pickup or mid-journey), the server atomically updates `ride_requests/{rideId}` with:

- `journeyRevision: Int` — monotonically increasing integer (`0` on booking creation, `+1` on every passenger edit).
- `fareEstimate: Double` — newly recomputed server-authoritative fare (using **actual-driven + remaining route** Haversine floor during `in_progress` so miles already driven are never lost).
- `previousFareEstimate: Double` — fare prior to this edit.
- `fareDeltaGbp: Double` — signed delta (`fareEstimate - previousFareEstimate`, e.g. `+4.20` or `-1.50`).
- `lastPassengerEditSummary: String` — human-readable summary (e.g. `"Dropoff changed to Leeds Station • Stop added (1 total) • Fare +£4.20 (now £18.60)"`).
- `routePricingMode: String` — `"mid_journey_actual_plus_remaining"` or `"point_to_point"`.
- `pickup`, `pickupLat`, `pickupLng`, `dropoff`, `dropoffLat`, `dropoffLng`, `stops: List<{ address, coords: { lat, lng } }>`, `distanceMiles`, `durationMinutes`.
- `isPetFriendly: Boolean`, `petFee: Double`, `isPriority: Boolean`, `priorityFee: Double`, `carCategory: String`.

### 3.2 CRITICAL: Remove Any Client `updateDoc({ isModifiedByPassenger: false })` Write

- `firestore.rules` strictly restricts driver writes on `ride_requests/{rideId}` to safe status/location updates and **blocks** writing `isModifiedByPassenger`.
- **DO NOT** call `update("isModifiedByPassenger", false)` from the Android Driver App (doing so triggers `PERMISSION_DENIED` and causes infinite alert loops).
- Instead, keep two in-memory trackers scoped to `activeRideId` (reset whenever `activeRideId` changes):
  - `lastSeenJourneyRevision: Int = initialRide.journeyRevision ?: 0`
  - `lastSeenTipAmount: Double = initialRide.tipAmount ?: 0.0`

### 3.3 Active Ride Snapshot Listener Behavior

On every snapshot of `ride_requests/{activeRideId}`:

1. **Detect Journey Edits**:
   - Trigger edit handling when `incomingRevision > lastSeenJourneyRevision` (or fallback content diff on `dropoff`/`stops`/`fareEstimate` if `journeyRevision == 0` on legacy rides).
   - Advance `lastSeenJourneyRevision = incomingRevision`.
   - **Immediately invalidate Directions cache & throttle** (bypass the 60s on-route cooldown and reset the 3/3 off-route recalculation counter) so Google Directions re-fetches immediately with the updated `stops` waypoints and `dropoffLat`/`dropoffLng`.
   - Update polyline, turn-by-turn Heads-Up Navigation HUD (preserve the locked transparent `#2563EB` HUD style), remaining ETA, and displayed fare immediately.
   - Play notification chime + TTS: `"Journey updated by passenger. $lastPassengerEditSummary"`.
   - Display a dismissible high-contrast banner inside the active ride sheet for ~14 seconds showing `lastPassengerEditSummary`, signed `fareDeltaGbp`, and updated `£fareEstimate`.
   - If external navigation (Google Maps / Waze intent) was launched, surface a prompt warning the driver to restart navigation with the updated destination.

2. **Detect Live Tip Updates**:
   - Trigger when `incomingTip > lastSeenTipAmount + 0.009`.
   - Update `lastSeenTipAmount = incomingTip`.
   - Play chime + TTS: `"Passenger added a £${"%.2f".format(incomingTip)} tip"` and show a celebratory banner/toast.

---

## 4. Instant FCM Push Payloads (Background & Foreground Sync)

In addition to Firestore real-time snapshots, the server dispatches high-priority FCM data messages to `assignedDriverId` immediately on commit:

### 4.1 `type = "ride_journey_updated"`
```json
{
  "type": "ride_journey_updated",
  "rideId": "<rideId>",
  "journeyRevision": "2",
  "fareEstimate": "18.60",
  "previousFareEstimate": "14.40",
  "fareDeltaGbp": "4.20",
  "dropoff": "Leeds Station, New Station St",
  "dropoffLat": "53.7949",
  "dropoffLng": "-1.5476",
  "stopsCount": "1",
  "editSummary": "Stop added (1 total) • Fare +£4.20 (now £18.60)"
}
```
**Android Handling**:
- If `rideId == activeRideId` and `journeyRevision > lastSeenJourneyRevision`, trigger immediate Directions refresh + chime + TTS + UI banner even if Firestore snapshot is delayed on poor mobile signal.
- Deduplicate against Firestore snapshot using `lastSeenJourneyRevision` so the driver is alerted **exactly once** per revision.

### 4.2 `type = "ride_tip_added"`
```json
{
  "type": "ride_tip_added",
  "rideId": "<rideId>",
  "tipAmount": "5.00"
}
```
**Android Handling**:
- If `rideId == activeRideId` and `tipAmount > lastSeenTipAmount`, update `lastSeenTipAmount`, update displayed tip immediately, and play chime + TTS once (deduplicated against Firestore snapshot).

---

## 5. UI Parity Checklist (Android Driver App)

1. **Incoming Offer Card**: Show compact **Pet (+£X.XX)** badge alongside **Priority** and **Surge** badges when `isPetFriendly == true`.
2. **Active Trip Bottom Sheet**:
   - Render `stops` list live as stops are added/removed/reordered.
   - Show the live dismissible **Route Updated by Passenger** banner with `fareDeltaGbp` and updated fare when `journeyRevision` advances.
   - Include `stopsSignature` and `journeyRevision` inside the Directions fetch cache key so stop-only edits (same final dropoff) never wait 60 seconds to redraw.
3. **Trip Summary / Payment Handshake Screen**:
   - Include **Pet Friendly (`+£petFee`)** line item when `isPetFriendly == true` (and exclude `petFee` from any surge fallback math).
   - Display dynamic `abandonmentFee` from `platform_config/rides` instead of hardcoded `£5.00`.
   - Respect `fareContractVersion == "v2_excl_tip"` (`finalFare` excludes tip; `totalFarePaid = finalFare + tipAmount`; `driverEarnings` includes 100% of tip).
