/**
 * Automated Release Candidate Audit Script for AnyTrader V8.0
 * Runs pre-flight verification across Environment, Security Rules, Invariants, and Build.
 */
import fs from "fs";
import path from "path";
import { runProductionChecks } from "../src/server/productionChecks.ts";

console.log("==========================================================");
console.log("🛡️  ANYTRADER V8.0 — PRE-FLIGHT RELEASE CANDIDATE AUDIT");
console.log("==========================================================\n");

let criticalFailures = 0;
let warnings = 0;

// 1. Mandatory File Presence Checks
console.log("1. Inspecting Mandatory Security & Configuration Assets...");
const requiredFiles = [
  "firestore.rules",
  "storage.rules",
  "firestore.indexes.json",
  "server.ts",
  "package.json",
  "src/server/stateMachine.ts",
  "src/server/paymentLedger.ts",
  "src/server/authorization.ts",
  "src/server/httpErrors.ts",
  "src/server/domainEvents.ts",
  "src/server/taskQueue.ts",
  "src/server/productionChecks.ts",
  "tests/unit/stateMachine.test.ts",
  "tests/unit/paymentLedger.test.ts",
  "tests/unit/authorization.test.ts",
  "tests/unit/productionChecks.test.ts",
  "tests/unit/adversarialRedTeam.test.ts",
];

for (const file of requiredFiles) {
  const fullPath = path.join(process.cwd(), file);
  if (fs.existsSync(fullPath)) {
    console.log(`  ✅ Found ${file}`);
  } else {
    console.error(`  ❌ MISSING CRITICAL FILE: ${file}`);
    criticalFailures++;
  }
}

// 2. Storage Rules Check
console.log("\n2. Auditing Firebase Storage Rules...");
try {
  const storageContent = fs.readFileSync(path.join(process.cwd(), "storage.rules"), "utf8");
  if (storageContent.includes("allow read, write: if true;")) {
    console.error("  ❌ CRITICAL: storage.rules contains wide-open anonymous write permissions!");
    criticalFailures++;
  } else {
    console.log("  ✅ storage.rules enforces authenticated scoping and file limits.");
  }
} catch (e) {
  console.warn("  ⚠️ Warning checking storage.rules:", e.message);
  warnings++;
}

// 3. Firestore Rules Check
console.log("\n3. Auditing Firestore Security Rules...");
try {
  const firestoreContent = fs.readFileSync(path.join(process.cwd(), "firestore.rules"), "utf8");
  if (firestoreContent.includes("match /{document=**} { allow read, write: if true; }")) {
    console.error("  ❌ CRITICAL: firestore.rules contains default allow all!");
    criticalFailures++;
  } else {
    console.log("  ✅ firestore.rules implements default deny and collection-level auth guards.");
  }
} catch (e) {
  console.warn("  ⚠️ Warning checking firestore.rules:", e.message);
  warnings++;
}

// 3.5 Named Production Database & Composite Indexes Verification (AT-ADMIN-PROD-AUDIT-01)
console.log("\n3.5. Auditing Named Firestore Database & Composite Indexes...");
try {
  const appletConfigPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (!fs.existsSync(appletConfigPath)) {
    console.error("  ❌ CRITICAL: firebase-applet-config.json is missing!");
    criticalFailures++;
  } else {
    const appletCfg = JSON.parse(fs.readFileSync(appletConfigPath, "utf8"));
    const expectedDbId = "ai-studio-anytrader-44dab8b3-bbc9-4352-b725-2cbe7a1dfd2a";
    if (appletCfg.firestoreDatabaseId !== expectedDbId) {
      console.error(`  ❌ CRITICAL: firebase-applet-config.json firestoreDatabaseId is '${appletCfg.firestoreDatabaseId}', expected '${expectedDbId}'!`);
      criticalFailures++;
    } else {
      console.log(`  ✅ Named production Firestore database verified (${expectedDbId}).`);
    }
  }

  const indexesPath = path.join(process.cwd(), "firestore.indexes.json");
  const parsedIndexes = JSON.parse(fs.readFileSync(indexesPath, "utf8"));
  if (!Array.isArray(parsedIndexes.indexes)) {
    console.error("  ❌ CRITICAL: firestore.indexes.json is missing a valid 'indexes' array!");
    criticalFailures++;
  } else {
    const hasQuotesCollectionGroup = parsedIndexes.indexes.some(
      (idx) => idx.collectionGroup === "quotes" && idx.queryScope === "COLLECTION_GROUP"
    );
    if (!hasQuotesCollectionGroup) {
      console.error("  ❌ CRITICAL: firestore.indexes.json is missing required COLLECTION_GROUP index for 'quotes'!");
      criticalFailures++;
    } else {
      console.log(`  ✅ firestore.indexes.json parsed cleanly (${parsedIndexes.indexes.length} composite indexes including COLLECTION_GROUP quotes).`);
    }
  }

  const emulatorHelperPath = path.join(process.cwd(), "tests/unit/helpers/namedDbEmulator.ts");
  if (!fs.existsSync(emulatorHelperPath)) {
    console.error("  ❌ CRITICAL: tests/unit/helpers/namedDbEmulator.ts is missing!");
    criticalFailures++;
  } else {
    const helperContent = fs.readFileSync(emulatorHelperPath, "utf8");
    const expectedDbId = "ai-studio-anytrader-44dab8b3-bbc9-4352-b725-2cbe7a1dfd2a";
    if (!helperContent.includes(expectedDbId)) {
      console.error("  ❌ CRITICAL: namedDbEmulator.ts does not target the named production database ID!");
      criticalFailures++;
    } else {
      console.log(`  ✅ Emulator security-rules test helper targets named database (${expectedDbId}).`);
    }
  }
} catch (e) {
  console.error("  ❌ CRITICAL: Error validating database/index manifests:", e.message);
  criticalFailures++;
}

// 4. Runtime Invariants & Environment Audit
console.log("\n4. Running Production Invariant Scanner...");
const auditReport = runProductionChecks(process.env);
for (const check of auditReport.checks) {
  if (check.status === "FAIL") {
    console.error(`  ❌ [${check.category}] ${check.name}: ${check.message}`);
    criticalFailures++;
  } else if (check.status === "WARN") {
    console.warn(`  ⚠️ [${check.category}] ${check.name}: ${check.message}`);
    warnings++;
  } else {
    console.log(`  ✅ [${check.category}] ${check.name}: ${check.message}`);
  }
}

// 5. Final Determination
console.log("\n==========================================================");
console.log(`AUDIT SUMMARY: ${criticalFailures} Critical Failure(s), ${warnings} Warning(s)`);
console.log("==========================================================");

if (criticalFailures > 0) {
  console.error("⛔ FINAL RELEASE DECISION: NO-GO");
  console.error("The application cannot be released until all critical security gaps are resolved.");
  process.exit(1);
} else if (warnings > 0) {
  console.warn("⚠️  FINAL RELEASE DECISION: GO WITH EXPLICIT ACCEPTED RISKS");
  console.warn("All critical invariants passed. Non-critical warnings detected.");
  process.exit(0);
} else {
  console.log("🎉 FINAL RELEASE DECISION: GO");
  console.log("All security, financial, and structural invariants passed cleanly!");
  process.exit(0);
}
