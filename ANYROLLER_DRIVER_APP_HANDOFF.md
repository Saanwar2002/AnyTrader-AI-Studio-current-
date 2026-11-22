# AnyRoller Native Driver App — Complete Handoff & Architecture Specification

> **Purpose of this document**: Give this file to an AI Studio coding agent when starting the **separate AnyRoller Native Driver App** project. It explains **why** this app exists separately, **how** it connects to the existing live AnyTrader / AnyRoller platform without duplicating the backend, and the **exact Firestore schemas, API contracts, security boundaries, and UI requirements** it must implement.

---

## 1. Strategic Context: Why a Separate Native Driver App?

The **AnyTrader & AnyRoller Web Platform** (main repository) runs as a **pure responsive Web App + PWA** (Capacitor was intentionally removed to eliminate native wrapper maintenance for homeowners, tradespeople, landlords, and passengers).

However, **AnyRoller Drivers** have three mission-critical mobile OS requirements that mobile browsers/PWAs cannot reliably provide:
1. **Continuous Background GPS Tracking**: Mobile browsers pause `navigator.geolocation.watchPosition` when drivers lock their screen, take a phone call, or switch to Google Maps / Waze. A native Android Foreground Location Service keeps streaming live driver coordinates to Firestore so passengers never see a frozen car.
2. **High-Priority Lock-Screen Ride Offers (FCM Push)**: Incoming ride offers have a short acceptance window (~15 seconds). Native Android FCM with a high-importance notification channel (`IMPORTANCE_HIGH`, loud ringtone/vibration, full-screen/heads-up alert) ensures drivers hear and see offers even when the phone is locked or another app is open.
3. **Seamless External Navigation + Wake Lock**: Drivers can launch Google Maps or Waze with one tap for turn-by-turn navigation while AnyRoller stays alive in the background tracking GPS, arrival proximity, and stacked ride offers.

### Recommended Target Platform
- **Phase 1 (Start Here)**: **Native Android (Kotlin + Jetpack Compose)** — covers the majority of UK private-hire/taxi drivers on dashboard mounts and has straightforward Foreground Service + Google Maps/Waze intent support.
- **Phase 2 (Optional Later)**: iOS companion build or cross-platform port only once Android driver adoption is proven.

---

## 2. Golden Architectural Rules (CRITICAL — DO NOT VIOLATE)

1. **Single Backend & Single Database Authority**:
   - The main **AnyTrader / AnyRoller Web Project** is the **ONLY** source of truth for:
     - Backend Express API (`/api/*`)
     - Firestore Security Rules (`firestore.rules`) & Storage Rules (`storage.rules`)
     - Stripe Connect payment intents, webhooks, fare calculations, and commission math
     - Admin approval & driver eligibility enforcement
   - **THIS DRIVER APP IS A PURE CLIENT.** It must **NEVER** deploy or overwrite `firestore.rules`, must **NEVER** contain Stripe secret keys, and must **NEVER** perform client-side financial/commission writes that bypass server APIs.

2. **Strict Scope Boundary**:
   - This app is **ONLY for AnyRoller Drivers** (Login, Go Online/Offline, Background GPS, Ride Offers, Active Trip Lifecycle, In-Ride Chat, Earnings/Payouts, Vehicle/Docs Status, Settings).
   - Do **NOT** rebuild AnyTrader homeowner/tradesperson portals or AnyRoller passenger booking screens inside this app. (Cross-sell links/widgets to AnyTrader simply deep-link out to the main AnyTrader web URL in the browser.)

3. **Separate Repository**:
   - Keep this app in its **own dedicated GitHub repository** (e.g., `anyroller-driver-android`), completely separate from the main AnyTrader/AnyRoller web repository. Both repos connect to the **same Firebase project** and the **same live API domain**.

---

## 3. Connection & Environment Configuration

### 3.1 Shared Firebase Project (Exact Non-Secret Identifiers)
Register this Android app inside the **existing Firebase project** in Firebase Console (add the Android package name + SHA-1 & SHA-256 signing fingerprints, and download `google-services.json` into `app/`):

- **Firebase Project ID**: `anytradercombined`
- **Firestore Named Database ID**: `ai-studio-anytrader-44dab8b3-bbc9-4352-b725-2cbe7a1dfd2a`
  - **CRITICAL**: Do **NOT** connect to `(default)` Firestore database! You MUST initialize Firestore with the named database ID:
    ```kotlin
    val db = FirebaseFirestore.getInstance(
        Firebase.app,
        "ai-studio-anytrader-44dab8b3-bbc9-4352-b725-2cbe7a1dfd2a"
    )
    ```
