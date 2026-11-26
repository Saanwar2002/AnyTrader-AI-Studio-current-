import React, { useEffect, useState, useCallback } from "react";
import { db, collection, query, orderBy, limit, onSnapshot } from "@/src/firebase";
import { useAuth } from "../AuthProvider";
import { toast } from "sonner";
import {
  ShieldCheck,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Database,
  History,
  CheckCircle2,
  Loader2,
  Server,
} from "lucide-react";

interface ProductionCheckItem {
  name: string;
  category: "SECURITY" | "FINANCIAL" | "DATABASE" | "CONFIG";
  status: "PASS" | "WARN" | "FAIL";
  message: string;
}

interface ProductionAuditReport {
  timestamp: string;
  environment: string;
  overallStatus: "GO" | "GO_WITH_ACCEPTED_RISKS" | "NO_GO";
  checks: ProductionCheckItem[];
}

interface ConfigVersionItem {
  id: string;
  version: number;
  publishedAt?: string;
  publishedByEmail?: string | null;
  publishedBy?: string;
  commissionCapGbp?: number;
  feeTiersCount?: number;
  businessTiersCount?: number;
  globalSnapshot?: {
    flexiPayMode?: string;
    documentGracePeriodDays?: number;
    provisionalMaxQuotes?: number;
  };
}

