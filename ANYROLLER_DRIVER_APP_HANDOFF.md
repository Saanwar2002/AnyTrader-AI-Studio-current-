# AnyRoller Native Driver App — Complete Handoff & Architecture Specification

> **Last Updated**: November 26, 2026 (Synchronized after AnyTrader Full-Platform Pre-Live Hardening — Slices 1–8 Complete)  
> **Purpose of this document**: Give this file to an AI Studio coding agent when starting the **separate AnyRoller Native Driver App** project. It explains **why** this app exists separately, **how** it connects to the existing live AnyTrader / AnyRoller platform without duplicating the backend, and the **exact Firestore schemas, Storage constraints, API contracts, security boundaries, and UI requirements** it must implement.

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
     - Firestore Security Rules (`firestore.rules`), Composite Indexes (`firestore.indexes.json`), & Storage Rules (`storage.rules`)
     - Stripe Connect payment intents, webhooks, fare calculations, subscription fulfillment, and commission math
     - Admin approval, tiered RBAC (`super_admin` / `financial_operator` / `support_readonly`), & driver eligibility enforcement
     - **4-Tier Hybrid Messaging & Direct Meta WhatsApp Cloud API Fallback Engine** (cooldowns, unread checks, Meta Graph API calls, and signed Meta webhooks)
   - **THIS DRIVER APP IS A PURE CLIENT.** It must **NEVER** deploy or overwrite `firestore.rules` or `storage.rules`, must **NEVER** contain Stripe or Meta WhatsApp secret tokens, must **NEVER** call Meta Graph API directly, and must **NEVER** perform client-side financial, subscription, terms-acceptance, verification-status, or WhatsApp verification writes that bypass server APIs.

2. **Strict Scope Boundary**:
   - This app is **ONLY for AnyRoller Drivers** (Login, Terms/Compliance Gate, Go Online/Offline, Background GPS, Ride Offers, Active Trip Lifecycle, In-Ride Chat, Earnings/Expenses/Payouts, Vehicle/Docs Status, Settings & Account Deletion).
   - Do **NOT** rebuild AnyTrader homeowner/tradesperson portals or AnyRoller passenger booking screens inside this app. (Cross-sell links/widgets to AnyTrader simply deep-link out to the main AnyTrader web URL in Chrome Custom Tabs / external browser.)

3. **Separate Repository**:
   - Keep this app in its **own dedicated GitHub repository** (e.g., `anyroller-driver-android`), completely separate from the main AnyTrader/AnyRoller web repository. Both repos connect to the **same Firebase project** and the **same live API domain**.

4. **Zero Client-Side Fallbacks for Server-Authoritative Flows**:
   - Following the Slice 1–8 platform hardening, **never** fabricate local success states, fake payment confirmations, simulated document auto-approvals, or local countdown timers when a server API call fails or data is missing. Surface clear, honest error/retry UI instead.

---

## 3. Connection, Networking & Environment Configuration

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

### 3.2 Shared Backend API Base URL & Hardened Transport Contract
Configure `API_BASE_URL` via `BuildConfig` / environment config (never hardcode temporary preview URLs for production):
- **Production**: Your deployed AnyTrader/AnyRoller Cloud Run or custom HTTPS domain (e.g., `https://www.anytrader.co.uk` or your live API origin)
- **Staging/Dev Testing**: Your active AnyTrader/AnyRoller dev/pre URL during development.
- **Authentication Header on ALL authenticated API requests**:
  Every call to protected `/api/*` endpoints MUST include the driver's fresh Firebase Auth ID token:
  ```http
  Authorization: Bearer <firebase_id_token>
  Content-Type: application/json
  ```
- **CORS & Native HTTP Clients (Slice 8 Hardening)**:
  - Standalone production CORS strictly rejects `localhost` and arbitrary `*.run.app` origins (only explicit `ALLOWED_ORIGINS` / HTTPS `APP_URL` are permitted for browser origins).
  - Native Android HTTP clients (`OkHttp` / `Retrofit` / `Ktor`) should **NOT** send a synthetic browser `Origin` header — rely on `Authorization: Bearer <token>`.