- **Firebase Auth Domain**: `anytradercombined.firebaseapp.com`
- **Firebase Storage Bucket**: `anytradercombined.firebasestorage.app`
- **FCM Messaging Sender ID**: `426882121063`

### 3.2 Shared Backend API Base URL
Configure `API_BASE_URL` via `BuildConfig` / environment config (never hardcode temporary preview URLs for production):
- **Production**: Your deployed AnyTrader/AnyRoller Cloud Run or custom HTTPS domain (e.g., `https://your-live-domain.com`)
- **Staging/Dev Testing**: Your active AnyTrader/AnyRoller dev/pre URL during development.
- **Authentication Header on ALL API requests**:
  Every call to `/api/*` MUST include the driver's fresh Firebase Auth ID token:
  ```http
  Authorization: Bearer <firebase_id_token>
  Content-Type: application/json
  ```

### 3.3 Security & Secrets Hygiene
- Never hardcode Google Maps API keys, Stripe keys, or private credentials in source code. Load the Android Maps API key from `local.properties` / `BuildConfig` / manifest placeholder restricted by Android package name + SHA-1 in Google Cloud Console.

---

## 4. Authentication & Fail-Closed Driver Eligibility

Drivers sign in with their existing **Firebase Authentication** credentials (Email/Password and/or Google Sign-In).

The backend (`assertAuthoritativeDriverEligibility`) enforces **fail-closed driver eligibility** on `users/{uid}`:
1. **Driver Role Required**: `role` is `"driver"`, `"fleet_driver"`, or `"taxi_driver"` (or `isDriver == true` / `accountType == "driver"`).
2. **Not Suspended / Disabled**: None of `disabled`, `isDisabled`, `isSuspended`, `suspended`, `isBanned`, `banned`, `isDeactivated`, `deactivated` is `true`, and `status` / `driverStatus` is not `"suspended"`, `"banned"`, `"disabled"`, `"inactive"`, or `"deactivated"`.
3. **Admin Approval Required**: `driverApproved == true`.

**App UX requirement**:
- After sign-in, read `users/{uid}`.
- If the user is not a driver, show a clear message directing them to register as a driver on the AnyRoller web portal.
- If `driverApproved != true`, show a clean **"Account Pending Verification"** screen (do not allow going online or accepting rides).
- If suspended/disabled, show an **"Account Suspended — Contact Support"** screen and immediately sign out / stop tracking.

---

## 5. Exact Firestore Real-Time Data Contract

The Driver App interacts directly with Firestore **only** for allowed real-time reads, GPS presence writes, chat messages, and hazard reporting. **All ride state transitions and financial mutations MUST go through the server REST API (Section 6).**

### 5.1 Collections & Document Schemas

#### A. `live_tracking/{driverUid}` (Driver writes own GPS & dispatch metadata)
Written immediately when going Online/Offline, and throttled during active Foreground Location tracking (every ~10–15s when moving ≥15–50m, or every 60s heartbeat max):
```json
{
  "driverId": "<driverUid>",
  "lat": 53.6458,
  "lng": -1.7850,
  "heading": 180,
  "updatedAt": "serverTimestamp()",
  "isOnline": true,
  "status": "available", // "available" | "on_ride"
  "dropoffLat": null,    // populated from activeRide.dropoffLat when on_ride (for stacked offers)
  "dropoffLng": null,
  "isStackingEnabled": true,
  "isLastJob": false,
  "destinationModeActive": false,
  "homeLat": null,
  "homeLng": null,
  "zoneEnabled": false,
  "zoneMaxDistance": 0,
  "vehicleCategory": "standard",
  "vehicleCategories": ["standard"],
  "isPetFriendly": false
}
```
When going **Offline**, update `isOnline: false`.

#### B. `driver_status/{driverUid}` (Driver writes online toggle state)
```json
{
  "online": true,
  "updatedAt": "serverTimestamp()"
}
```
Set `online: false` when going offline or stopping the foreground service.

