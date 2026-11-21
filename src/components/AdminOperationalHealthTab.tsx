import React, { useEffect, useState, useCallback } from "react";
import { useAuth } from "./AuthProvider";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Flag,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Clock,
  Layers,
  Plus,
} from "lucide-react";

interface OperationalHealthData {
  generatedAt: string;
  overallSeverity: "healthy" | "degraded" | "critical";
  failedWebhooks: {
    count: number;
    items: Array<{ id: string; eventType?: string; error?: string; failedAt?: any }>;
  };
  stuckPayoutLeases: {
    count: number;
    items: Array<{ rideId: string; driverId?: string; lockedAtMs: number; ageMs: number }>;
  };
  queueBacklogs: {
    smsPending: number;
    smsUnconfigured: number;
    outreachQueued: number;
    outreachSkippedNoProvider: number;
    broadcastPartialFailures: number;
    intelligencePending: number;
    intelligenceFailed: number;
  };
  killSwitches: {
    maintenanceMode: boolean;
    paywallEnabled: boolean;
    autoDispatchEnabled: boolean;
    surgeEnabled: boolean;
  };
  activeCronLocks: Array<{
    jobName: string;
    status: string;
    instanceId?: string;
    leaseExpiresAtMs?: number;
    isStale: boolean;
  }>;
  pendingApprovalsCount: number;
  incidents: Array<{
    id: string;
    severity: "warning" | "critical";
    category: string;
    title: string;
    detail: string;
  }>;
}

interface FeatureFlagItem {
  flagKey: string;
  version: number;
  enabled: boolean;
  description: string;
  environments: {
    development: boolean;
    staging: boolean;
    production: boolean;
  };
  rolloutPercentage: number;
  updatedByEmail: string;
  updatedAt: string;
  reason: string;
}

interface DualControlApprovalItem {
  id: string;
  actionType: string;
  status: string;
  requestedByUid: string;
  requestedByEmail: string;
  reason: string;
  amountGbp?: number | null;
  expiresAt?: string;
}

