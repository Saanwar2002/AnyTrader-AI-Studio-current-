import React, { useEffect, useState } from "react";
import { db, collection, query, orderBy, limit, onSnapshot } from "@/src/firebase";
import { FileCheck2, Download, Trash2, Shield } from "lucide-react";

export default function AdminGdprRequestsTab() {
  const [requests, setRequests] = useState<any[]>([]);
  const [typeFilter, setTypeFilter] = useState<"all" | "export" | "erasure">("all");

  useEffect(() => {
    let unsubFallback: (() => void) | null = null;
    const q = query(collection(db, "gdpr_requests"), orderBy("createdAt", "desc"), limit(100));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setRequests(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })));
      },
      () => {
        // Fallback without orderBy in case older docs lack createdAt
        if (unsubFallback) return;
        const fallbackQ = query(collection(db, "gdpr_requests"), limit(100));
        unsubFallback = onSnapshot(fallbackQ, (s) => {
          setRequests(s.docs.map((d) => ({ id: d.id, ...(d.data() as any) })));
        });
      }
    );
    return () => {
      unsub();
      if (unsubFallback) unsubFallback();
    };
  }, []);

  const filtered = requests.filter((r) => {
    const t = String(r.type || r.requestType || "").toLowerCase();
    if (typeFilter === "export") return t.includes("export") || t.includes("portability");
    if (typeFilter === "erasure") return t.includes("delete") || t.includes("eras");
    return true;
  });

  const formatTs = (val: any) => {
    if (!val) return "—";
    if (typeof val?.seconds === "number") return new Date(val.seconds * 1000).toLocaleString();
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
  };

  return (
    <div className="p-5 sm:p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-black text-black flex items-center gap-2">
            <Shield className="w-5 h-5 text-blue-600" />
            UK GDPR Compliance Log (Exports &amp; Erasures)
          </h3>
          <p className="text-xs text-black mt-0.5">
            Immutable record of Article 15/20 data portability exports and Article 17 self-service account deletions.
          </p>
        </div>

        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as any)}
          className="px-3 py-1.5 text-xs font-bold text-black bg-white border border-black rounded-lg"
        >
          <option value="all">All Requests ({requests.length})</option>
          <option value="export">Data Exports Only</option>
          <option value="erasure">Account Erasures Only</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="p-10 text-center bg-slate-50 border border-black rounded-2xl">
          <FileCheck2 className="w-8 h-8 text-emerald-600 mx-auto mb-2" />
          <p className="text-sm font-bold text-black">No GDPR requests recorded yet.</p>
        </div>
      ) : (
        <div className="overflow-x-auto bg-white border border-black rounded-2xl">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-black bg-slate-50 text-[10px] font-black uppercase text-black">
                <th className="p-3">Type</th>
                <th className="p-3">User ID</th>
                <th className="p-3">Status</th>
                <th className="p-3">Timestamp</th>
                <th className="p-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs text-black">
              {filtered.map((req) => {
                const typeLabel = String(req.type || req.requestType || "gdpr_request");
                const isErasure = typeLabel.toLowerCase().includes("delete") || typeLabel.toLowerCase().includes("eras");
                return (
                  <tr key={req.id} className="hover:bg-slate-50">
                    <td className="p-3">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-black uppercase border border-black ${
                          isErasure ? "bg-red-100 text-red-900" : "bg-blue-100 text-blue-900"
                        }`}
                      >
                        {isErasure ? <Trash2 className="w-3 h-3" /> : <Download className="w-3 h-3" />}
                        {typeLabel.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="p-3 font-mono">{req.userId || req.uid || "—"}</td>
                    <td className="p-3 font-bold uppercase">{req.status || "completed"}</td>
                    <td className="p-3">{formatTs(req.createdAt || req.completedAt || req.timestamp)}</td>
                    <td className="p-3">
                      {req.reason || req.summary || (req.recordsExported !== undefined ? `${req.recordsExported} records exported` : "Completed")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