#### C. `ride_requests/{rideId}` (Real-time listener — DO NOT mutate financial/status fields directly)
- **Listening for incoming offers**: Query `ride_requests` where `status in ["pending", "searching", "offered"]` (filtered client-side by driver proximity, vehicle category, preferences, and declined offer cache; also listen directly to any `rideId` delivered via FCM push payload).
- **Listening to active ride**: Real-time `SnapshotListener` on `ride_requests/{activeRideId}` to react instantly to passenger cancellations, payment confirmations (`paymentStatus: "paid"`), stop updates, and tips.
- **Key fields read by Driver App**:
  - `status`: `"pending" | "searching" | "offered" | "accepted" | "arrived" | "in_progress" | "completed" | "cancelled"`
  - `passengerId` / `riderId` / `userId`, `passengerName`, `passengerRating`, `passengerPhone`, `riderNotes`
  - `pickupAddress`, `pickupLat`, `pickupLng`, `dropoffAddress`, `dropoffLat`, `dropoffLng`, `stops[]`, `currentStopIndex`
  - `fareEstimate`, `surgeMultiplier`, `vehicleCategory`, `paymentMethod` (`"card" | "cash" | "qr"`), `hasCardOnFile`
  - `handshakeCode`, `driverRequirePasscode`
  - `finalFare` (base fare excl. tip under `fareContractVersion: "v2_excl_tip"`), `tipAmount`, `totalFarePaid`, `platformFee`, `driverEarnings`, `paymentStatus`, `paymentUrl`
- **STRICT SECURITY RULE WARNING**: Firestore rules block client writes to financial & protected fields (`paymentStatus`, `paid`, `isPaid`, `finalFare`, `driverEarnings`, `commissionAmount`, `platformFee`, `stripeTransferId`, `payoutStatus`, etc.). **Always use the `/api/rides/*` endpoints in Section 6 for accepting, transitioning, completing, and cancelling rides.**

#### D. `ride_requests/{rideId}/chat/{messageId}` (Real-time in-ride chat)
- Driver and passenger can both read and add messages here once the ride is assigned (`driverId == uid` or `assignedDriverId == uid`).
- After writing a chat message to Firestore, call `POST /api/chat-push` so the passenger receives a push notification.

#### E. `driver_metrics/{driverUid}` (Read-only by driver)
- Server-maintained daily/lifetime stats (online minutes, daily driving safety limit, net earnings, ride count, acceptance rate). Read via snapshot listener for the Sticky Earnings Bar and Earnings/Analytics tabs.

#### F. `platform_config/rides` (Read-only)
- Platform fare configuration, surge caps, commission rates, and `maxDailyDriverHours` safety limits.

#### G. `reported_hazards/{hazardId}` (Optional live road hazard reporting)
- Read all active hazards; create with `reporterId == driverUid`.

---

## 6. Exact Server-Authoritative REST API Contract

All endpoints require `Authorization: Bearer <firebase_id_token>` unless noted.

### 6.1 Push Notification Token Management (CRITICAL FOR NATIVE FCM)
| Method & Endpoint | Body / Params | Purpose |
|---|---|---|
| `POST /api/notifications/register-token` | `{ "fcmToken": "<token>", "deviceId": "<persistent_install_uuid>", "platform": "android" }` | Registers this Android installation's FCM token under `users/{uid}/push_devices/{deviceId}` and revokes any stale account previously logged in on the same physical device. Call immediately after login AND inside `FirebaseMessagingService.onNewToken()`. |
| `POST /api/notifications/unregister-token` | `{ "deviceId": "<persistent_install_uuid>", "token": "<cached_fcm_token>" }` | **MANDATORY ON LOGOUT / ACCOUNT SWITCH.** Unregisters this device so notifications never leak to another driver using the same phone. |
| `POST /api/chat-push` | `{ "rideId": "...", "recipientId": "<passengerUid>", "message": "...", "title": "..." }` | Dispatches push notification to passenger for new in-ride chat messages or arrival alerts. |

### 6.2 Driver Online Heartbeat & Demand Zones
| Method & Endpoint | Body / Params | Purpose |
|---|---|---|
| `POST /api/driver/metrics/heartbeat` | `{}` | Call every **60 seconds** while driver is Online. Returns `{ limitReached, maxDailyDriverHours, ... }`. If `limitReached == true`, automatically switch driver Offline and show the safety driving-hours limit alert. |
| `GET /api/rides/demand-zones` | Query params (optional area/coords) | Fetches live high/moderate/low demand & surge heatmap zones for the Home map. |