- **Guaranteed JSON Error Contract (Slice 8 Hardening)**:
  - The server enforces terminal Express JSON error handling across all routes (never raw HTML stack traces). Standard error responses follow `{ "error": "<message>", "code"?: "<ERROR_CODE>" }`:
    - `400` (`INVALID_JSON` / `BAD_REQUEST`): malformed payload or invalid input.
    - `401` (`UNAUTHORIZED`): missing/expired/revoked Firebase token — refresh ID token once; if still `401` (disabled/revoked), stop `DriverLocationService` and sign out cleanly.
    - `403` (`FORBIDDEN`): driver not approved, suspended, blocked, or unauthorized resource.
    - `409` (`CONFLICT`): another driver claimed the ride first or state transition already occurred — refresh ride state smoothly.
    - `429` (`TOO_MANY_REQUESTS`): rate-limited (`generalLimiter`, `paymentLimiter`, `aiLimiter`) — back off cleanly; **never** tight-loop retry.
    - `503` (`SERVICE_UNAVAILABLE`): transient server/database unavailability or maintenance — show non-destructive retry banner.

### 3.3 Android App Links Verification (`/.well-known/assetlinks.json`)
- The main web server dynamically serves `GET /.well-known/assetlinks.json` via `src/server/mobileDeepLinks.ts` and excludes `/.well-known/` from PWA Service Worker fallback.
- **Fail-Closed Rule**: The endpoint returns HTTP `503` (`ANDROID_ASSETLINKS_UNCONFIGURED`) until real production `ANDROID_APP_PACKAGE` and colon-separated uppercase 32-byte `ANDROID_SHA256_CERT_FINGERPRINTS` are configured in the main backend's environment (placeholder values are rejected).
- **Important Multi-App Note**: The main server defaults `ANDROID_APP_PACKAGE` to `com.anytrader.app`. When publishing the separate AnyRoller Driver Android package (e.g., `com.anyroller.driver`), either coordinate a multi-package `assetlinks.json` update on the main server or host driver deep links on a dedicated AnyRoller subdomain with its own `assetlinks.json`.

### 3.4 Security & Secrets Hygiene
- Never hardcode Google Maps API keys, Stripe keys, or private credentials in source code. Load the Android Maps API key from `local.properties` / `BuildConfig` / manifest placeholder restricted by Android package name + SHA-1 in Google Cloud Console.
- Mask internal exception messages in release builds (`BuildConfig.DEBUG == false`); never display raw stack traces or backend paths to drivers.

---

## 4. Authentication, Compliance Gates & Fail-Closed Driver Eligibility

Drivers sign in with their existing **Firebase Authentication** credentials (Email/Password and/or Google Sign-In).

### 4.1 Fail-Closed Driver Eligibility (`assertAuthoritativeDriverEligibility`)
The backend enforces **fail-closed driver eligibility** on `users/{uid}` and verifies Firebase token revocation (`tokensRevokedAt` / disabled accounts):
1. **Driver Role Required**: `role` is `"driver"`, `"fleet_driver"`, or `"taxi_driver"` (or `isDriver == true` / `accountType == "driver"`).
2. **Not Suspended / Disabled**: None of `disabled`, `isDisabled`, `isSuspended`, `suspended`, `isBanned`, `banned`, `isDeactivated`, `deactivated` is `true`, and `status` / `driverStatus` is not `"suspended"`, `"banned"`, `"disabled"`, `"inactive"`, or `"deactivated"`.
3. **Admin Approval Required**: `driverApproved == true`.

### 4.2 Startup & Session Compliance Flow (Updated Post-Slice 1)
On every app start / sign-in:
1. Check `GET /api/maintenance/status` — if `{ maintenanceMode: true }`, show a clean maintenance screen and prevent going online.
2. Read `users/{uid}`:
   - If the user is not a driver, show a clear message directing them to register as a driver on the AnyRoller web portal.
   - If suspended/disabled, show an **"Account Suspended — Contact Support"** screen and immediately sign out / stop tracking.
   - If terms have not been accepted for the current platform version, prompt acceptance and submit via **`POST /api/account/accept-terms`** (direct client writes to `termsAcceptedVersion`/`termsAcceptedAt` on `users/{uid}` are **blocked** by `firestore.rules`).
   - Call **`POST /api/account/sync-expired-docs`** once per session so the server authoritatively checks expired compliance documents (PCO/PHV licence, insurance, MOT) and triggers 30-day renewal alerts. Never mutate `verificationStatus`, `isVerified`, or `driverApproved` from the client.
   - If `driverApproved != true`, show a clean **"Account Pending Verification"** screen (do not allow going online or accepting rides).