export default function AdminOperationalHealthTab() {
  const { user } = useAuth();
  const [health, setHealth] = useState<OperationalHealthData | null>(null);
  const [flags, setFlags] = useState<FeatureFlagItem[]>([]);
  const [approvals, setApprovals] = useState<DualControlApprovalItem[]>([]);
  const [adminTier, setAdminTier] = useState<string>("support_readonly");
  const [loading, setLoading] = useState(true);
  const [savingFlag, setSavingFlag] = useState(false);

  // New / Edit feature flag form
  const [newFlagKey, setNewFlagKey] = useState("");
  const [newFlagDescription, setNewFlagDescription] = useState("");
  const [newFlagReason, setNewFlagReason] = useState("");
  const [newFlagEnabled, setNewFlagEnabled] = useState(true);
  const [newFlagEnvs, setNewFlagEnvs] = useState({
    development: true,
    staging: true,
    production: false,
  });

  const loadAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const headers = { Authorization: `Bearer ${token}` };
      const [healthRes, flagsRes, approvalsRes] = await Promise.all([
        fetch("/api/admin/operational-health", { headers }),
        fetch("/api/admin/feature-flags", { headers }),
        fetch("/api/admin/approvals", { headers }),
      ]);

      if (healthRes.ok) {
        const data = await healthRes.json();
        setHealth(data.health || null);
      }
      if (flagsRes.ok) {
        const data = await flagsRes.json();
        setFlags(Array.isArray(data.flags) ? data.flags : []);
      }
      if (approvalsRes.ok) {
        const data = await approvalsRes.json();
        setApprovals(Array.isArray(data.approvals) ? data.approvals : []);
        if (data.currentAdminTier) setAdminTier(data.currentAdminTier);
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to load operational health data");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleSaveFlag = async (
    flagKey: string,
    payload: {
      enabled: boolean;
      description?: string;
      environments?: { development: boolean; staging: boolean; production: boolean };
      reason?: string;
    }
  ) => {
    if (!user) return;
    setSavingFlag(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/admin/feature-flags/${encodeURIComponent(flagKey)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to update feature flag");
      }
      toast.success(`Feature flag '${flagKey}' saved (v${data.flag?.version || 1})`);
      setNewFlagKey("");
      setNewFlagDescription("");
      setNewFlagReason("");
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || "Could not update feature flag");
    } finally {
      setSavingFlag(false);
    }
  };

  const handleReviewApproval = async (requestId: string, decision: "approved" | "rejected") => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/admin/approvals/${encodeURIComponent(requestId)}/review`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ decision, reviewNote: `Reviewed in Ops Health console (${decision})` }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Approval review failed");
      }
      toast.success(`Dual-control request ${decision}`);
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || "Approval review failed");
    }
  };

  return (
    <div className="space-y-6 text-black">
      {/* Header Bar */}
      <div className="bg-white rounded-xl border border-black p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-black" />
            <h2 className="text-lg font-black text-black">
              Operational Health, Incidents & Versioned Feature Flags
            </h2>
          </div>
          <p className="text-xs text-black/70 mt-1">
            Admin Capability Tier:{" "}
            <span className="font-bold uppercase">{adminTier}</span>
            {health?.generatedAt ? ` · Last refreshed ${new Date(health.generatedAt).toLocaleTimeString()}` : ""}
          </p>
        </div>
        <button
          onClick={loadAll}
          disabled={loading}
          className="px-4 py-2 bg-white hover:bg-slate-100 text-black font-bold text-xs rounded-xl border border-black flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh Snapshot
        </button>
      </div>

      {/* Incident Summary Grid */}
      {health && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl border border-black p-4">
            <p className="text-xs font-bold uppercase text-black/70">Overall Status</p>
            <div className="mt-2 flex items-center gap-2">
              {health.overallSeverity === "healthy" ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-700" />
              ) : (
                <ShieldAlert className="w-5 h-5 text-red-700" />
              )}
              <span className="text-xl font-black uppercase text-black">{health.overallSeverity}</span>
            </div>
            <p className="text-xs text-black/70 mt-1">{health.incidents.length} active incident(s)</p>
          </div>

          <div className="bg-white rounded-xl border border-black p-4">
            <p className="text-xs font-bold uppercase text-black/70">Failed Stripe Webhooks</p>
            <p className="text-2xl font-black text-black mt-1">{health.failedWebhooks.count}</p>
            <p className="text-xs text-black/70 mt-1">Requires replay or reconciliation</p>
          </div>

          <div className="bg-white rounded-xl border border-black p-4">
            <p className="text-xs font-bold uppercase text-black/70">Stuck Payout Leases</p>
            <p className="text-2xl font-black text-black mt-1">{health.stuckPayoutLeases.count}</p>
            <p className="text-xs text-black/70 mt-1">Exceeded 5-minute lease window</p>
          </div>

          <div className="bg-white rounded-xl border border-black p-4">
            <p className="text-xs font-bold uppercase text-black/70">Pending Dual-Control Approvals</p>
            <p className="text-2xl font-black text-black mt-1">{health.pendingApprovalsCount}</p>
            <p className="text-xs text-black/70 mt-1">Four-eyes sign-off queue</p>
          </div>
        </div>
      )}

      {/* Active Incidents & Kill-Switch / Queue State */}
      {health && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-white rounded-xl border border-black p-5 space-y-3">
            <h3 className="text-sm font-black uppercase text-black flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              Active Incidents
            </h3>
            {health.incidents.length === 0 ? (
              <p className="text-xs text-black/70">No active operational incidents detected.</p>
            ) : (
              <div className="space-y-2">
                {health.incidents.map((inc) => (
                  <div key={inc.id} className="p-3 rounded-lg border border-black bg-slate-50">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-black text-black">{inc.title}</span>
                      <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-black bg-white text-black">
                        {inc.severity}
                      </span>
                    </div>
                    <p className="text-xs text-black/80 mt-1">{inc.detail}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white rounded-xl border border-black p-5 space-y-3">
            <h3 className="text-sm font-black uppercase text-black flex items-center gap-2">
              <Layers className="w-4 h-4" />
              Kill-Switches & Queue Backlogs
            </h3>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-2.5 rounded-lg border border-black bg-slate-50">
                <span className="font-bold">Maintenance Mode:</span>{" "}
                {health.killSwitches.maintenanceMode ? "ACTIVE" : "OFF"}
              </div>
              <div className="p-2.5 rounded-lg border border-black bg-slate-50">
                <span className="font-bold">Paywall:</span>{" "}
                {health.killSwitches.paywallEnabled ? "ON" : "OFF"}
              </div>
              <div className="p-2.5 rounded-lg border border-black bg-slate-50">
                <span className="font-bold">SMS Pending / Blocked:</span>{" "}
                {health.queueBacklogs.smsPending} / {health.queueBacklogs.smsUnconfigured}
              </div>
              <div className="p-2.5 rounded-lg border border-black bg-slate-50">
                <span className="font-bold">Outreach Queued / No-Provider:</span>{" "}
                {health.queueBacklogs.outreachQueued} / {health.queueBacklogs.outreachSkippedNoProvider}
              </div>
              <div className="p-2.5 rounded-lg border border-black bg-slate-50">
                <span className="font-bold">Intelligence Pending / Failed:</span>{" "}
                {health.queueBacklogs.intelligencePending} / {health.queueBacklogs.intelligenceFailed}
              </div>
              <div className="p-2.5 rounded-lg border border-black bg-slate-50">
                <span className="font-bold">Broadcast Partial Failures:</span>{" "}
                {health.queueBacklogs.broadcastPartialFailures}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Dual-Control Approval Queue */}
      <div className="bg-white rounded-xl border border-black p-5 space-y-3">
        <h3 className="text-sm font-black uppercase text-black flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" />
          Dual-Control Approval Queue (Four-Eyes Policy)
        </h3>
        {approvals.length === 0 ? (
          <p className="text-xs text-black/70">No dual-control approval requests recorded.</p>
        ) : (
          <div className="space-y-2">
            {approvals.map((reqItem) => (
              <div
                key={reqItem.id}
                className="p-3 rounded-lg border border-black bg-slate-50 flex flex-wrap items-center justify-between gap-3"
              >
                <div className="space-y-0.5">
                  <p className="text-xs font-black text-black">
                    {reqItem.actionType} ·{" "}
                    <span className="uppercase">{reqItem.status}</span>
                  </p>
                  <p className="text-xs text-black/80">
                    Requested by {reqItem.requestedByEmail || reqItem.requestedByUid} — {reqItem.reason}
                  </p>
                </div>
                {reqItem.status === "pending_second_approval" && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleReviewApproval(reqItem.id, "approved")}
                      className="px-3 py-1.5 bg-emerald-600 text-white text-xs font-bold rounded-lg border border-black"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleReviewApproval(reqItem.id, "rejected")}
                      className="px-3 py-1.5 bg-white text-black text-xs font-bold rounded-lg border border-black"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Versioned Feature Flags Control Plane */}
      <div className="bg-white rounded-xl border border-black p-5 space-y-4">
        <h3 className="text-sm font-black uppercase text-black flex items-center gap-2">
          <Flag className="w-4 h-4" />
          Versioned Platform Feature Flags
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 p-3 rounded-lg border border-black bg-slate-50">
          <input
            type="text"
            value={newFlagKey}
            onChange={(e) => setNewFlagKey(e.target.value)}
            placeholder="flag_key (e.g. instant_dispatch_v2)"
            className="px-3 py-2 text-xs bg-white text-black rounded-lg border border-black"
          />
          <input
            type="text"
            value={newFlagDescription}
            onChange={(e) => setNewFlagDescription(e.target.value)}
            placeholder="Description"
            className="px-3 py-2 text-xs bg-white text-black rounded-lg border border-black"
          />
          <input
            type="text"
            value={newFlagReason}
            onChange={(e) => setNewFlagReason(e.target.value)}
            placeholder="Audit reason"
            className="px-3 py-2 text-xs bg-white text-black rounded-lg border border-black"
          />
          <button
            disabled={savingFlag || !newFlagKey.trim()}
            onClick={() =>
              handleSaveFlag(newFlagKey.trim(), {
                enabled: newFlagEnabled,
                description: newFlagDescription,
                environments: newFlagEnvs,
                reason: newFlagReason || "Created via Ops Health console",
              })
            }
            className="px-3 py-2 bg-black text-white text-xs font-bold rounded-lg border border-black flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            Save Versioned Flag
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs">
          <label className="flex items-center gap-1.5 font-bold">
            <input
              type="checkbox"
              checked={newFlagEnabled}
              onChange={(e) => setNewFlagEnabled(e.target.checked)}
            />
            Global Enabled
          </label>
          {(["development", "staging", "production"] as const).map((envKey) => (
            <label key={envKey} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={newFlagEnvs[envKey]}
                onChange={(e) =>
                  setNewFlagEnvs((prev) => ({ ...prev, [envKey]: e.target.checked }))
                }
              />
              {envKey}
            </label>
          ))}
        </div>

        {flags.length === 0 ? (
          <p className="text-xs text-black/70">No versioned feature flags configured yet.</p>
        ) : (
          <div className="space-y-2">
            {flags.map((flag) => (
              <div
                key={flag.flagKey}
                className="p-3 rounded-lg border border-black bg-slate-50 flex flex-wrap items-center justify-between gap-3"
              >
                <div>
                  <p className="text-xs font-black text-black">
                    {flag.flagKey} <span className="font-bold">v{flag.version}</span>
                  </p>
                  <p className="text-xs text-black/70">{flag.description || "No description"}</p>
                  <p className="text-[11px] text-black/70 mt-0.5 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    dev:{flag.environments?.development ? "ON" : "OFF"} · stg:
                    {flag.environments?.staging ? "ON" : "OFF"} · prod:
                    {flag.environments?.production ? "ON" : "OFF"}
                  </p>
                </div>
                <button
                  disabled={savingFlag}
                  onClick={() =>
                    handleSaveFlag(flag.flagKey, {
                      enabled: !flag.enabled,
                      description: flag.description,
                      environments: flag.environments,
                      reason: `Toggled enabled to ${!flag.enabled}`,
                    })
                  }
                  className="px-3 py-1.5 bg-white text-black text-xs font-bold rounded-lg border border-black"
                >
                  {flag.enabled ? "Disable" : "Enable"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