export default function AdminSystemToolsTab() {
  const { user } = useAuth();
  const [auditReport, setAuditReport] = useState<ProductionAuditReport | null>(null);
  const [loadingAudit, setLoadingAudit] = useState(true);
  const [syncingKey, setSyncingKey] = useState<string | null>(null);
  const [syncResults, setSyncResults] = useState<Record<string, string>>({});
  const [configVersions, setConfigVersions] = useState<ConfigVersionItem[]>([]);

  const fetchProductionAudit = useCallback(async () => {
    if (!user) return;
    setLoadingAudit(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch("/api/admin/production-audit", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || `Audit request failed (${res.status})`);
      }
      setAuditReport(data);
    } catch (err: any) {
      toast.error(err?.message || "Failed to load live production audit.");
    } finally {
      setLoadingAudit(false);
    }
  }, [user]);

  useEffect(() => {
    fetchProductionAudit();
  }, [fetchProductionAudit]);

  useEffect(() => {
    const q = query(collection(db, "platform_config_versions"), orderBy("version", "desc"), limit(15));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setConfigVersions(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })));
      },
      () => {
        // Silently degrade if no versions have been published yet
      }
    );
    return () => unsub();
  }, []);

  const handleProjectionSync = async (key: string, endpoint: string, label: string) => {
    if (!user || syncingKey) return;
    setSyncingKey(key);
    try {
      const token = await user.getIdToken();
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `${label} failed (${res.status})`);
      }
      const syncedCount = data?.syncedCount ?? data?.synced ?? data?.processed ?? "OK";
      const summary = `Synced (${syncedCount}) at ${new Date().toLocaleTimeString()}`;
      setSyncResults((prev) => ({ ...prev, [key]: summary }));
      toast.success(`${label} completed: ${summary}`);
    } catch (err: any) {
      toast.error(err?.message || `${label} failed.`);
    } finally {
      setSyncingKey(null);
    }
  };

  const statusBadge = (status: "PASS" | "WARN" | "FAIL") => {
    if (status === "PASS") {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[10px] font-black uppercase bg-emerald-100 text-emerald-800 border border-black">
          <CheckCircle2 className="w-3 h-3" /> PASS
        </span>
      );
    }
    if (status === "WARN") {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[10px] font-black uppercase bg-amber-100 text-amber-900 border border-black">
          <AlertTriangle className="w-3 h-3" /> WARN
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[10px] font-black uppercase bg-red-100 text-red-800 border border-black">
        <XCircle className="w-3 h-3" /> FAIL
      </span>
    );
  };

  return (
    <div className="p-5 sm:p-6 space-y-6">
      {/* 1. Live Server Production Pre-Flight Audit */}
      <div className="bg-white border border-black rounded-2xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-black text-black flex items-center gap-2">
              <Server className="w-5 h-5 text-blue-600" />
              Live Server Environment &amp; Pre-Flight Audit
            </h3>
            <p className="text-xs text-black mt-0.5">
              Real-time verification of server secrets, Stripe webhook prefixes, CORS gates, and named Firestore connectivity. Secrets stay strictly server-side in environment variables.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {auditReport && (
              <span
                className={`px-3 py-1 rounded-lg text-xs font-black uppercase border border-black ${
                  auditReport.overallStatus === "GO"
                    ? "bg-emerald-100 text-emerald-900"
                    : auditReport.overallStatus === "GO_WITH_ACCEPTED_RISKS"
                      ? "bg-amber-100 text-amber-900"
                      : "bg-red-100 text-red-900"
                }`}
              >
                {auditReport.overallStatus.replace(/_/g, " ")} ({auditReport.environment})
              </span>
            )}
            <button
              type="button"
              onClick={fetchProductionAudit}
              disabled={loadingAudit}
              className="px-3 py-1.5 bg-slate-900 text-white text-xs font-bold rounded-lg hover:bg-black flex items-center gap-1.5 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingAudit ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>

        {loadingAudit && !auditReport ? (
          <div className="py-8 flex items-center justify-center gap-2 text-sm font-bold text-black">
            <Loader2 className="w-4 h-4 animate-spin" /> Running server pre-flight checks...
          </div>
        ) : auditReport ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {auditReport.checks.map((chk, idx) => (
              <div
                key={`${chk.name}-${idx}`}
                className="p-3.5 rounded-xl border border-black bg-slate-50 flex flex-col gap-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-black text-black">{chk.name}</span>
                  {statusBadge(chk.status)}
                </div>
                <p className="text-xs text-black">{chk.message}</p>
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
                  Category: {chk.category}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-black">Unable to retrieve server audit report.</p>
        )}
      </div>

      {/* 2. 1-Click Public Discovery Projection Resync Tools */}
      <div className="bg-white border border-black rounded-2xl p-5 space-y-4">
        <div>
          <h3 className="text-base font-black text-black flex items-center gap-2">
            <Database className="w-5 h-5 text-indigo-600" />
            Public Discovery Projection Resync Tools
          </h3>
          <p className="text-xs text-black mt-0.5">
            Self-heal public discovery collections from authoritative private source documents if projections ever drift.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              key: "job_cards",
              title: "Sync Public Job Cards",
              desc: "Rebuilds public_job_cards from authoritative jobs documents.",
              endpoint: "/api/admin/sync-public-job-cards",
            },
            {
              key: "ads",
              title: "Sync Public Banner Ads",
              desc: "Rebuilds public_ads from active paid campaigns.",
              endpoint: "/api/admin/sync-public-ads",
            },
            {
              key: "properties",
              title: "Sync Public Properties",
              desc: "Rebuilds public property passport summaries safely without PII.",
              endpoint: "/api/admin/sync-public-properties",
            },
          ].map((tool) => (
            <div key={tool.key} className="p-4 rounded-xl border border-black bg-slate-50 flex flex-col justify-between gap-3">
              <div>
                <h4 className="text-sm font-black text-black">{tool.title}</h4>
                <p className="text-xs text-black mt-1">{tool.desc}</p>
                {syncResults[tool.key] && (
                  <p className="text-[11px] font-bold text-emerald-700 mt-2">{syncResults[tool.key]}</p>
                )}
              </div>
              <button
                type="button"
                disabled={syncingKey !== null}
                onClick={() => handleProjectionSync(tool.key, tool.endpoint, tool.title)}
                className="w-full py-2 px-3 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                {syncingKey === tool.key ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                {syncingKey === tool.key ? "Syncing..." : "Run Resync"}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* 3. Immutable Platform Configuration Version History */}
      <div className="bg-white border border-black rounded-2xl p-5 space-y-4">
        <div>
          <h3 className="text-base font-black text-black flex items-center gap-2">
            <History className="w-5 h-5 text-emerald-700" />
            Platform Config Version History
          </h3>
          <p className="text-xs text-black mt-0.5">
            Immutable audit snapshots created on every atomic publish of platform pricing, grace rules, and FlexiPay launch controls.
          </p>
        </div>

        {configVersions.length === 0 ? (
          <p className="text-xs text-black italic">No published configuration versions recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-black text-[10px] font-black uppercase text-black bg-slate-50">
                  <th className="p-3">Version</th>
                  <th className="p-3">Published At</th>
                  <th className="p-3">Publisher</th>
                  <th className="p-3">Commission Cap</th>
                  <th className="p-3">FlexiPay Mode</th>
                  <th className="p-3">Grace / Quote Cap</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs text-black">
                {configVersions.map((v) => (
                  <tr key={v.id} className="hover:bg-slate-50">
                    <td className="p-3 font-black">v{v.version}</td>
                    <td className="p-3">
                      {v.publishedAt ? new Date(v.publishedAt).toLocaleString() : "—"}
                    </td>
                    <td className="p-3 font-medium">{v.publishedByEmail || v.publishedBy || "Admin"}</td>
                    <td className="p-3 font-bold">£{v.commissionCapGbp ?? 250}</td>
                    <td className="p-3 uppercase font-bold">
                      {v.globalSnapshot?.flexiPayMode || "coming_soon"}
                    </td>
                    <td className="p-3">
                      {v.globalSnapshot?.documentGracePeriodDays ?? 14}d / {v.globalSnapshot?.provisionalMaxQuotes ?? 5} quotes
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