### 4.3 Google Play Account Deletion & GDPR Self-Service Compliance
Google Play requires an in-app account deletion path for apps supporting account login:
- Wire **Menu → Privacy & Account** to `POST /api/account/gdpr/export` (download personal data export) and `POST /api/account/gdpr/delete-account` (with explicit confirmation dialog; unregister FCM token and stop `DriverLocationService` before completing sign-out).

---

## 5. Exact Firestore & Firebase Storage Real-Time Data Contract

The Driver App interacts directly with Firestore **only** for allowed real-time reads, GPS presence writes, in-ride chat messages, personal driver expenses, and hazard reporting. **All ride state transitions, account compliance updates, chat blocks, notifications creation, and financial mutations MUST go through the server REST API (Section 6).**

> **Composite Indexes Note**: `firestore.indexes.json` on the main project already provisions all 87 production composite indexes, including `ride_requests` (`driverId + status + completedAt`, `driverId + createdAt`, `driverId + status + createdAt`, `status + createdAt`), `driver_expenses` (`driverId + date`), `notifications` (`userId + createdAt`, `userId + read + createdAt`), `push_devices` (`active + updatedAt`), and bidirectional `chat_user_blocks` (`blockerUid + active`, `blockedUid + active`). Do **not** add unindexed compound queries without checking `firestore.indexes.json` first.

### 5.1 Firestore Collections & Document Schemas

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
- **STRICT SECURITY RULE WARNING**: Firestore rules block client writes to financial & protected fields (`paymentStatus`, `paid`, `isPaid`, `finalFare`, `driverEarnings`, `commissionAmount`, `platformFee`, `stripeTransferId`, `payoutStatus`, `payoutClaimToken`, etc.). **Always use the `/api/rides/*` endpoints in Section 6 for accepting, transitioning, completing, and cancelling rides.**

#### D. `ride_requests/{rideId}/chat/{messageId}` (Real-time in-ride chat)
- Driver and passenger can both read and add messages here once the ride is assigned (`driverId == uid` or `assignedDriverId == uid`).
- After writing a chat message to Firestore, call `POST /api/chat-push` so the backend runs the **4-Tier Escalation Waterfall** (Tier-2 free FCM/Web Push immediately + Tier-4 WhatsApp offline fallback after 45s if unread, or 5s for `ride_arrived`).
- While the driver has the in-ride chat screen open in the foreground, send active presence heartbeats via `POST /api/notifications/presence` so any pending WhatsApp fallback alert for the driver self-cancels immediately at £0 cost.

#### E. `driver_metrics/{driverUid}` (Read-only by driver; `allow write: if false`)
- Server-maintained daily/lifetime stats (online minutes, daily driving safety limit, net earnings, ride count, acceptance rate). Read via snapshot listener for the Sticky Earnings Bar and Earnings/Analytics tabs.

#### F. `driver_expenses/{expenseId}` (Driver-scoped read/write for expense logging)
- Drivers can create, read, update, and delete their own expense records (`driverId == driverUid`) for fuel, insurance, servicing, and tax-prep summaries (backed by index `driverId ASC, date DESC`).

#### G. `notifications/{notificationId}` (Read + Mark-Read Only)
- Drivers can listen to their own notifications (`userId == driverUid`, ordered by `createdAt DESC`) and mark items read via either Firestore update strictly touching `['read', 'isRead', 'readAt', 'updatedAt']` OR via the REST endpoints in Section 6.1C. Direct client creation of notifications is **denied**.

#### H. `platform_config/rides` & `platform_config/global` (Read-only — Atomically Published by Super Admin)
- `platform_config/rides`: Platform fare configuration, surge caps, commission rates, and `maxDailyDriverHours` safety limits.
- `platform_config/global`: Global pricing catalog & feature flags (server atomic publish preserves `on_demand_transport` provider models). Never hardcode commission percentages or driving limits in the Android app.

#### I. `reported_hazards/{hazardId}` (Optional live road hazard reporting)
- Read all active hazards; create/update/delete own reports (`reporterId == driverUid`).

