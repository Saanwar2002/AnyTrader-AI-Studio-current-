export type OnboardingRole =
  | "homeowner"
  | "tradesperson"
  | "business"
  | "fleet_driver"
  | "admin"
  | null;

export type OnboardingBusinessLayer =
  | "properties"
  | "field_services"
  | "consultancy"
  | null;

export interface OnboardingStepProgress {
  currentStep: number;
  totalSteps: number;
  label: string;
  progressPercent: number;
}

/**
 * Computes an accurate, role-aware step counter for the Onboarding wizard so
 * every role sees a truthful step count (e.g. Homeowner 1 of 1, Tradesperson
 * 1 of 2/3, Driver 1 of 2, Business 1 of 3/4).
 */
export function getOnboardingStepProgress(params: {
  step: number;
  role: OnboardingRole;
  businessLayer?: OnboardingBusinessLayer;
  requiresVerification?: boolean;
}): OnboardingStepProgress {
  const { step, role, businessLayer = null, requiresVerification = false } = params;

  if (!role) {
    return {
      currentStep: 1,
      totalSteps: 1,
      label: "Step 1 · Choose Role",
      progressPercent: 100,
    };
  }

  if (role === "homeowner" || role === "admin") {
    const totalSteps = step === 4 ? 2 : 1;
    const currentStep = step === 4 ? 2 : 1;
    return {
      currentStep,
      totalSteps,
      label: `Step ${currentStep} of ${totalSteps}`,
      progressPercent: Math.round((currentStep / totalSteps) * 100),
    };
  }

  if (role === "fleet_driver") {
    const baseSteps = 2; // Step 1 (Details) -> Step 3 (Driver Verification)
    const totalSteps = step === 4 ? baseSteps + 1 : baseSteps;
    const currentStep = step === 4 ? totalSteps : step === 3 ? 2 : 1;
    return {
      currentStep,
      totalSteps,
      label: `Step ${currentStep} of ${totalSteps}`,
      progressPercent: Math.round((currentStep / totalSteps) * 100),
    };
  }

  if (role === "tradesperson") {
    const hasVerificationStep = requiresVerification || step === 3;
    const baseSteps = hasVerificationStep ? 3 : 2; // Step 1 -> Step 2 (Trades) [-> Step 3 (Certs)]
    const totalSteps = step === 4 ? baseSteps + 1 : baseSteps;
    let currentStep = 1;
    if (step === 2) currentStep = 2;
    else if (step === 3) currentStep = 3;
    else if (step === 4) currentStep = totalSteps;
    return {
      currentStep,
      totalSteps,
      label: `Step ${currentStep} of ${totalSteps}`,
      progressPercent: Math.round((currentStep / totalSteps) * 100),
    };
  }

  // role === "business"
  const isPropertyBusiness = businessLayer === "properties";
  const hasVerificationStep = !isPropertyBusiness && (requiresVerification || step === 3);
  const baseSteps = hasVerificationStep ? 4 : 3; // Step 1 -> Step 1.5 (Type) -> Step 2 (Setup/Trades) [-> Step 3 (Certs)]
  const totalSteps = step === 4 ? baseSteps + 1 : baseSteps;
  let currentStep = 1;
  if (step === 1.5) currentStep = 2;
  else if (step === 2) currentStep = 3;
  else if (step === 3) currentStep = 4;
  else if (step === 4) currentStep = totalSteps;

  return {
    currentStep,
    totalSteps,
    label: `Step ${currentStep} of ${totalSteps}`,
    progressPercent: Math.round((currentStep / totalSteps) * 100),
  };
}

/**
 * Computes the deterministic previous step for the Onboarding Back button so
 * Business users always return to Step 1.5 (Business Type) from Step 2, while
 * Tradespeople return to Step 1.
 */
export function getPreviousOnboardingStep(
  step: number,
  role: OnboardingRole
): number {
  if (step === 1.5) return 1;
  if (step === 2) return role === "business" ? 1.5 : 1;
  if (step === 3) return role === "fleet_driver" ? 1 : 2;
  if (step === 4) return 1;
  return 1;
}
