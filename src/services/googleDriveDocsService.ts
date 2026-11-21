// Google Drive & Google Docs Service for AnyTrader Contract & Certificate Generation
// Uses OAuth 2.0 GIS token acquisition with drive.file and documents scopes.

// In-memory token store for security (H-02: Never persist OAuth bearer tokens in localStorage)
let inMemoryDocsAccessToken: string | null = null;
let inMemoryDocsTokenExpiry: number | null = null;
let inMemoryDocsOwnerUid: string | null = null;
let activeDocsSessionUid: string | null = null;

export function bindGoogleDriveDocsSessionUid(uid: string | null): void {
  const normalizedUid = uid || null;
  if (normalizedUid !== activeDocsSessionUid) {
    if (inMemoryDocsAccessToken && (!normalizedUid || inMemoryDocsOwnerUid !== normalizedUid)) {
      disconnectGoogleDriveDocs();
    }
    activeDocsSessionUid = normalizedUid;
  }
}

export function getStoredDocsAccessToken(expectedUid: string | null = activeDocsSessionUid): string | null {
  if (!inMemoryDocsAccessToken || !inMemoryDocsTokenExpiry) return null;

  const normalizedExpected = expectedUid ?? activeDocsSessionUid ?? null;
  if (inMemoryDocsOwnerUid !== null && normalizedExpected !== inMemoryDocsOwnerUid) {
    inMemoryDocsAccessToken = null;
    inMemoryDocsTokenExpiry = null;
    inMemoryDocsOwnerUid = null;
    return null;
  }

  if (Date.now() >= inMemoryDocsTokenExpiry) {
    inMemoryDocsAccessToken = null;
    inMemoryDocsTokenExpiry = null;
    inMemoryDocsOwnerUid = null;
    return null;
  }
  return inMemoryDocsAccessToken;
}

export function setStoredDocsAccessToken(
  token: string,
  expiresInSeconds: number = 3600,
  ownerUid: string | null = activeDocsSessionUid
) {
  const expiryTime = Date.now() + (expiresInSeconds - 60) * 1000;
  inMemoryDocsAccessToken = token;
  inMemoryDocsTokenExpiry = expiryTime;
  inMemoryDocsOwnerUid = ownerUid ?? activeDocsSessionUid ?? null;
}

export function disconnectGoogleDriveDocs(): void {
  const tokenToRevoke = inMemoryDocsAccessToken;
  inMemoryDocsAccessToken = null;
  inMemoryDocsTokenExpiry = null;
  inMemoryDocsOwnerUid = null;
  if (tokenToRevoke && typeof window !== "undefined") {
    try {
      const revoke = (window as any).google?.accounts?.oauth2?.revoke;
      if (typeof revoke === "function") {
        revoke(tokenToRevoke, () => {});
      }
    } catch {}
  }
}

export async function requestDriveDocsAccessToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const googleObj = (window as any).google;
      if (!googleObj?.accounts?.oauth2) {
        reject(new Error("Google Identity Services script not ready. Please refresh and try again."));
        return;
      }

      const client = googleObj.accounts.oauth2.initTokenClient({
        client_id: "437256678397-applet-client.apps.googleusercontent.com",
        scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/documents",
        callback: (response: any) => {
          if (response.error) {
            reject(new Error(response.error_description || response.error));
            return;
          }
          if (response.access_token) {
            const expiresIn = response.expires_in ? parseInt(response.expires_in, 10) : 3600;
            setStoredDocsAccessToken(response.access_token, expiresIn);
            resolve(response.access_token);
          } else {
            reject(new Error("No access token returned from Google."));
          }
        },
      });

      client.requestAccessToken({ prompt: "consent" });
    } catch (err: any) {
      reject(err);
    }
  });
}

export interface VerifiedTraderCredentials {
  publicLiabilityVerified?: boolean;
  insuranceProvider?: string;
  insurancePolicyNumber?: string;
  publicLiabilityLimit?: string;
  warrantyVerified?: boolean;
  warrantyMonths?: number;
  siteSafetyVerified?: boolean;
  certifications?: string[];
}