### 6.3 Server-Authoritative Ride Lifecycle (ALL mutations go through here)
| Method & Endpoint | Body | Purpose |
|---|---|---|
| `POST /api/rides/accept` | `{ "rideId": "<rideId>" }` | Atomically claims a `pending`/`searching`/`offered` ride in a Firestore transaction after verifying `driverApproved == true`. Returns `409 Conflict` if another driver claimed it first. |
| `POST /api/rides/transition` | `{ "rideId": "<rideId>", "action": "arrived" \| "in_progress" \| "stop_progress" \| "early_completion_reason", "paidWaitSeconds"?: number, "currentStopIndex"?: number, "earlyCompletionReason"?: string }` | Server-authoritative state machine transitions: `accepted → arrived → in_progress`, multi-stop progression, and early completion reason logging. |
| `POST /api/rides/create-trip-payment` | `{ "rideId": "<rideId>", ... }` | Generates/reuses Stripe Checkout payment link / QR URL (`url`, `intentId`, `effectiveBaseFare`, `sanitizedTip`, `totalAmount`) for card/QR trip payment. |
| `POST /api/rides/complete` | `{ "rideId": "<rideId>", "action": "auto_card" \| "qr_pending" \| "qr_manual_close" \| "cash_report" \| "cash_finalize" \| "abandonment", "paidWaitSeconds"?: number, "cashCollected"?: number, "earlyCompletionReason"?: string, "paymentUrl"?: string, "abandonmentFee"?: number }` | Server-authoritative completion, canonical `v2_excl_tip` fare + commission settlement, and transactional `driver_metrics` earnings update. |
| `POST /api/rides/cancel` | `{ "rideId": "<rideId>", "cancelledBy": "driver" }` | Server-authoritative driver cancellation with state machine enforcement. |

### 6.4 Driver Earnings, Stripe Connect & Fee Settlements
| Method & Endpoint | Purpose |
|---|---|
| `GET /api/driver/stripe-balance/:driverId` | Fetch driver's live Stripe Connect available & pending balance (must match authenticated `driverId`). |
| `POST /api/driver/stripe-payout/:driverId` | Trigger payout to driver's linked bank account (`{ "amount"?: number }`). |
| `GET /api/stripe/account-status` | Check whether driver's Stripe Connect onboarding & payouts are enabled. |
| `POST /api/stripe/create-connect-account` | Generate Stripe Connect onboarding URL (open in Chrome Custom Tab). |
| `POST /api/stripe/create-login-link` | Generate Stripe Express dashboard login link (open in Chrome Custom Tab). |
| `GET /api/driver/fee-settlement-status` | Check any outstanding cash-trip platform commission balance. |
| `POST /api/driver/settle-fees` | Create Stripe Checkout link to settle cash-trip platform fees (open in Chrome Custom Tab). |

---

## 7. Required Native Android Capabilities

### 7.1 Persistent Background GPS Foreground Service (`DriverLocationService`)
- Permissions: `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`, `WAKE_LOCK`.
- When driver taps **Go Online**:
  1. Start `DriverLocationService` as a `ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION` foreground service with a persistent notification: *"AnyRoller Online — Ready for rides"* (or *"Active Trip — Sharing live location"*).
  2. Use `FusedLocationProviderClient` (`Priority.PRIORITY_HIGH_ACCURACY`, interval 5s, min distance 15m).
  3. Write throttled updates to `live_tracking/{uid}` and `driver_status/{uid}` (immediately on Go Online, then every 10–15s if moved ≥15m or every 60s max).
  4. Run the 60-second `/api/driver/metrics/heartbeat` loop inside the service so online hours remain accurate even when backgrounded.
- When driver taps **Go Offline** (or logs out, or hits daily safety limit):
  1. Immediately write `isOnline: false` to `live_tracking/{uid}` and `online: false` to `driver_status/{uid}`.
  2. Stop `DriverLocationService` cleanly so battery is never drained offline.

### 7.2 High-Priority Ride Offer Push Notifications (`AnyRollerMessagingService`)
- Create two Android Notification Channels on app startup:
  1. `ride_offers_urgent` (`IMPORTANCE_HIGH`, loud custom alert sound, strong vibration pattern `[0, 400, 200, 400, 200, 600]`, bypasses lock screen / shows heads-up + full-screen intent when screen is locked).
  2. `ride_chat_updates` (`IMPORTANCE_HIGH`, standard chime + vibration for passenger messages & cancellations).
- Handle both **data-only** and **notification+data** FCM payloads so tapping a ride offer opens the full-screen **Incoming Ride Offer** overlay immediately with the live remaining countdown.

