import type express from "express";

export interface MaintenanceStatus {
  maintenanceMode: boolean;
  source: "env" | "firestore" | "default";
  updatedAt?: string;
  updatedBy?: string;
}

const DEFAULT_CACHE_TTL_MS = 5000;

let cachedMaintenanceMode: boolean | null = null;
let cachedAtMs = 0;

export function invalidateMaintenanceCache(knownValue?: boolean): void {
  if (typeof knownValue === "boolean") {
    cachedMaintenanceMode = knownValue;
    cachedAtMs = Date.now();
  } else {
    cachedMaintenanceMode = null;
    cachedAtMs = 0;
  }
}

export async function isMaintenanceModeActive(options: {
  db?: any;
  env?: NodeJS.ProcessEnv;
  forceRefresh?: boolean;
  cacheTtlMs?: number;
}): Promise<boolean> {
  const {
    db,
    env = process.env,
    forceRefresh = false,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  } = options;

  if (env.MAINTENANCE_MODE === "true") {
    return true;
  }

  const now = Date.now();
  if (!forceRefresh && cachedMaintenanceMode !== null && now - cachedAtMs < cacheTtlMs) {
    return cachedMaintenanceMode;
  }

  if (!db) {
    return cachedMaintenanceMode ?? false;
  }

  try {
    const snap = await db.collection("platform_config").doc("global").get();
    const exists = typeof snap?.exists === "function" ? snap.exists() : Boolean(snap?.exists);
    const data = exists ? (typeof snap.data === "function" ? snap.data() : snap.data) : null;
    const active = Boolean(data?.maintenanceMode === true);
    cachedMaintenanceMode = active;
    cachedAtMs = now;
    return active;
  } catch (err: any) {
    // If database check fails during an active outage/lockdown, preserve last known cached state
    return cachedMaintenanceMode ?? false;
  }
}

export interface MaintenanceMiddlewareOptions {
  getDb: () => any;
  verifyTokenFn: (token: string) => Promise<any>;
  checkIsAdminFn: (user: any) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}

const MAINTENANCE_EXEMPT_PREFIXES = [
  "/api/health",
  "/api/ready",
  "/api/maintenance/status",
  "/api/webhook",
];

export function createMaintenanceEmergencyStopMiddleware(
  options: MaintenanceMiddlewareOptions
): express.RequestHandler {
  const { getDb, verifyTokenFn, checkIsAdminFn, env = process.env } = options;

  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const reqPath = req.path || req.originalUrl || "";
    const fullApiPath = req.originalUrl?.split("?")[0] || `/api${reqPath}`;

    if (
      MAINTENANCE_EXEMPT_PREFIXES.some(
        (prefix) => reqPath === prefix || fullApiPath === prefix || fullApiPath.startsWith(`${prefix}/`)
      ) ||
      fullApiPath.startsWith("/api/admin") ||
      reqPath.startsWith("/admin")
    ) {
      return next();
    }

    const active = await isMaintenanceModeActive({ db: getDb(), env });
    if (!active) {
      return next();
    }

    // Verified admins remain allowed to operate and lift maintenance mode
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.slice(7);
        const decoded = await verifyTokenFn(token);
        const isAdmin = await checkIsAdminFn(decoded);
        if (isAdmin) {
          (req as any).user = decoded;
          return next();
        }
      } catch {
        // Non-admin or invalid token falls through to 503 maintenance gate
      }
    }

    return res.status(503).json({
      error: "Platform is currently in maintenance mode. Operations are temporarily paused.",
      code: "MAINTENANCE_MODE_ACTIVE",
      maintenanceMode: true,
    });
  };
}