#### J. Server-Only Hybrid Messaging, Safety & Compliance Collections (DO NOT WRITE FROM CLIENT)
The main backend owns and strictly locks these collections in `firestore.rules` (client writes are rejected with `PERMISSION_DENIED`):
- `whatsapp_fallback_queue/{recipientUid}_{contextId}` (server read/write only)
- `notification_cooldowns/{cooldownId}` (server read/write only)
- `whatsapp_activation_codes/{code}` (server read/write only)
- `whatsapp_delivery_logs/{logId}` (admin read only, server write only)
- `user_presence/{uid}` (owner read only, server write only — mutate exclusively via `POST /api/notifications/presence`)
- `chat_user_blocks/{blockId}` & `chat_reports/{reportId}` (server write only — manage exclusively via `/api/chat/blocks` and `/api/chat/report-block`)
- `users/{uid}` server-owned fields: `whatsappOptIn`, `whatsappPhoneE164`, `whatsappVerifiedAt`, `whatsappWindowExpiresAtMs`, `termsAcceptedVersion`, `termsAcceptedAt`, `driverApproved`, `verificationStatus`, `isVerified`, `role`, `isAdmin`, `subscriptionType`, `subscriptionStatus` are **strictly protected** from direct client modification.

### 5.2 Firebase Storage Rules & Upload Contract (Updated Post-Slice 8)
All `storage.rules` cross-service checks bind strictly to named DB `ai-studio-anytrader-44dab8b3-bbc9-4352-b725-2cbe7a1dfd2a` (with `support_readonly` admins restricted to read-only):
- **Allowed Raster Image MIME Types ONLY (`isSafeImageMimeType`)**: `image/jpeg`, `image/jpg`, `image/png`, `image/webp`, `image/gif`, `image/heic`, `image/heif`, `image/avif`. **`image/svg+xml` is explicitly blocked.**
- **File Size Limits**: Images `<= 10 MB`, Media/Docs (images, audio, video, PDF, DOC/DOCX) `<= 25 MB`, Videos `<= 50 MB`.
- **Authorized Driver Storage Paths**:
  - `rides/{rideId}/{allPaths=**}` — In-ride chat attachments & trip receipts (assigned driver or passenger only, `<= 25 MB`).
  - `vehicles/{vehicleId}/{allPaths=**}` — Vehicle photos & compliance certificates (`driverId` / `ownerId` only, `<= 25 MB`).
  - `users/{uid}/private/{allPaths=**}` & `verifications/{uid}/{allPaths=**}` — Private KYC, driving licence, PHV badge, & insurance documents (owner only, `<= 25 MB`).
  - `avatars/{uid}/{allPaths=**}` — Public driver profile photo (owner only, safe raster image `<= 10 MB`).
- **Default Deny**: Any path outside the declared ruleset is strictly denied.

---

## 6. Exact Server-Authoritative REST API Contract

All endpoints require `Authorization: Bearer <firebase_id_token>` unless noted.

### 6.1 Push Notification Token Management (CRITICAL FOR NATIVE FCM)
| Method & Endpoint | Body / Params | Purpose |
|---|---|---|
| `POST /api/notifications/register-token` | `{ "fcmToken": "<token>", "deviceId": "<persistent_install_uuid>", "platform": "android" }` | Registers this Android installation's FCM token under `users/{uid}/push_devices/{deviceId}` and revokes any stale account previously logged in on the same physical device. Call immediately after login AND inside `FirebaseMessagingService.onNewToken()`. |
| `POST /api/notifications/unregister-token` | `{ "deviceId": "<persistent_install_uuid>", "token": "<cached_fcm_token>" }` | **MANDATORY ON LOGOUT / ACCOUNT SWITCH.** Unregisters this device so notifications never leak to another driver using the same phone. (`DELETE /api/notifications/push-token/:deviceId` is also supported.) |
| `POST /api/chat-push` | `{ "rideId": "<rideId>", "recipientId": "<passengerUid>", "message": "...", "title": "...", "type"?: "chat" \| "ride_arrived" }` | Dispatches Tier-2 free FCM/Web Push to the passenger AND automatically enqueues Tier-4 WhatsApp offline fallback (`contextType: "anyroller_ride"`). Standard chat waits **45 seconds**; passing `"type": "ride_arrived"` uses the fast **5-second** arrival grace window. Succeeds cleanly even if the passenger has no push token when WhatsApp fallback is queued (`status: "whatsapp_fallback_queued"`). Respects bidirectional `chat_user_blocks`. |

### 6.1B Hybrid Messaging, Presence & Direct Meta WhatsApp Offline Fallback (SHARED BACKEND)

