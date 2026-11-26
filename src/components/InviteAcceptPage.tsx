import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ShieldCheck, Users, CheckCircle2, AlertTriangle, Loader2, ArrowRight } from "lucide-react";
import { useAuth } from "./AuthProvider";
import { savePendingLoginRedirect } from "@/src/lib/authRedirect";

interface InviteAcceptPageProps {
  kind: "admin" | "business_team";
}

export default function InviteAcceptPage({ kind }: InviteAcceptPageProps) {
  const { user, isAuthReady } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const invitationId = (searchParams.get("id") || "").trim();
  const token = (searchParams.get("token") || "").trim();

  const [status, setStatus] = useState<"idle" | "verifying" | "success" | "error">("idle");
  const [message, setMessage] = useState<string>("");
  const [destination, setDestination] = useState<string>(kind === "admin" ? "/admin" : "/dashboard");

  useEffect(() => {
    if (!isAuthReady) return;

    if (!invitationId || !token) {
      setStatus("error");
      setMessage("This invitation link is incomplete or missing its verification token.");
      return;
    }

    if (!user) {
      const targetPath = `${kind === "admin" ? "/admin-invite" : "/team-invite"}?id=${encodeURIComponent(
        invitationId
      )}&token=${encodeURIComponent(token)}`;
      savePendingLoginRedirect(targetPath);
      return;
    }

    let cancelled = false;

    const accept = async () => {
      setStatus("verifying");
      setMessage("");
      try {
        const idToken = await user.getIdToken();
        const endpoint =
          kind === "admin"
            ? `/api/admin/invitations/${encodeURIComponent(invitationId)}/accept`
            : `/api/business/team/invitations/${encodeURIComponent(invitationId)}/accept`;

        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ token }),
        });

        const data = await res.json().catch(() => ({} as any));
        if (!res.ok) {
          throw new Error(data?.error || "Invitation could not be verified or has expired.");
        }

        // Refresh ID token claims so newly granted admin permissions take effect immediately
        await user.getIdToken(true).catch(() => {});

        if (cancelled) return;
        const nextDest = kind === "admin" ? "/admin" : "/dashboard";
        setDestination(nextDest);
        setStatus("success");
        setMessage(
          kind === "admin"
            ? "Your Admin Staff invitation has been accepted and your permissions are now active."
            : `You have joined ${data?.businessName || "the business team"} on AnyTrader.`
        );
      } catch (err: any) {
        if (cancelled) return;
        setStatus("error");
        setMessage(err?.message || "Unable to accept this invitation right now.");
      }
    };

    void accept();

    return () => {
      cancelled = true;
    };
  }, [isAuthReady, user, invitationId, token, kind]);

  const title = kind === "admin" ? "AnyTrader Admin Staff Invitation" : "AnyTrader Business Team Invitation";

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white border border-black rounded-2xl p-6 sm:p-8 shadow-xl space-y-6 text-center">
        <div className="w-14 h-14 mx-auto rounded-2xl bg-slate-900 text-white border border-black flex items-center justify-center">
          {kind === "admin" ? <ShieldCheck className="w-7 h-7" /> : <Users className="w-7 h-7" />}
        </div>

        <div className="space-y-1.5">
          <h1 className="text-xl font-black text-black">{title}</h1>
          {!user && isAuthReady && invitationId && token && (
            <p className="text-sm font-medium text-black">
              Sign in with your invited email account to verify and accept this invitation.
            </p>
          )}
        </div>

        {!user && isAuthReady && invitationId && token && (
          <button
            type="button"
            onClick={() => {
              const targetPath = `${kind === "admin" ? "/admin-invite" : "/team-invite"}?id=${encodeURIComponent(
                invitationId
              )}&token=${encodeURIComponent(token)}`;
              savePendingLoginRedirect(targetPath);
              navigate(`/login?redirect=${encodeURIComponent(targetPath)}`);
            }}
            className="w-full py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white border border-black font-black text-sm flex items-center justify-center gap-2 cursor-pointer"
          >
            <span>Sign In to Accept Invitation</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        )}

        {status === "verifying" && (
          <div className="py-4 flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
            <p className="text-sm font-bold text-black">Verifying your invitation token...</p>
          </div>
        )}

        {status === "success" && (
          <div className="space-y-4">
            <div className="p-4 rounded-xl bg-emerald-50 border border-black text-left flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
              <p className="text-xs font-bold text-black leading-relaxed">{message}</p>
            </div>
            <button
              type="button"
              onClick={() => navigate(destination, { replace: true })}
              className="w-full py-3 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-white border border-black font-black text-sm flex items-center justify-center gap-2 cursor-pointer"
            >
              <span>{kind === "admin" ? "Open Admin Portal" : "Go to Dashboard"}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {status === "error" && (
          <div className="space-y-4">
            <div className="p-4 rounded-xl bg-red-50 border border-black text-left flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />
              <p className="text-xs font-bold text-black leading-relaxed">{message}</p>
            </div>
            <button
              type="button"
              onClick={() => navigate("/", { replace: true })}
              className="w-full py-3 px-4 rounded-xl bg-white hover:bg-slate-100 text-black border border-black font-black text-sm cursor-pointer"
            >
              Return Home
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
