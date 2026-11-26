import React, { useMemo, useState } from "react";
import { useAuth } from "../AuthProvider";
import { toast } from "sonner";
import { Star, EyeOff, RotateCcw, Trash2, Search, ShieldCheck, Loader2 } from "lucide-react";

interface AdminReviewsModerationTabProps {
  reviews: any[];
  users: any[];
}

export default function AdminReviewsModerationTab({ reviews, users }: AdminReviewsModerationTabProps) {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "published" | "hidden" | "low">("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<any | null>(null);

  const userNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const u of users) {
      map[u.id] = u.businessName || u.name || u.email || u.id;
    }
    return map;
  }, [users]);

  const filteredReviews = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reviews.filter((r) => {
      const isHidden = r.isHidden === true || String(r.status || "").toLowerCase() === "hidden";
      if (statusFilter === "published" && isHidden) return false;
      if (statusFilter === "hidden" && !isHidden) return false;
      if (statusFilter === "low" && Number(r.rating || 5) > 2) return false;

      if (!q) return true;
      const targetName = (userNameMap[r.targetId || r.tradespersonId] || "").toLowerCase();
      const authorName = (r.reviewerName || userNameMap[r.reviewerId || r.authorId] || "").toLowerCase();
      const comment = String(r.comment || r.text || "").toLowerCase();
      return targetName.includes(q) || authorName.includes(q) || comment.includes(q) || String(r.id).toLowerCase().includes(q);
    });
  }, [reviews, search, statusFilter, userNameMap]);

  const handleModerate = async (reviewId: string, action: "hide" | "restore" | "delete") => {
    if (!user || busyId) return;
    setBusyId(reviewId);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/admin/reviews/${encodeURIComponent(reviewId)}/moderate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Review moderation failed (${res.status})`);
      }
      toast.success(
        `Review ${action === "delete" ? "deleted" : action === "hide" ? "hidden" : "restored"} — updated profile rating: ${data.recalculatedRating ?? 0}★ (${data.recalculatedTotalReviews ?? 0} reviews).`
      );
    } catch (err: any) {
      toast.error(err?.message || "Failed to moderate review.");
    } finally {
      setBusyId(null);
      setPendingDelete(null);
    }
  };

  const formatDate = (val: any) => {
    if (!val) return "—";
    if (typeof val?.seconds === "number") return new Date(val.seconds * 1000).toLocaleDateString();
    const parsed = new Date(val);
    return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString();
  };

  return (
    <div className="p-5 sm:p-6 space-y-5">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-black text-black flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-blue-600" />
            Reviews Moderation &amp; Rating Integrity
          </h3>
          <p className="text-xs text-black mt-0.5">
            Hide, restore, or permanently remove abusive reviews. Trader ratings on both private and public profiles automatically recalculate server-side.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-black absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search trader, author, or text..."
              className="pl-8 pr-3 py-1.5 text-xs text-black bg-white border border-black rounded-lg outline-none focus:ring-2 focus:ring-blue-600 w-56"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="px-3 py-1.5 text-xs font-bold text-black bg-white border border-black rounded-lg"
          >
            <option value="all">All Reviews ({reviews.length})</option>
            <option value="published">Published Only</option>
            <option value="hidden">Hidden Only</option>
            <option value="low">Low Rating (1–2★)</option>
          </select>
        </div>
      </div>

      {filteredReviews.length === 0 ? (
        <div className="p-10 text-center bg-slate-50 border border-black rounded-2xl">
          <p className="text-sm font-bold text-black">No reviews match the current filter.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredReviews.map((r) => {
            const isHidden = r.isHidden === true || String(r.status || "").toLowerCase() === "hidden";
            const targetId = r.targetId || r.tradespersonId || "";
            const isBusy = busyId === r.id;
            return (
              <div
                key={r.id}
                className={`p-4 rounded-xl border border-black flex flex-col sm:flex-row sm:items-start justify-between gap-4 ${
                  isHidden ? "bg-amber-50/70" : "bg-white"
                }`}
              >
                <div className="space-y-1.5 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-slate-900 text-white text-xs font-black">
                      <Star className="w-3 h-3 fill-amber-400 text-amber-400" /> {r.rating ?? "—"}
                    </span>
                    <span className="text-xs font-black text-black">
                      For: {userNameMap[targetId] || targetId || "Unknown"}
                    </span>
                    <span className="text-xs text-slate-600">
                      By: {r.reviewerName || userNameMap[r.reviewerId] || "Customer"}
                    </span>
                    <span className="text-[11px] text-slate-600">• {formatDate(r.createdAt)}</span>
                    {isHidden && (
                      <span className="px-2 py-0.5 rounded-md bg-amber-200 text-black text-[10px] font-black uppercase border border-black">
                        Hidden
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-black">{r.comment || r.text || "(No written comment)"}</p>
                  {r.jobId && <p className="text-[11px] font-mono text-slate-600">Job ID: {r.jobId}</p>}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {isHidden ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleModerate(r.id, "restore")}
                      className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg flex items-center gap-1 disabled:opacity-50"
                    >
                      {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                      Restore
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleModerate(r.id, "hide")}
                      className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-black border border-black text-xs font-bold rounded-lg flex items-center gap-1 disabled:opacity-50"
                    >
                      {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <EyeOff className="w-3.5 h-3.5" />}
                      Hide
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => setPendingDelete(r)}
                    className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-lg flex items-center gap-1 disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pendingDelete && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white border border-black rounded-xl max-w-sm w-full p-5 space-y-4">
            <h4 className="text-base font-black text-black">Delete Review Permanently?</h4>
            <p className="text-sm text-black">
              This will permanently remove the review and immediately recalculate the trader&apos;s average rating.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="px-4 py-2 text-xs font-bold text-black bg-slate-100 border border-black rounded-lg hover:bg-slate-200"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => handleModerate(pendingDelete.id, "delete")}
                className="px-4 py-2 text-xs font-bold text-white bg-red-600 rounded-lg hover:bg-red-700"
              >
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
