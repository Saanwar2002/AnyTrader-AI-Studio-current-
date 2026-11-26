import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Sparkles, UserCircle, Star, Calendar, MessageSquare, CheckCircle } from "lucide-react";
import { db, collection, query, limit, getDocs, addDoc, serverTimestamp, sendNotification } from "@/src/firebase";
import { getProMatches } from "@/src/services/gemini";
import { useAuth } from "../AuthProvider";
import { toast } from "sonner";
import { isProfileAcceptingNewWork } from "@/src/lib/marketplaceContracts";
import {
  extractTraderCategories,
  extractTraderRating,
  extractTraderReviewCount,
  isTraderCalendarAvailableForDate,
  scoreTraderForJob,
} from "@/src/lib/unifiedJobMatching";

export function ProMatchmakerModal({ role, projectId, onClose }: { role: any, projectId: string, onClose: () => void }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [matches, setMatches] = useState<any[]>([]);

  useEffect(() => {
    async function findMatches() {
      try {
        setLoading(true);
        // Step 1: Bounded fetch of non-PII candidate professionals from public_profiles
        const profilesQuery = query(collection(db, "public_profiles"), limit(100));
        const snapshot = await getDocs(profilesQuery);

        const syntheticRoleJob = {
          category: role?.category || role?.roleName || "",
          title: role?.roleName || "",
          description: role?.description || role?.notes || "",
          postcode: role?.postcode || role?.postcodeArea || "",
          city: role?.city || role?.location || "",
          preferredDate: role?.requiredDate || null,
        };

        let candidatePros = snapshot.docs
          .map((docSnap) => ({
            id: docSnap.id,
            ...docSnap.data(),
          }))
          .filter((p: any) => {
            if (!p.businessName && !p.fullName && !p.name) return false;
            if (p.isSuspended || p.isDisabled) return false;
            if (p.role === "business" && String(p.businessLayer || "").toLowerCase() === "properties") return false;
            if (!isProfileAcceptingNewWork(p)) return false;
            // Check each candidate pro's own schedule/dateOverrides rather than the caller's calendar
            if (role?.requiredDate && !isTraderCalendarAvailableForDate(p, role.requiredDate)) {
              return false;
            }
            return true;
          })
          .map((p: any) => {
            const unified = scoreTraderForJob(p, syntheticRoleJob, { mode: "relaxed" });
            return {
              ...p,
              unifiedScore: unified.compositeScore,
              unifiedHighlights: unified.keyHighlights,
              distanceMiles: unified.distanceMiles,
            };
          })
          .sort((a: any, b: any) => b.unifiedScore - a.unifiedScore)
          .slice(0, 20);

        if (candidatePros.length === 0) {
          setMatches([]);
          setLoading(false);
          return;
        }

        // Prepare honest, bounded top-20 context for Gemini (no inflated 4.5 default rating!)
        const candidatesContext = candidatePros.map((p: any) => ({
          id: p.id,
          name: p.businessName || p.fullName || p.name,
          category: extractTraderCategories(p)[0] || p.businessCategory || p.category || "General",
          rating: extractTraderRating(p),
          reviewsCount: extractTraderReviewCount(p),
          unifiedMatchScore: p.unifiedScore,
          distanceMiles: p.distanceMiles,
          location: p.city || p.postcodeArea || p.location || "Local Area",
        }));

        // Step 2: Use Gemini to refine top matches based on the required role, with deterministic fallback
        let enrichedMatches: any[] = [];
        try {
          const aiMatches = await getProMatches(role, candidatesContext);
          enrichedMatches = (aiMatches || [])
            .map((m: any) => {
              const proObj = candidatePros.find((p: any) => p.id === m.id);
              if (!proObj) return null;
              return {
                ...proObj,
                matchScore: Number.isFinite(Number(m.matchScore)) ? Number(m.matchScore) : proObj.unifiedScore,
                reason: m.reason || proObj.unifiedHighlights?.join(" • ") || "Matched via unified skills & availability",
              };
            })
            .filter(Boolean)
            .sort((a: any, b: any) => b.matchScore - a.matchScore);
        } catch {
          enrichedMatches = candidatePros.slice(0, 6).map((p: any) => ({
            ...p,
            matchScore: p.unifiedScore,
            reason: p.unifiedHighlights?.join(" • ") || "Matched via unified skills & availability",
          }));
        }

        setMatches(enrichedMatches);
      } catch (err) {
        console.error("Matchmaker Error:", err);
      } finally {
        setLoading(false);
      }
    }

    findMatches();
  }, [role, user]);

  const handleShortlist = async (matchId: string) => {
    if (!user) return;
    try {
      await addDoc(collection(db, "projectShortlists"), {
        projectId,
        managerId: user.uid,
        roleId: role.id,
        consultantId: matchId,
        createdAt: serverTimestamp()
      });
      toast.success("Pro added to project shortlist!");
    } catch (err) {
      console.error(err);
      toast.error("Failed to shortlist.");
    }
  };

  const handleBroadcast = async (matchId: string) => {
    if (!user) return;
    try {
      await addDoc(collection(db, "projectBids"), {
        projectId: projectId,
        managerId: user.uid,
        projectRoleId: role.id,
        consultantId: matchId,
        amount: role.estimatedBudget, // Initial budget offer
        message: "You have been invited to bid for this role.",
        status: "pending",
        createdAt: serverTimestamp()
      });

      await sendNotification(
        matchId,
        "New Project Invitation",
        `You've been invited to bid on the role: ${role.roleName}`,
        "system",
        undefined,
        { projectId }
      );

      toast.success("Invitation to bid sent successfully!");
    } catch (err) {
      console.error(err);
      toast.error("Failed to send invitation.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        className="w-full max-w-2xl bg-white rounded-3xl shadow-2xl border border-black/10 overflow-hidden flex flex-col max-h-[85vh]"
      >
        <div className="p-6 border-b border-black/10 flex items-center justify-between bg-indigo-50/50">
          <div>
            <h2 className="text-xl font-black text-black flex items-center gap-2">
              <Sparkles className="w-6 h-6 text-indigo-600" />
              AI Matchmaker
            </h2>
            <p className="text-sm text-black/60 mt-1 font-medium">Finding Pros for: <span className="font-bold text-black">{role.roleName}</span> (Budget: £{role.estimatedBudget})</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-black/5 rounded-full transition-colors">
            <X className="w-5 h-5 text-black" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 bg-slate-50">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 space-y-4">
              <div className="relative">
                <div className="w-16 h-16 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
                <Sparkles className="w-6 h-6 text-indigo-600 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pulse" />
              </div>
              <div className="text-center">
                <p className="text-sm font-bold text-black">Scanning the Network...</p>
                <p className="text-xs text-black/60">Analyzing skills, availability, and budgets</p>
              </div>
            </div>
          ) : matches.length > 0 ? (
            <div className="space-y-4">
              {matches.map((m, idx) => (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.1 }}
                  key={m.id} 
                  className="bg-white p-5 rounded-2xl border border-black/10 shadow-sm"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex gap-4">
                      {m.profileImage ? (
                        <img src={m.profileImage} alt={m.businessName} className="w-12 h-12 rounded-full object-cover border border-black/10" />
                      ) : (
                        <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center border border-black/10">
                          <UserCircle className="w-8 h-8 text-slate-400" />
                        </div>
                      )}
                      
                      <div>
                        <h3 className="font-bold text-black text-lg leading-tight">{m.businessName || m.fullName}</h3>
                        <p className="text-xs text-indigo-600 font-black uppercase tracking-wider">{m.businessCategory || 'Professional'}</p>
                        
                        <div className="flex items-center gap-3 mt-2 text-xs text-black/60 font-medium">
                          <span className="flex items-center gap-1">
                            <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
                            {m.averageRating ? m.averageRating.toFixed(1) : "New"}
                          </span>
                          <span className="flex items-center gap-1">
                            <Calendar className="w-3.5 h-3.5 text-emerald-600" />
                            Available
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col items-end">
                      <div className="bg-indigo-50 text-indigo-700 px-3 py-1 rounded-full text-xs font-black flex items-center gap-1">
                        <Sparkles className="w-3.5 h-3.5" />
                        {m.matchScore}% Match
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 p-3 bg-slate-50 rounded-xl text-sm text-black/70 italic border border-black/5">
                    " {m.reason} "
                  </div>

                  <div className="mt-4 flex gap-2">
                    <button 
                      onClick={() => handleShortlist(m.id)}
                      className="flex-1 py-2 bg-white text-black font-bold text-sm rounded-xl border border-white/20 hover:bg-black/5 transition"
                    >
                      Shortlist
                    </button>
                    <button 
                      onClick={() => handleBroadcast(m.id)}
                      className="flex-1 py-2 bg-black text-white font-bold text-sm rounded-xl hover:bg-slate-800 transition"
                    >
                      Invite to Bid
                    </button>
                  </div>
                </motion.div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <div className="w-16 h-16 bg-slate-200 rounded-full flex items-center justify-center mx-auto mb-4">
                <UserCircle className="w-8 h-8 text-slate-400" />
              </div>
              <h3 className="text-lg font-black text-black">No Exact Matches found</h3>
              <p className="text-sm text-black/60 mt-1 max-w-md mx-auto">We couldn't immediately pinpoint highly rated professionals within that specific budget range and role constraint. Try inviting users directly or increasing the budget.</p>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
