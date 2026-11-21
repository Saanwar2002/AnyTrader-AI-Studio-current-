import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { db, doc, onSnapshot, collection, query, handleFirestoreError, OperationType } from "@/src/firebase";
import { motion } from "motion/react";
import { 
  ChevronLeft, Rocket, Wrench, FileText, CheckCircle2, 
  Clock, MapPin, List, ShieldCheck, Zap, User as UserIcon, ChevronRight
} from "lucide-react";
import { cn, getOutwardPostcode, formatJobLocation } from "@/src/lib/utils";

interface TimelineStep {
  id: string;
  title: string;
  description: string;
  icon: any;
  status: 'pending' | 'active' | 'completed';
}

export default function JobTimeline() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState<any>(null);
  const [quotes, setQuotes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;

    const unsubscribeJob = onSnapshot(doc(db, "jobs", id), (doc) => {
      if (doc.exists()) {
        setJob({ id: doc.id, ...doc.data() });
      }
      setLoading(false);
    }, (err) => {
      console.error(err);
      try {
        handleFirestoreError(err, OperationType.GET, `jobs/${id}`);
      } catch (e: any) {
        setError(e.message);
      }
    });

    const unsubscribeQuotes = onSnapshot(query(collection(db, "jobs", id, "quotes")), (snapshot) => {
      setQuotes(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    }, (err) => {
      console.error("Error fetching quotes for timeline:", err);
      handleFirestoreError(err, OperationType.LIST, `jobs/${id}/quotes`);
    });

    return () => {
      unsubscribeJob();
      unsubscribeQuotes();
    };
  }, [id]);

  if (loading) return <div className="py-12 flex justify-center"><Clock className="animate-spin" /></div>;
  if (!job) return <div className="py-12 text-center">Job not found.</div>;

  const status = String(job.status || "open").toLowerCase();
  const isBiddingOpen = ["open", "posted", "quoted", "quoting", "in_bidding"].includes(status);
  const quoteCount = Math.max(quotes.length, Number(job.quoteCount || job.quotesCount || 0));
  const paymentStatus = String(job.paymentStatus || "").toLowerCase();
  const isPaid = job.isPaid === true || paymentStatus === "paid" || paymentStatus === "handshake_complete";
  const isEscrowFunded = paymentStatus === "funded" || paymentStatus === "escrowed";
  const paymentSummaryLabel = isPaid
    ? "Payment settled & released."
    : isEscrowFunded
    ? "Escrow funded — awaiting work completion / release."
    : paymentStatus === "refunded"
    ? "Payment refunded."
    : ["failed", "reconciliation_required"].includes(paymentStatus)
    ? "Payment under reconciliation review."
    : "Payment pending completion / milestone release.";

  const steps: TimelineStep[] = [
    {
      id: "posted",
      title: "Job Open",
      description: "Your job is live and visible to verified local tradespeople.",
      icon: Rocket,
      status: isBiddingOpen && quoteCount === 0 ? "active" : "completed",
    },
    {
      id: "quotes",
      title: "Quotes Received",
      description:
        quoteCount > 0
          ? `${quoteCount} quote${quoteCount === 1 ? "" : "s"} submitted for your review.`
          : "Tradespeople can submit quotes for your review.",
      icon: FileText,
      status: isBiddingOpen
        ? quoteCount > 0
          ? "active"
          : "pending"
        : status === "cancelled" && quoteCount === 0
        ? "pending"
        : "completed",
    },
    {
      id: "accepted",
      title: "Quote Accepted",
      description: "You have accepted a quote. Escrow funding & scheduling are next.",
      icon: CheckCircle2,
      status:
        status === "accepted"
          ? "active"
          : ["in_progress", "completed", "disputed"].includes(status)
          ? "completed"
          : "pending",
    },
    {
      id: "in_progress",
      title: "Work In Progress",
      description: "The tradesperson is working on your job. Milestone/final payment unlocks on approval.",
      icon: Wrench,
      status:
        status === "in_progress"
          ? "active"
          : ["completed", "disputed"].includes(status)
          ? "completed"
          : "pending",
    },
    {
      id: "completed",
      title:
        status === "cancelled"
          ? "Job Cancelled"
          : status === "disputed"
          ? "Dispute Under Arbitration"
          : "Job Completed",
      description:
        status === "cancelled"
          ? job.cancellationReason || "This job was cancelled."
          : status === "disputed"
          ? job.disputeReason || "This job is locked in dispute mediation."
          : `Work is done! ${paymentSummaryLabel}`,
      icon: CheckCircle2,
      status:
        status === "completed"
          ? "completed"
          : status === "cancelled" || status === "disputed"
          ? "active"
          : "pending",
    },
  ];

  const progress =
    status === "completed"
      ? 100
      : status === "in_progress" || status === "disputed"
      ? 75
      : status === "accepted"
      ? 50
      : quoteCount > 0
      ? 25
      : status === "cancelled"
      ? 100
      : 10;

  const createdDateRaw = job.createdAt?.seconds
    ? new Date(job.createdAt.seconds * 1000)
    : job.createdAt
    ? new Date(job.createdAt)
    : new Date();
  const createdDateStr = !isNaN(createdDateRaw.getTime())
    ? createdDateRaw.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "Recently";

  const statusHeadline =
    status === "open" || status === "posted"
      ? quoteCount > 0
        ? "Quotes Received"
        : "Job Open"
      : status === "quoted" || status === "quoting" || status === "in_bidding"
      ? "Quotes Received"
      : status === "accepted"
      ? "Quote Accepted"
      : status === "in_progress"
      ? "Work In Progress"
      : status === "completed"
      ? "Job Completed"
      : status === "cancelled"
      ? "Job Cancelled"
      : status === "disputed"
      ? "Dispute Review"
      : status.replace(/_/g, " ");

  return (
    <div className="max-w-2xl mx-auto bg-slate-50 min-h-screen pb-20">
      {/* Header */}
      <div className="bg-[#1e3a5f] text-white p-4 sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="w-10 h-10 bg-white/10 border border-white/20 rounded-xl flex items-center justify-center hover:bg-white/20 hover:scale-105 transition-all group shrink-0">
            <ChevronLeft className="w-6 h-6 group-hover:-translate-x-0.5 transition-transform" />
          </button>
          <div>
            <h1 className="text-xl font-bold">Job Timeline</h1>
            <p className="text-xs text-blue-200">{job.category} - {job.subcategory || job.title}</p>
          </div>
        </div>
      </div>

      <div className="p-4 space-y-6">
        {/* Summary Card */}
        <div className="bg-white rounded-3xl p-6 border border-black shadow-sm space-y-6">
          <div className="flex justify-between items-start">
            <div className="space-y-1">
              <h2 className="text-2xl font-bold text-black capitalize">
                {statusHeadline}
              </h2>
              <p className="text-slate-600 text-sm">Posted {createdDateStr}</p>
            </div>
            <div className="relative w-16 h-16">
              <svg className="w-full h-full transform -rotate-90">
                <circle
                  cx="32"
                  cy="32"
                  r="28"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="transparent"
                  className="text-slate-100"
                />
                <circle
                  cx="32"
                  cy="32"
                  r="28"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="transparent"
                  strokeDasharray={175.9}
                  strokeDashoffset={175.9 * (1 - progress / 100)}
                  className="text-[#1e3a5f] transition-all duration-1000 ease-out"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-sm font-bold text-slate-900">{progress}%</span>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
              <span>Posted</span>
              <span>Complete</span>
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                className="h-full bg-[#1e3a5f]"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-4 border-t border-slate-50">
            <div className="flex items-center gap-1.5 text-slate-600">
              <Zap className="w-4 h-4 text-orange-500" />
              <span className="text-xs font-bold">{job.category}</span>
            </div>
            <div className="flex items-center gap-1.5 text-slate-600">
              <Clock className="w-4 h-4 text-blue-500" />
              <span className="text-xs font-bold">
                {job.estimatedCompletionTime ? `${job.estimatedCompletionTime} ${job.estimatedCompletionTimeUnit}` : 'N/A'}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-slate-600">
              <MapPin className="w-4 h-4 text-blue-500" />
              <span className="text-xs font-bold uppercase">{formatJobLocation(job)}</span>
            </div>
            <div className="flex items-center gap-1.5 text-slate-600">
              <List className="w-4 h-4 text-purple-500" />
              <span className="text-xs font-bold">{quotes.length} quotes</span>
            </div>
          </div>
        </div>

        {/* Timeline Steps */}
        <div className="relative space-y-4">
          {/* Vertical Line */}
          <div className="absolute left-6 top-8 bottom-8 w-0.5 bg-slate-100" />

          {steps.map((step, index) => (
            <div key={step.id} className="flex gap-4 relative">
              <div className={cn(
                "w-12 h-12 rounded-full flex items-center justify-center z-10 shrink-0 shadow-sm transition-colors duration-500",
                step.status === "completed" ? "bg-green-500 text-white" :
                step.status === "active" ? "bg-[#1e3a5f] text-white" :
                "bg-white text-slate-300 border border-black"
              )}>
                <step.icon className="w-6 h-6" />
              </div>
              
              <div className={cn(
                "flex-1 bg-white p-5 rounded-2xl border transition-all duration-500",
                step.status === "active" ? "border-[#1e3a5f] shadow-md" : "border-black shadow-sm",
                step.status === "pending" && "opacity-50"
              )}>
                <div className="flex items-center justify-between mb-1">
                  <h3 className="font-bold text-slate-900">{step.title}</h3>
                  {step.status === 'active' && (
                    <span className="text-[10px] font-bold uppercase bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full animate-pulse">
                      In Progress
                    </span>
                  )}
                  {step.status === 'completed' && (
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                  )}
                </div>
                <p className={cn(
                  "text-sm leading-relaxed",
                  step.status === "pending" ? "text-slate-400" : "text-slate-500"
                )}>
                  {step.description}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Footer Action */}
        <button 
          onClick={() => navigate(`/job/${id}`)}
          className="w-full bg-white p-5 rounded-2xl border border-black shadow-sm flex items-center justify-between group active:scale-[0.98] transition-all"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400 group-hover:text-[#1e3a5f] transition-colors">
              <Rocket className="w-5 h-5" />
            </div>
            <span className="font-bold text-slate-900">View Full Job Details</span>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-300 group-hover:text-[#1e3a5f] transition-colors" />
        </button>
      </div>
    </div>
  );
}