The main server implements a **4-Tier Cost-Controlled Notification Waterfall** shared across AnyTrader web and the AnyRoller Native Driver App:
1. **Tier 1 (Free)**: Real-time Firestore in-app chat listener while app is open.
2. **Tier 2 (Free)**: Native Android FCM Push (for Driver App) / PWA Web Push (for web passengers & AnyTrader users).
3. **Tier 3 (Free/Low-Cost)**: Email fallback where applicable.
4. **Tier 4 (Direct Meta WhatsApp Cloud API — Offline Safety Net Only)**:
   - Fires **ONLY** if the recipient has opted in (`whatsappOptIn == true`), has not blocked the sender (`chat_user_blocks`), AND has not opened/read the conversation after **45 seconds** (5 seconds for `ride_arrived`).
   - Enforces an **atomic 5-minute cooldown** per `(recipientUid, rideId/conversationId)` and a **20 alerts/day per user** cap so rapid chat bursts never cause runaway spend.
   - **Phase 1 Privacy Mode (One-Way Alerts Only)**: WhatsApp messages come from the platform's official Business Account number and include a 1-tap deep link back into the app. **NEVER** open direct personal WhatsApp chats between driver and passenger or expose raw phone numbers.
   - **Smart 24-Hour Service Window**: When a user taps **"Activate on WhatsApp"** and sends the prefilled `AT-XXXXXX` message to our official WhatsApp Business number, the backend's signed Meta webhook verifies opt-in and opens a **24-hour Customer Service Window** so follow-up alerts inside 24h use free-form service replies instead of paid Utility templates.

| Method & Endpoint | Body / Response | Purpose |
|---|---|---|
| `GET /api/notifications/preferences` | Response: `{ success: true, preferences: { whatsappOptIn, whatsappPhoneMasked, whatsappHasPhone, whatsappVerified, whatsappWindowActive, whatsappWindowExpiresAt, emailNotifications, pushNotifications, activePushDevicesCount, businessWhatsAppConfigured, metaApiConfigured } }` | Fetches the signed-in driver's own notification & WhatsApp status. Phone numbers are strictly masked (e.g. `+44•••••6789`) — raw phone numbers are never returned across accounts. |
| `PATCH /api/notifications/preferences` | Request: `{ "whatsappPhone"?: "07700 900123", "whatsappOptIn"?: true \| false, "pushNotifications"?: true, "emailNotifications"?: true }` → Returns updated `{ success: true, preferences }` | Saves/normalizes UK mobile number to E.164 (`+447...`) and toggles WhatsApp fallback on or off. (Users can also opt out anytime by replying `STOP` on WhatsApp.) |
| `POST /api/notifications/whatsapp-activation-link` | Request: `{ "contextLabel"?: "AnyRoller Driver Alerts" }` → Response: `{ success: true, activationCode: "AT-XXXXXX", businessNumberConfigured: boolean, waMeUrl: "https://wa.me/447...?text=..." \| null, prefilledMessage: string, expiresAt: string }` | Mints a single-use 15-minute `AT-XXXXXX` activation code and official `wa.me` deep link. Open `waMeUrl` via Android `Intent(Intent.ACTION_VIEW, Uri.parse(waMeUrl))` (validate prefix `https://wa.me/`) so WhatsApp opens pre-filled with 1 tap. If `businessNumberConfigured == false`, display a clean "WhatsApp alerts coming soon" state without crashing. |
| `POST /api/notifications/presence` | Request: `{ "activeConversationId": "<rideId or conversationId>" \| null, "markRead"?: true }` → Response: `{ success: true, activeConversationId }` | **CRITICAL FOR £0 COST ON ACTIVE CHATS**: Call on entering the in-ride chat screen, every **45 seconds** while chat is visible in foreground, and with `{ "activeConversationId": null, "markRead": false }` when leaving/backgrounding chat. Immediately cancels any pending WhatsApp fallback job for that `rideId`. |