export interface ContractDetails {
  documentType: "Trade Service Agreement" | "Liability Waiver" | "Job Completion Certificate";
  jobTitle: string;
  jobRef: string;
  clientName: string;
  clientAddress?: string;
  traderName: string;
  traderCompany?: string;
  amount: number | string;
  startDate?: string;
  scopeOfWork?: string;
  completionNotes?: string;
  verifiedCredentials?: VerifiedTraderCredentials;
}

/**
 * Builds legal contract / waiver / completion certificate text strictly from
 * verified trader credentials, marking unverified clauses explicitly as [To Confirm].
 * (AT-CJ-GDOC-02)
 */
export function buildContractTextContent(details: ContractDetails, dateLabel?: string): string {
  const todayStr =
    dateLabel ||
    new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const creds = details.verifiedCredentials || {};

  const insuranceClause = creds.publicLiabilityVerified
    ? `Verified UK Public Liability Insurance on file${creds.insuranceProvider ? ` (${creds.insuranceProvider}` : ""}${creds.insurancePolicyNumber ? `, Policy: ${creds.insurancePolicyNumber}` : ""}${creds.publicLiabilityLimit ? `, Cover: ${creds.publicLiabilityLimit}` : ""}${creds.insuranceProvider ? ")" : ""}.`
    : "UK Public Liability Insurance: [To Confirm] — Contractor to provide verified certificate of insurance prior to work commencement.";

  const warrantyClause =
    creds.warrantyVerified && typeof creds.warrantyMonths === "number" && creds.warrantyMonths > 0
      ? `Verified ${creds.warrantyMonths}-Month Workmanship Guarantee applies from date of sign-off as confirmed on trader profile.`
      : "Workmanship Guarantee & Warranty Period: [To Confirm] — Terms and duration to be confirmed in writing by the Contractor before sign-off.";

  const siteSafetyClause = creds.siteSafetyVerified
    ? `Contractor site safety & compliance credentials verified on file${Array.isArray(creds.certifications) && creds.certifications.length > 0 ? ` (${creds.certifications.join(", ")})` : ""}. Both parties agree to adhere to applicable UK Health & Safety at Work Act 1974 requirements.`
    : "Site Safety & Compliance Credentials: [To Confirm] — Client and Contractor must jointly confirm site hazard assessment and any required trade certifications prior to work commencement.";

  if (details.documentType === "Trade Service Agreement") {
    return `FORMAL UK TRADE SERVICE AGREEMENT
Ref: ${details.jobRef} | Date: ${todayStr}

PARTIES:
- Service Provider (Trader): ${details.traderName} ${details.traderCompany ? `(${details.traderCompany})` : ""}
- Client (Homeowner/Business): ${details.clientName}
- Site Location: ${details.clientAddress || "[To Confirm]"}

1. SCOPE OF WORKS
The Service Provider agrees to perform the following works in a good and workmanlike manner:
${details.scopeOfWork || details.jobTitle}

2. FINANCIAL TERMS & AGREED VALUE
Total Agreed Contract Value: £${details.amount} (VAT status: [To Confirm unless VAT invoice issued]).
Payment Method: AnyTrader Direct Secure Split Escrow / Direct Card Settlement.

3. INSURANCE, SAFETY & COMPLIANCE
${insuranceClause}
${siteSafetyClause}

4. WARRANTY & CANCELLATION / DISPUTE RESOLUTION
${warrantyClause}
Either party may request amendments in writing through the AnyTrader platform. Disputes are handled via AnyTrader Trust & Compliance Engine.

SIGNED ON BEHALF OF TRADER: ${details.traderName}
SIGNED ON BEHALF OF CLIENT: ${details.clientName}
Generated via AnyTrader Automated Legal Engine.`;
  }

  if (details.documentType === "Liability Waiver") {
    return `WORKSITE LIABILITY WAIVER & ACCESS PERMIT
Ref: ${details.jobRef} | Date: ${todayStr}

PROJECT DETAILS:
- Works: ${details.jobTitle}
- Site Location: ${details.clientAddress || "[To Confirm]"}
- Contractor: ${details.traderName}
- Client Name: ${details.clientName}

1. SITE SAFETY & ACCESS ACKNOWLEDGMENT
${siteSafetyClause}

2. TRADER LIABILITY & INSURANCE
${insuranceClause}

3. INDEMNIFICATION
The Client acknowledges risks associated with active construction/maintenance zones and agrees to follow contractor safety instructions.

ACCEPTED & SIGNED:
Client: ${details.clientName}
Trader: ${details.traderName}
Generated via AnyTrader Automated Legal Engine.`;
  }

  return `JOB COMPLETION & HANDOVER CERTIFICATE
Ref: ${details.jobRef} | Date: ${todayStr}

PROJECT COMPLETION DETAILS:
- Completed Project: ${details.jobTitle}
- Contractor: ${details.traderName}
- Client Name: ${details.clientName}
- Contract Value Paid: £${details.amount}

1. CERTIFICATION OF COMPLETION
The Contractor hereby certifies that all agreed works have been completed in accordance with contract specifications.

2. CLIENT SIGN-OFF & SATISFACTION
${details.completionNotes || "[To Confirm] — Client inspection notes to be recorded prior to final sign-off."}

3. WARRANTY & SUPPORT
${warrantyClause}

4. INSURANCE & SAFETY RECORD
${insuranceClause}

CERTIFIED BY CONTRACTOR: ${details.traderName}
ACCEPTED BY CLIENT: ${details.clientName}
Generated via AnyTrader Automated Legal Engine.`;
}

/**
 * Creates a formatted Google Document in the user's Google Drive.
 * Fails closed if Docs batchUpdate does not confirm non-empty body population (AT-CJ-GDOC-01).
 */
export async function generateLegalContractDoc(
  details: ContractDetails,
  overrideToken?: string
): Promise<{ success: boolean; documentId?: string; documentUrl?: string; error?: string }> {
  try {
    let token = overrideToken || getStoredDocsAccessToken();
    if (!token) {
      token = await requestDriveDocsAccessToken();
    }
    if (!token) return { success: false, error: "Google Drive/Docs authorization required." };

    const textContent = buildContractTextContent(details).trim();
    if (!textContent) {
      return { success: false, error: "Contract content could not be generated (empty body)." };
    }

    const docTitle = `${details.documentType} - ${details.jobTitle} [${details.jobRef}]`;

    // Step 1: Create a blank document using Docs API
    const createRes = await fetch("https://docs.googleapis.com/v1/documents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: docTitle,
      }),
    });

    if (createRes.status === 401) {
      disconnectGoogleDriveDocs();
      const freshToken = await requestDriveDocsAccessToken();
      return generateLegalContractDoc(details, freshToken);
    }

    if (!createRes.ok) {
      const errData = await createRes.json().catch(() => ({}));
      return { success: false, error: errData.error?.message || `Google Docs HTTP ${createRes.status}` };
    }

    const docData = await createRes.json();
    const documentId = docData?.documentId;
    if (!documentId || typeof documentId !== "string") {
      return { success: false, error: "Google Docs did not return a valid documentId." };
    }

    // Step 2: Populate Document via batchUpdate and verify non-empty write confirmation
    const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: textContent,
            },
          },
        ],
      }),
    });

    if (!updateRes.ok) {
      const errData = await updateRes.json().catch(() => ({}));
      return {
        success: false,
        documentId,
        error:
          errData?.error?.message ||
          `Google Docs body population failed (HTTP ${updateRes.status}); refusing to return blank contract.`,
      };
    }

    const updatePayload = await updateRes.json().catch(() => null);
    const hasConfirmedDocument =
      Boolean(updatePayload) &&
      (updatePayload.documentId === documentId ||
        (Array.isArray(updatePayload.replies) && updatePayload.replies.length > 0));

    if (!hasConfirmedDocument) {
      return {
        success: false,
        documentId,
        error: "Google Docs batchUpdate did not confirm document population; refusing to return unverified contract.",
      };
    }

    const documentUrl = `https://docs.google.com/document/d/${documentId}/edit`;

    return {
      success: true,
      documentId,
      documentUrl,
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to generate Google Doc legal contract." };
  }
}