### 7.3 One-Tap External Navigation (Google Maps & Waze)
- During **En Route to Pickup** and **Trip in Progress**, provide a prominent **"Navigate"** button allowing drivers to launch Google Maps (`google.navigation:q=lat,lng&mode=d`) or Waze (`https://waze.com/ul?ll=lat,lng&navigate=yes`) directly.
- Because `DriverLocationService` runs as a Foreground Service, live GPS tracking to the passenger continues uninterrupted while the driver follows Google Maps/Waze.

### 7.4 Screen Keep-Awake
- Keep screen awake (`FLAG_KEEP_SCREEN_ON`) whenever the Driver Terminal is in the foreground and the driver is Online or on an Active Trip.

---

## 8. Owner-Locked UI / UX Specification

Follow the AnyRoller Driver Design System (`DRIVER_UI_SPEC.md`):

- **Philosophy**: Money-first, Map-second, One-thumb windscreen usability (all primary actions in bottom half of screen), 2-second glanceable, transparent fare/commission breakdowns on every ride.
- **Theme**: **Dark Mode Default** (`#0D0D0F` primary BG, `#1A1A1E` secondary BG, `#252529` tertiary BG, `#FFFFFF` primary text, `#00D26A` green, `#FF3B30` red, `#FF9500` orange, `#007AFF` blue).
- **Locked Navigation HUD Text Style (DO NOT ALTER)**:
  - Heads-up navigation text rendered over the map MUST have a **transparent background** (no black box), **dark blue (`#2563EB`) text**, with a **soft white drop shadow** (`#FFFFFF` at 90% opacity) and **no text stroke**.
- **4 Bottom Tabs Only**:
  1. **Home**: Sticky Earnings Bar + Demand Map + Smart Surge Tip + Active Bonus + AnyTrader Cross-Sell card (links to web) + Big full-width **Go Online / Go Offline** button.
  2. **Earnings**: Today / Week / Month net earnings, commission & tips breakdown, Stripe Connect balance & instant payout button, cash fee settlement status.
  3. **Inbox**: Ride messages, platform/document expiry alerts, AnyTrader lead alerts.
  4. **Menu**: Profile, Vehicle & Documents status, Stripe Connect onboarding, Stacking / Destination Mode / Zone / Pet-Friendly toggles, Navigation App preference (Google Maps vs Waze), Sign Out (must unregister push token first!).
- **Core Active Trip Screens**:
  1. **Incoming Ride Offer Overlay (15s circular countdown)**: Big Total Fare + **"You Earn" (after commission)**, surge badge, pickup ETA/distance, dropoff ETA/distance, passenger rating, BIG green **Accept**, subtle **Decline**.
  2. **En Route to Pickup**: Map + Locked HUD style + One-tap Google Maps/Waze button + Passenger Chat/Call + Big **"Arrived at Pickup"** button.
  3. **Waiting at Pickup**: Live wait timer, optional passenger handshake PIN verification, Big **"Start Trip"** button.
  4. **Trip in Progress**: Live ETA/fare, multi-stop progression if applicable, Big **"Complete Trip"** button (handling Card, QR Payment Link display, or Cash reporting via `/api/rides/complete`).
  5. **Trip Completed Summary**: Animated net earnings count-up, transparent fare/commission breakdown, passenger 5-star rating.

---

## 9. Copy-Paste Kickoff Prompt for Your New AI Studio Project

When you open a **new Android project in AI Studio**, attach or paste this document along with the prompt below:

```text
We are building the standalone native Android AnyRoller Driver App (Kotlin + Jetpack Compose) that connects directly to our existing live AnyTrader/AnyRoller Firebase project and Express backend API.

Please read the attached ANYROLLER_DRIVER_APP_HANDOFF.md carefully before writing any code.

Critical requirements:
1. Connect to Firebase project `anytradercombined` using the NAMED Firestore database `ai-studio-anytrader-44dab8b3-bbc9-4352-b725-2cbe7a1dfd2a` (NOT the default database).
2. Point all REST API calls to a configurable `BuildConfig.API_BASE_URL` and attach the driver's Firebase Auth ID token as `Authorization: Bearer <token>` on every request.
3. Do NOT deploy or overwrite Firestore security rules—the main AnyTrader web app owns all backend logic and rules.
4. Implement the Android Foreground Location Service (`DriverLocationService`), high-priority FCM push notification service (`AnyRollerMessagingService`) with token registration/unregistration, Google Maps/Waze navigation intents, fail-closed `driverApproved == true` gating, and the full 4-tab Dark Mode Driver Terminal + active ride lifecycle UI specified in the handoff document.
```
