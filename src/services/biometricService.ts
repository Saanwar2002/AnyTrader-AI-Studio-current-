export interface BiometricStatus {
  available: boolean;
  type: "face" | "fingerprint" | "none" | "biometric";
}

export interface BiometricCredentials {
  email: string;
  enrolledAt: number;
}

const ENABLE_KEY = "anytrader_biometrics_enabled";
const CRED_KEY = "anytrader_biometric_credentials";
const SKIP_KEY = "anytrader_biometric_prompt_skipped";

export const BiometricService = {
  /**
   * Checks if browser WebAuthn / biometric support is available.
   */
  async checkAvailability(): Promise<BiometricStatus> {
    const hasWebAuthn = typeof window !== "undefined" && !!window.PublicKeyCredential;
    return {
      available: hasWebAuthn,
      type: hasWebAuthn ? "fingerprint" : "none",
    };
  },

  /**
   * Web biometric helper (returns true so components can display the web confirmation flow).
   */
  async authenticate(_reason: string = "Authenticate to access your AnyTrader account"): Promise<boolean> {
    return true;
  },

  isEnabled(): boolean {
    return localStorage.getItem(ENABLE_KEY) === "true";
  },

  isPromptSkipped(): boolean {
    return localStorage.getItem(SKIP_KEY) === "true";
  },

  setPromptSkipped(skipped: boolean): void {
    if (skipped) {
      localStorage.setItem(SKIP_KEY, "true");
    } else {
      localStorage.removeItem(SKIP_KEY);
    }
  },

  async enroll(email: string): Promise<boolean> {
    try {
      localStorage.setItem(ENABLE_KEY, "true");
      localStorage.removeItem(CRED_KEY);

      const payload: BiometricCredentials = {
        email: email.trim().toLowerCase(),
        enrolledAt: Date.now(),
      };
      localStorage.setItem(CRED_KEY, JSON.stringify(payload));
      return true;
    } catch (err) {
      console.error("[BiometricService] Enrollment failed:", err);
      return false;
    }
  },

  disable(): void {
    localStorage.removeItem(ENABLE_KEY);
    localStorage.removeItem(CRED_KEY);
  },

  getCredentials(): BiometricCredentials | null {
    if (!this.isEnabled()) return null;

    const stored = localStorage.getItem(CRED_KEY);
    if (!stored) return null;

    try {
      if (!stored.startsWith("{")) {
        localStorage.removeItem(CRED_KEY);
        return null;
      }
      return JSON.parse(stored) as BiometricCredentials;
    } catch (err) {
      console.error("[BiometricService] Read credentials failed:", err);
      return null;
    }
  },
};
