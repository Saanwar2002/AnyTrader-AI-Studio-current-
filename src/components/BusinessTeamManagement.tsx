import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Users, UserPlus, Mail, X, Shield, ShieldCheck, Clock, Trash2, Loader2, CheckCircle2, AlertTriangle, Building2 } from "lucide-react";
import { useAuth } from "./AuthProvider";
import { cn } from "@/src/lib/utils";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";

interface TeamMember {
  uid: string;
  name: string;
  email: string;
  role: string;
  avatarUrl?: string;
  isDisabled?: boolean;
}

interface TeamInvitation {
  id: string;
  email: string;
  role: string;
  status: 'pending' | 'accepted' | 'expired';
  deliveryStatus?: string;
  createdAt: any;
  expiresAt?: string;
  businessId: string;
}

export default function BusinessTeamManagement() {
  const { profile, user } = useAuth();
  const navigate = useNavigate();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<TeamInvitation[]>([]);
  const [seatLimit, setSeatLimit] = useState<number>(5);
  const [isUnlimitedSeats, setIsUnlimitedSeats] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [isSendingInvite, setIsSendingInvite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemoveMemberUid, setPendingRemoveMemberUid] = useState<string | null>(null);

  // Constants for Tier checking
  const subType = (profile?.subscriptionType || "").toLowerCase();
  const role = (profile?.role || "").toLowerCase();
  const isEligible = role === 'admin' ||
                    role === 'business' || 
                    role === 'tradesperson' ||
                    subType === 'business' || 
                    subType === 'gold' || 
                    subType === 'platinum' || 
                    subType === 'enterprise' || 
                    subType.includes('business') || 
                    subType.includes('enterprise');

  const fetchTeamData = useCallback(async () => {
    if (!user || !isEligible) {
      setLoading(false);
      return;
    }
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/business/team", {
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        throw new Error(data?.error || "Unable to load team details.");
      }
      setMembers(Array.isArray(data.members) ? data.members : []);
      setInvitations(Array.isArray(data.invitations) ? data.invitations : []);
      if (typeof data.seatLimit === "number") setSeatLimit(data.seatLimit);
      setIsUnlimitedSeats(Boolean(data.isUnlimitedSeats));
    } catch (err: any) {
      console.error("Failed to fetch business team:", err);
      toast.error(err?.message || "Unable to load team members right now.");
    } finally {
      setLoading(false);
    }
  }, [user, isEligible]);

  useEffect(() => {
    void fetchTeamData();
  }, [fetchTeamData]);

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !inviteEmail.trim()) return;

    setIsSendingInvite(true);
    setError(null);

    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/business/team/invite", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ email: inviteEmail.toLowerCase().trim() }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Failed to send invitation.");
      }

      setInviteEmail("");
      setShowInviteModal(false);
      if (data.deliveryStatus === "delivered") {
        toast.success(`Invitation email sent to ${data.email}.`);
      } else if (data.inAppNotified) {
        toast.success(`Invitation created and sent in-app to ${data.email}.`);
      } else {
        toast.success(`Invitation created for ${data.email}.`);
      }
      await fetchTeamData();
    } catch (err: any) {
      setError(err.message || "Failed to send invitation");
    } finally {
      setIsSendingInvite(false);
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    if (!user) return;
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/business/team/invitations/${encodeURIComponent(inviteId)}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        throw new Error(data?.error || "Failed to revoke invitation.");
      }
      setInvitations((prev) => prev.filter((inv) => inv.id !== inviteId));
      toast.success("Invitation revoked.");
    } catch (err: any) {
      toast.error(err?.message || "Failed to revoke invitation.");
    }
  };

  const handleRemoveMember = (memberUid: string) => {
    setPendingRemoveMemberUid(memberUid);
  };

  const executeRemoveMember = async () => {
    if (!pendingRemoveMemberUid || !user) return;
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/business/team/members/${encodeURIComponent(pendingRemoveMemberUid)}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        throw new Error(data?.error || "Failed to remove team member.");
      }
      setMembers((prev) => prev.filter((m) => m.uid !== pendingRemoveMemberUid));
      toast.success("Team member removed.");
    } catch (err: any) {
      toast.error(err?.message || "Failed to remove team member.");
    } finally {
      setPendingRemoveMemberUid(null);
    }
  };

  if (!isEligible) {
    return (
      <div className="p-12 text-center bg-white rounded-[40px] border-2 border-dashed border-black flex flex-col items-center gap-6 max-w-2xl mx-auto shadow-2xl shadow-indigo-50 mt-12">
        <div className="w-24 h-24 rounded-full bg-indigo-50 flex items-center justify-center">
          <Shield className="w-12 h-12 text-indigo-400" />
        </div>
        <div>
          <h2 className="text-3xl font-black text-slate-900 mb-2 tracking-tight">Enterprise Scaling Locked</h2>
          <p className="text-slate-500 font-medium">Multi-seat team management is exclusive to Business Professional and Enterprise tiers.</p>
        </div>
        <div className="flex flex-col gap-3 w-full">
           <button
             type="button"
             onClick={() => navigate("/billing")}
             className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-black text-sm shadow-xl shadow-indigo-200 hover:bg-indigo-700 transition-all active:scale-95 cursor-pointer"
           >
             Upgrade Subscription
           </button>
           <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Starting from £125/month</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-2 py-0.5 bg-indigo-100 text-indigo-600 text-[10px] font-black rounded-full uppercase tracking-widest">Business Suite</span>
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          </div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            Team <span className="text-indigo-600">Coordination</span>
            <Users className="w-8 h-8 text-indigo-600" />
          </h1>
          <p className="text-slate-500 font-medium mt-1">Manage seats, permissions and collaborative job accounts.</p>
        </div>
        <button 
          type="button"
          onClick={() => setShowInviteModal(true)}
          className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-black text-sm flex items-center gap-3 shadow-2xl shadow-indigo-100 hover:bg-indigo-700 transition-all active:scale-95 group cursor-pointer"
        >
          <UserPlus className="w-5 h-5 transition-transform group-hover:rotate-12" />
          Add Team Member
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Active Members */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white rounded-[40px] border border-black shadow-xl shadow-slate-200/50 overflow-hidden">
            <div className="p-8 border-b border-slate-50 flex items-center justify-between bg-slate-50/30">
              <h3 className="font-black text-slate-900 uppercase tracking-widest text-xs">Active Team Members</h3>
              <span className="px-3 py-1 bg-white border border-black rounded-xl font-bold text-xs text-slate-500 shadow-sm">
                {members.length + 1} / {isUnlimitedSeats ? 'Unlimited' : seatLimit} Seats
              </span>
            </div>
            <div className="divide-y divide-slate-50">
              {/* Owner Card */}
              <div className="p-8 flex items-center justify-between hover:bg-slate-50/30 transition-colors">
                <div className="flex items-center gap-5">
                   <div className="w-16 h-16 rounded-[24px] bg-slate-900 flex items-center justify-center text-white shadow-xl shadow-slate-200 shrink-0">
                      {profile?.avatarUrl ? <img src={profile.avatarUrl} className="w-full h-full rounded-[24px] object-cover" /> : <Building2 className="w-8 h-8" />}
                   </div>
                   <div>
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="font-black text-slate-900 text-lg tracking-tight">{profile?.name} (You)</p>
                        <span className="px-2 py-0.5 bg-blue-100 text-blue-600 text-[8px] font-black rounded-full uppercase tracking-widest">Admin</span>
                      </div>
                      <p className="text-sm font-medium text-slate-400">{profile?.email}</p>
                   </div>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-black text-slate-400 uppercase tracking-widest bg-slate-50 px-4 py-2 rounded-2xl border border-black italic">
                  Primary Owner
                </div>
              </div>

              {/* Members */}
              {members.map(member => (
                <div key={member.uid} className="p-8 flex items-center justify-between hover:bg-indigo-50/30 transition-colors group">
                  <div className="flex items-center gap-5">
                    <div className="w-16 h-16 rounded-[24px] bg-white border border-black flex items-center justify-center text-slate-400 shadow-sm shrink-0">
                      {member.avatarUrl ? <img src={member.avatarUrl} className="w-full h-full rounded-[24px] object-cover" /> : <Users className="w-8 h-8" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="font-black text-slate-900 text-lg tracking-tight">{member.name}</p>
                        <span className="px-2 py-0.5 bg-indigo-50 text-indigo-600 text-[8px] font-black rounded-full uppercase tracking-widest">Member</span>
                      </div>
                      <p className="text-sm font-medium text-slate-400">{member.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                     <button 
                       onClick={() => handleRemoveMember(member.uid)}
                       className="p-3 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-2xl transition-all shadow-sm group-hover:bg-white"
                     >
                       <Trash2 className="w-5 h-5" />
                     </button>
                  </div>
                </div>
              ))}

              {members.length === 0 && (
                <div className="p-16 text-center text-slate-400 italic font-medium">
                  No additional team members joined yet.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Invitations & Resource Usage */}
        <div className="space-y-8">
          <div className="bg-white rounded-[40px] border border-black shadow-xl shadow-slate-200/50 p-8 space-y-6">
            <h3 className="font-black text-slate-900 uppercase tracking-widest text-xs flex items-center gap-3">
              <Mail className="w-4 h-4 text-amber-500" />
              Pending Invites
            </h3>
            <div className="space-y-3">
              {invitations.map(invite => (
                <div key={invite.id} className="p-4 rounded-3xl bg-amber-50/50 border border-amber-100 flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="font-black text-slate-900 text-sm truncate">{invite.email}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                       <Clock className="w-3 h-3 text-amber-500" />
                       <p className="text-[10px] font-bold text-amber-600 uppercase">Awaiting Acceptance</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => handleRevokeInvite(invite.id)}
                    className="p-2 text-amber-400 hover:text-red-600 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
              {invitations.length === 0 && (
                <div className="p-8 text-center border-2 border-dashed border-black rounded-[30px]">
                   <p className="text-xs font-bold text-slate-400 italic">No pending invites</p>
                </div>
              )}
            </div>
          </div>

          <div className="bg-slate-900 rounded-[40px] p-8 text-white space-y-6 shadow-2xl shadow-slate-300">
             <div className="flex items-start justify-between">
                <div>
                   <h3 className="font-black text-xs uppercase tracking-widest text-blue-400 mb-1">Collaborative Pulse</h3>
                   <p className="text-2xl font-black">{members.length + 1} Active seats</p>
                </div>
                <div className="w-12 h-12 rounded-2xl bg-white/10 flex items-center justify-center">
                   <ShieldCheck className="w-6 h-6 text-emerald-400" />
                </div>
             </div>
             <div className="space-y-4 pt-4 border-t border-white/10">
                <p className="text-xs text-white/60 leading-relaxed font-medium">
                  Team members can post jobs on behalf of the business and manage service quotes. All billing remains centralized to the Primary Owner.
                </p>
                <div className="flex items-center gap-3 bg-white/5 p-4 rounded-2xl">
                   <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                   <p className="text-[10px] font-bold text-amber-400 leading-tight">
                     Role restrictions are active. Members cannot access billing or monetization settings.
                   </p>
                </div>
             </div>
          </div>
        </div>
      </div>

      {/* Invite Modal */}
      <AnimatePresence>
        {showInviteModal && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-md z-[1000] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white rounded-[40px] shadow-[0_32px_128px_-16px_rgba(0,0,0,0.3)] w-full max-w-lg overflow-hidden border border-white"
            >
              <form onSubmit={handleSendInvite} className="p-10 space-y-8">
                <div className="text-center space-y-2">
                  <div className="w-20 h-20 rounded-[30px] bg-indigo-50 flex items-center justify-center mx-auto text-indigo-600 mb-4 transform -rotate-3 transition-transform hover:rotate-0">
                    <UserPlus className="w-10 h-10" />
                  </div>
                  <h2 className="text-3xl font-black text-slate-900 tracking-tight">Expand Your Team</h2>
                  <p className="text-slate-500 font-medium">Send an email invitation to join your business account.</p>
                </div>

                <div className="space-y-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-2">Recipient Email</label>
                    <div className="relative group">
                       <Mail className="absolute left-6 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 group-focus-within:text-indigo-600 transition-colors" />
                       <input 
                         required
                         type="email"
                         value={inviteEmail}
                         onChange={(e) => setInviteEmail(e.target.value)}
                         placeholder="teammate@company.com"
                         className="w-full pl-16 pr-8 py-5 rounded-[24px] bg-slate-50 border-2 border-transparent focus:bg-white focus:border-indigo-600 focus:outline-none transition-all font-bold text-slate-900"
                       />
                    </div>
                  </div>

                  <div className="p-5 bg-blue-50/50 rounded-2xl border border-blue-100 flex items-start gap-4">
                     <ShieldCheck className="w-6 h-6 text-blue-600 mt-1 shrink-0" />
                     <div className="space-y-1">
                        <p className="text-xs font-black text-blue-900 uppercase tracking-widest leading-none">Standard Permissions</p>
                        <ul className="text-[10px] font-bold text-blue-700/70 space-y-1 list-disc pl-4 mt-2">
                          <li>Create & Manage Job Posts</li>
                          <li>View & Interact with Quote Requests</li>
                          <li>Access Shared Portfolio Assets</li>
                        </ul>
                     </div>
                  </div>
                </div>

                {error && (
                  <div className="p-4 bg-red-50 rounded-2xl border border-red-100 flex items-center gap-3 text-red-600 text-xs font-bold">
                    <AlertTriangle className="w-4 h-4" />
                    {error}
                  </div>
                )}

                <div className="flex gap-4">
                  <button 
                    type="button"
                    onClick={() => setShowInviteModal(false)}
                    className="flex-1 py-5 rounded-3xl font-black text-slate-400 hover:bg-slate-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit"
                    disabled={isSendingInvite}
                    className="flex-[2] bg-indigo-600 text-white py-5 rounded-3xl font-black text-sm shadow-xl shadow-indigo-100 hover:bg-indigo-700 transition-all flex items-center justify-center gap-3 disabled:opacity-50"
                  >
                    {isSendingInvite ? (
                      <Loader2 className="w-6 h-6 animate-spin" />
                    ) : (
                      <>
                        <CheckCircle2 className="w-5 h-5" />
                        Send Invite
                      </>
                    )}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {pendingRemoveMemberUid && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[120] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full shadow-2xl border border-black space-y-4">
            <div className="text-center space-y-2">
              <h4 className="text-base font-black text-black">Remove Team Member?</h4>
              <p className="text-xs text-black leading-relaxed">
                Are you sure you want to remove this member? They will lose access to your business team features.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setPendingRemoveMemberUid(null)}
                className="flex-1 py-2.5 rounded-xl border border-black text-black text-xs font-bold hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={executeRemoveMember}
                className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-xs font-black border border-black hover:bg-red-700 cursor-pointer"
              >
                Remove Member
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
