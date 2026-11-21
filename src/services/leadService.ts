import { auth } from "@/src/firebase";

async function getAuthHeaders(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Authentication required for partner attribution.");
  }
  const token = await user.getIdToken();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

/**
 * AT-LEAD-02: Routes partner lead creation through the server-verified campaign
 * attribution endpoint so partnerId, userId, and userRole are derived server-side.
 */
export async function generateLead(
  partnerId: string,
  campaignId: string,
  _userId?: string,
  _userRole?: string,
  data: any = {}
): Promise<boolean> {
  try {
    if (!campaignId) return false;
    const headers = await getAuthHeaders();
    const response = await fetch("/api/partner-leads", {
      method: "POST",
      headers,
      body: JSON.stringify({
        partnerId,
        campaignId,
        data: data && typeof data === "object" ? data : {},
      }),
    });
    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      console.error("Server rejected partner lead attribution:", errBody?.error || response.status);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Error generating server-verified lead:", error);
    return false;
  }
}

/**
 * AT-LEAD-02: Routes campaign click tracking through the authenticated,
 * rate-limited server attribution endpoint.
 */
export async function trackClick(campaignId: string): Promise<boolean> {
  try {
    if (!campaignId) return false;
    const headers = await getAuthHeaders();
    const response = await fetch(`/api/partner-campaigns/${encodeURIComponent(campaignId)}/click`, {
      method: "POST",
      headers,
    });
    return response.ok;
  } catch (error) {
    console.error("Error tracking campaign click:", error);
    return false;
  }
}
