// AT-FIRESTORE-DB-01: Named Production Database Emulator Parity Helper
// Ensures all Firestore & Storage security-rules emulator suites target the exact named
// production database ID from firebase-applet-config.json (`ai-studio-anytrader-44dab8b3-bbc9-4352-b725-2cbe7a1dfd2a`).

import fs from "fs";
import path from "path";
import * as admin from "firebase-admin";
import { getFirestore as getAdminFirestore } from "firebase-admin/firestore";
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
  type TestEnvironmentConfig,
} from "@firebase/rules-unit-testing";

export const PRODUCTION_FIRESTORE_DATABASE_ID =
  "ai-studio-anytrader-44dab8b3-bbc9-4352-b725-2cbe7a1dfd2a";

/**
 * Loads and verifies the committed named production Firestore database ID from firebase-applet-config.json.
 * Fails closed if the file is missing or diverges from PRODUCTION_FIRESTORE_DATABASE_ID.
 */
export function loadVerifiedProductionDatabaseId(rootDir: string = process.cwd()): string {
  const configPath = path.resolve(rootDir, "firebase-applet-config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error("firebase-applet-config.json is missing; cannot verify named Firestore database ID.");
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const dbId = String(parsed?.firestoreDatabaseId || "").trim();
  if (dbId !== PRODUCTION_FIRESTORE_DATABASE_ID) {
    throw new Error(
      `Named Firestore database ID mismatch: expected '${PRODUCTION_FIRESTORE_DATABASE_ID}', got '${dbId}'.`
    );
  }
  return dbId;
}

/**
 * Builds the rules-unit-testing Firestore config targeting the named production database ID.
 */
export function buildNamedDbEmulatorConfig(config: TestEnvironmentConfig): TestEnvironmentConfig {
  const verifiedDbId = loadVerifiedProductionDatabaseId();
  process.env.FIRESTORE_DATABASE_ID = verifiedDbId;

  return {
    ...config,
    firestore: config.firestore
      ? ({
          ...config.firestore,
          // Explicit named-database target metadata for emulator parity (AT-FIRESTORE-DB-01)
          databaseId: verifiedDbId,
        } as any)
      : undefined,
  };
}

/**
 * Initializes a Firebase RulesTestEnvironment bound explicitly to PRODUCTION_FIRESTORE_DATABASE_ID.
 */
export async function initializeNamedDbTestEnvironment(
  config: TestEnvironmentConfig
): Promise<RulesTestEnvironment> {
  return initializeTestEnvironment(buildNamedDbEmulatorConfig(config));
}

/**
 * Returns an Admin Firestore client targeting the named production database ID explicitly.
 */
export function getNamedAdminFirestore(app?: admin.app.App) {
  const verifiedDbId = loadVerifiedProductionDatabaseId();
  const targetApp = app || (admin.apps.length > 0 ? admin.app() : admin.initializeApp({ projectId: "demo-anytrader" }));
  return getAdminFirestore(targetApp, verifiedDbId);
}