### 6.1C Account Compliance, Inbox Notifications, Chat Safety & System Health (Added Slices 1–8)
| Method & Endpoint | Auth | Body / Purpose |
|---|---|---|
| `GET /api/health` | Public | Server liveness/readiness check (`AnyTrader UK API`). |
| `GET /api/maintenance/status` | Public | Returns `{ maintenanceMode: boolean }`. Block going online when `true`. |
| `POST /api/account/accept-terms` | Bearer | Server-authoritative terms & privacy acceptance (`{ termsVersion, privacyVersion }`). Replaces blocked client `users/{uid}` writes. |
| `POST /api/account/sync-expired-docs` | Bearer | Server-authoritative compliance document expiry & 30-day warning sync (call once per login/session). |
| `POST /api/account/gdpr/export` | Bearer | Generates downloadable GDPR personal data export for the signed-in driver. |
| `POST /api/account/gdpr/delete-account` | Bearer | Server-authoritative account deletion/anonymization request (required for Google Play Data Safety compliance). |
| `GET /api/notifications` | Bearer | Lists signed-in user's notifications (complementing real-time Firestore listener). |
| `PATCH /api/notifications/:id/read` | Bearer | Marks a notification read (`DELETE /api/notifications/:id` deletes own notification). |
| `GET /api/chat/blocks` | Bearer | Returns `{ blockedUserIds, blockedByUserIds }` for bidirectional safety checks. |
| `POST /api/chat/report-block` | Bearer | Reports and/or blocks an abusive user server-side (`chat_reports` + `chat_user_blocks`). |
| `DELETE /api/chat/blocks/:targetUserId` | Bearer | Unblocks a previously blocked user. |

### 6.2 Driver Online Heartbeat, Demand Zones & Analytics Pulse
| Method & Endpoint | Body / Params | Purpose |
|---|---|---|
| `POST /api/driver/metrics/heartbeat` | `{}` | Call every **60 seconds** while driver is Online. Returns `{ limitReached, maxDailyDriverHours, ... }`. If `limitReached == true`, automatically switch driver Offline and show the safety driving-hours limit alert. |
| `GET /api/rides/demand-zones` | Query params (optional area/coords) | Rate-limited (`generalLimiter`). Fetches live high/moderate/low demand & surge heatmap zones for the Home map. |
| `POST /api/driver/analytics-pulse` | `{ ... }` | Rate-limited (`aiLimiter`). Optional server-side AI earnings/demand insights for the Earnings tab (never call Gemini directly from Android). |

### 6.3 Server-Authoritative Ride Lifecycle (ALL mutations go through here)
| Method & Endpoint | Body | Purpose |
|---|---|---|
| `POST /api/rides/accept` | `{ "rideId": "<rideId>" }` | Atomically claims a `pending`/`searching`/`offered` ride in a Firestore transaction after verifying `driverApproved == true`. Returns `409 Conflict` if another driver claimed it first. |
| `POST /api/rides/transition` | `{ "rideId": "<rideId>", "action": "arrived" \| "in_progress" \| "stop_progress" \| "early_completion_reason", "paidWaitSeconds"?: number, "currentStopIndex"?: number, "earlyCompletionReason"?: string }` | Server-authoritative state machine transitions: `accepted → arrived → in_progress`, multi-stop progression, and early completion reason logging. |
| `POST /api/rides/create-trip-payment` | `{ "rideId": "<rideId>", ... }` | Generates/reuses Stripe Checkout payment link / QR URL (`url`, `intentId`, `effectiveBaseFare`, `sanitizedTip`, `totalAmount`) for card/QR trip payment. |
| `POST /api/rides/complete` | `{ "rideId": "<rideId>", "action": "auto_card" \| "qr_pending" \| "qr_manual_close" \| "cash_report" \| "cash_finalize" \| "abandonment", "paidWaitSeconds"?: number, "cashCollected"?: number, "earlyCompletionReason"?: string, "paymentUrl"?: string, "abandonmentFee"?: number }` | Server-authoritative completion, canonical `v2_excl_tip` fare + commission settlement, and transactional `driver_metrics` earnings update. |
| `POST /api/rides/cancel` | `{ "rideId": "<rideId>", "cancelledBy": "driver" }` | Server-authoritative driver cancellation with state machine enforcement. |

### 6.4 Driver Earnings, Stripe Connect, Fee Settlements & Gold Tier Subscriptions
> **Browser / Payment UX Rule**: Always open Stripe Connect onboarding, Stripe Express dashboard links, fee-settlement Checkout sessions, and subscription Checkout/Billing Portal URLs in **Android Chrome Custom Tabs** (never inside an embedded `WebView`). Never trust client-side redirect query parameters as proof of payment — always reflect authoritative Firestore state written by Stripe webhooks.

| Method & Endpoint | Purpose |
|---|---|
| `GET /api/driver/stripe-balance/:driverId` | Fetch driver's live Stripe Connect available & pending balance (must match authenticated `driverId`). |
| `POST /api/driver/stripe-payout/:driverId` | Trigger payout to driver's linked bank account (`{ "amount"?: number }`). |
| `GET /api/stripe/account-status` | Check whether driver's Stripe Connect onboarding & payouts are enabled. |
| `POST /api/stripe/create-connect-account` | Generate Stripe Connect onboarding URL (open in Chrome Custom Tab). |
| `POST /api/stripe/create-login-link` | Generate Stripe Express dashboard login link (open in Chrome Custom Tab). |
| `GET /api/driver/fee-settlement-status` | Check any outstanding cash-trip platform commission balance. |
| `POST /api/driver/settle-fees` | Create Stripe Checkout link to settle cash-trip platform fees (open in Chrome Custom Tab). |
| `POST /api/create-checkout-session` | Initiate Stripe Checkout for Driver Gold Tier subscription (open in Chrome Custom Tab; fulfillment occurs exclusively via verified Stripe webhook). |
| `POST /api/create-customer-portal-session` | Open Stripe Billing Portal for self-service payment methods & invoices (Chrome Custom Tab). |
| `POST /api/cancel-subscription` / `POST /api/reactivate-subscription` | Self-service cancellation (at period end) and reactivation for active driver subscriptions. |

---

## 7. Required Native Android Capabilities

### 7.1 Persistent Background GPS Foreground Service (`DriverLocationService`)
- Permissions: `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`, `WAKE_LOCK`.
- When driver taps **Go Online**:
  1. Verify `driverApproved == true` and `maintenanceMode == false`.
  2. Start `DriverLocationService` as a `ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION` foreground service with a persistent notification: *"AnyRoller Online — Ready for rides"* (or *"Active Trip — Sharing live location"*).
  3. Use `FusedLocationProviderClient` (`Priority.PRIORITY_HIGH_ACCURACY`, interval 5s, min distance 15m).
  4. Write throttled updates to `live_tracking/{uid}` and `driver_status/{uid}` (immediately on Go Online, then every 10–15s if moved ≥15m or every 60s max).
  5. Run the 60-second `/api/driver/metrics/heartbeat` loop inside the service so online hours remain accurate even when backgrounded.
- When driver taps **Go Offline** (or logs out, receives `401` revoked token, or hits daily safety limit):
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

### 7.5 Offline Alerts & 1-Tap WhatsApp Activation (Android UX Integration)
Integrate the shared Hybrid Messaging & WhatsApp fallback backend into the Driver App in three places:
1. **Menu → Offline & WhatsApp Alerts Card**:
   - Load status from `GET /api/notifications/preferences`.
   - Show Native Android FCM push status (verify `POST_NOTIFICATIONS` permission + battery optimization exemption prompt).
   - Provide UK mobile input + **Save & Enable / Pause WhatsApp** button (`PATCH /api/notifications/preferences`).
   - Provide **"1-Tap Activate on WhatsApp"** button calling `POST /api/notifications/whatsapp-activation-link` with `{ "contextLabel": "AnyRoller Driver Alerts" }`, then launch `waMeUrl` via `Intent(Intent.ACTION_VIEW, Uri.parse(waMeUrl))` (only if URL starts with `https://wa.me/`). Show verified / 24h active status badge once confirmed.
2. **In-Ride Chat Screen (`ride_requests/{rideId}/chat`)**:
   - On `ON_RESUME` / entering chat: call `POST /api/notifications/presence` with `{ "activeConversationId": rideId, "markRead": true }`, repeat every **45 seconds** while screen stays visible, and call `{ "activeConversationId": null, "markRead": false }` on `ON_PAUSE` / leaving chat.
   - When sending a message to the passenger: write to Firestore, then call `POST /api/chat-push` with `{ "rideId": rideId, "recipientId": passengerId, "title": "AnyRoller Driver", "message": text }`.
   - When tapping **"Arrived at Pickup"**: after `POST /api/rides/transition` (`action: "arrived"`), also notify via `POST /api/chat-push` with `"type": "ride_arrived"` so an offline passenger gets the fast 5-second WhatsApp wake-up fallback if FCM/Web Push doesn't reach them.
   - Include a **"Report / Block Passenger"** safety action calling `POST /api/chat/report-block`.
3. **App Link / Deep Link Handling**:
   - Handle incoming links from WhatsApp alerts back to active ride/chat screens cleanly so tapping a WhatsApp notification returns the driver directly into the Driver App (paired with production `/.well-known/assetlinks.json` setup in Section 3.3).

---

## 8. Owner-Locked UI / UX Specification

Follow the AnyRoller Driver Design System (`DRIVER_UI_SPEC.md`):

- **Philosophy**: Money-first, Map-second, One-thumb windscreen usability (all primary actions in bottom half of screen), 2-second glanceable, transparent fare/commission breakdowns on every ride.
- **Theme**: **Dark Mode Default** (`#0D0D0F` primary BG, `#1A1A1E` secondary BG, `#252529` tertiary BG, `#FFFFFF` primary text, `#00D26A` green, `#FF3B30` red, `#FF9500` orange, `#007AFF` blue).
- **Locked Navigation HUD Text Style (DO NOT ALTER)**:
  - Heads-up navigation text rendered over the map MUST have a **transparent background** (no black box), **dark blue (`#2563EB`) text**, with a **soft white drop shadow** (`#FFFFFF` at 90% opacity) and **no text stroke**.
- **4 Bottom Tabs Only**:
  1. **Home**: Sticky Earnings Bar + Demand Map + Smart Surge Tip + Active Bonus + AnyTrader Cross-Sell card (links to web via Chrome Custom Tab) + Big full-width **Go Online / Go Offline** button.
  2. **Earnings**: Today / Week / Month net earnings, commission & tips breakdown, Stripe Connect balance & instant payout button, cash fee settlement status, personal `driver_expenses` logger.
  3. **Inbox**: Ride messages, platform/document expiry alerts (`notifications` collection + mark read), AnyTrader lead alerts.
  4. **Menu**: Profile, Vehicle & Documents status (raster-only uploads to `vehicles/` & `verifications/`), Stripe Connect onboarding, Gold Tier Subscription (Chrome Custom Tabs), **Offline & WhatsApp Alerts** (FCM status + 1-tap `AT-XXXXXX` WhatsApp backup opt-in), Stacking / Destination Mode / Zone / Pet-Friendly toggles, Navigation App preference (Google Maps vs Waze), Privacy & GDPR Account Export/Delete, Sign Out (must unregister push token and stop `DriverLocationService` first!).
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
2. Point all REST API calls to a configurable `BuildConfig.API_BASE_URL` and attach the driver's Firebase Auth ID token as `Authorization: Bearer <token>` on every authenticated request (never send synthetic Origin headers or embed API secrets). Handle standard JSON error codes (400/401/403/409/429/503) cleanly without tight-loop retries or raw stack traces in release builds.
3. Do NOT deploy or overwrite Firestore or Storage security rules—the main AnyTrader web app owns all backend logic, WhatsApp API integration, Stripe webhooks, and security rules.
4. Implement startup compliance & eligibility gates: check `GET /api/maintenance/status`, enforce fail-closed `driverApproved == true` gating, submit terms acceptance exclusively via `POST /api/account/accept-terms`, call `POST /api/account/sync-expired-docs` once per session, and wire Google Play compliant GDPR data export/account deletion (`POST /api/account/gdpr/export` & `POST /api/account/gdpr/delete-account`).
5. Implement the Android Foreground Location Service (`DriverLocationService`), high-priority FCM push notification service (`AnyRollerMessagingService`) with token registration/unregistration, Google Maps/Waze navigation intents, safe raster-only Storage uploads (JPEG/PNG/WebP/HEIC, never SVG), Chrome Custom Tabs for all Stripe Connect/Fee Settlement/Subscription flows (never client-side payment fallbacks), and the full 4-tab Dark Mode Driver Terminal + active ride lifecycle UI specified in the handoff document.
6. Integrate the shared Hybrid Messaging, Safety & WhatsApp Offline Fallback endpoints (`GET`/`PATCH /api/notifications/preferences`, `POST /api/notifications/whatsapp-activation-link` with Android `Intent.ACTION_VIEW` for 1-tap `wa.me` activation, `POST /api/notifications/presence` 45s heartbeat while viewing in-ride chat, `POST /api/chat-push` including `"type": "ride_arrived"` for fast 5s passenger arrival alerts, and `POST /api/chat/report-block`). Never call Meta Graph API directly or expose personal phone numbers between drivers and passengers.
```
