import React, { useEffect, useState, useCallback } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Search,
  Wrench,
  FileSearch,
  ExternalLink,
  Loader2,
} from "lucide-react";

interface FinancialReconciliationTabProps {
  user: any;
  disputedJobs: any[];
  onResolveDispute?: (jobId: string, resolution: "resolved" | "mediated") => Promise<void> | void;
  onOpenDisputesTab?: () => void;
}

export default function AdminFinancialReconciliationTab({
  user,
  disputedJobs,
  onResolveDispute,
  onOpenDisputesTab,
}: FinancialReconciliationTabProps) {
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [runningAudit, setRunningAudit] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);
  const [activeCursor, setActiveCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<{ title: string; message: string; ok: boolean } | null>(null);

  // Manual Escrow Recovery Inspection Form
  const [escrowJobId, setEscrowJobId] = useState("");
  const [escrowQuoteId, setEscrowQuoteId] = useState("");
  const [escrowMilestoneId, setEscrowMilestoneId] = useState("");
  const [escrowIdempKey, setEscrowIdempKey] = useState("");
  const [escrowEvidence, setEscrowEvidence] = useState<any>(null);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);

  const fetchReport = useCallback(
    async (forceFullAudit = true, cursorOverride?: string | null) => {
      if (!user) return;
      if (forceFullAudit) setRunningAudit(true);
      else setLoading(true);
      setError(null);
      try {
        const idToken = await user.getIdToken();
        const effectiveCursor = cursorOverride !== undefined ? cursorOverride : activeCursor;
        const cursorQuery = effectiveCursor ? `&cursor=${encodeURIComponent(effectiveCursor)}` : "";
        const url = `/api/admin/financial-reconciliation/report?limit=50&statusFilter=${encodeURIComponent(
          statusFilter
        )}&includeAudit=${forceFullAudit ? "true" : "false"}${cursorQuery}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error || `Failed to load financial reconciliation report (${res.status})`);
        }
        setReport(data);
      } catch (err: any) {
        setError(err?.message || "Failed to fetch reconciliation report.");
      } finally {
        setLoading(false);
        setRunningAudit(false);
      }
    },
    [user, statusFilter, activeCursor]
  );

  useEffect(() => {
    fetchReport(true);
  }, [fetchReport]);

  const handleStatusFilterChange = (nextFilter: string) => {
    setCursorStack([]);
    setActiveCursor(null);
    setStatusFilter(nextFilter);
  };

  const handleNextPage = () => {
    if (!report?.nextCursor) return;
    setCursorStack((prev) => [...prev, activeCursor]);
    setActiveCursor(report.nextCursor);
  };

  const handlePrevPage = () => {
    if (cursorStack.length === 0) return;
    const nextStack = [...cursorStack];
    const prevCursor = nextStack.pop() ?? null;
    setCursorStack(nextStack);
    setActiveCursor(prevCursor);
  };

  const runOperatorAction = async (payload: Record<string, any>, keyTag: string) => {
    if (!user) return;
    setResolvingKey(keyTag);
    setActionStatus(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/admin/financial-reconciliation/resolve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `Operator action failed (${res.status})`);
      }
      if (data.evidence) {
        setEscrowEvidence(data.evidence);
      }
      setActionStatus({
        title: "Operator Action Recorded",
        message:
          data.action === "repair_escrow_ledger"
            ? `Ledger repair verified (${data.ledgerUpdated ? "updated" : "already consistent"}).`
            : data.action === "inspect_escrow"
            ? `Evidence status: ${data.evidence?.status || "inspected"}`
            : `Finding ${payload.findingCode} marked ${payload.action === "escalate_finding" ? "escalated" : "acknowledged"}.`,
        ok: true,
      });
      if (payload.action === "repair_escrow_ledger") {
        await fetchReport(true);
      }
    } catch (err: any) {
      setActionStatus({
        title: "Operator Action Blocked",
        message: err?.message || "Action could not complete.",
        ok: false,
      });
    } finally {
      setResolvingKey(null);
    }
  };

  const fullAudit = report?.fullAudit;
  const findings = Array.isArray(fullAudit?.findings) ? fullAudit.findings : [];
  const records = Array.isArray(report?.records) ? report.records : [];
  const summary = report?.summary || {
    totalPence: 0,
    reconciledCount: 0,
    failedCount: 0,
    pendingCount: 0,
    legacyCount: 0,
    ambiguousCount: 0,
  };

  return (
    <div className="p-6 space-y-6 text-black">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-black text-black flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-700" />
            Financial Reconciliation &amp; Operator Workflows (FIN-05)
          </h3>
          <p className="text-xs text-black/70 mt-0.5">
            Live Stripe &amp; Firestore ledger reconciliation collector, anomaly inspection, and disputed escrow review.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => handleStatusFilterChange(e.target.value)}
            aria-label="Filter ledger transfer status"
            className="px-3 py-2 rounded-xl border border-black bg-white text-xs font-bold text-black"
          >
            <option value="all">All Transfer States</option>
            <option value="completed">Completed</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
            <option value="released">Released</option>
            <option value="disputed">Disputed</option>
          </select>

          <button
            onClick={() => fetchReport(true)}
            disabled={loading || runningAudit}
            className="flex items-center gap-2 px-4 py-2 rounded-xl border border-black bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 disabled:opacity-50"
          >
            {runningAudit ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Run Full FIN-05 Collector Audit
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-2xl border border-black bg-red-50 text-black flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-700 shrink-0" />
          <p className="text-xs font-bold">{error}</p>
        </div>
      )}

      {actionStatus && (
        <div
          className={`p-4 rounded-2xl border border-black flex items-center justify-between gap-3 ${
            actionStatus.ok ? "bg-emerald-50" : "bg-amber-50"
          }`}
        >
          <div>
            <p className="text-xs font-black text-black">{actionStatus.title}</p>
            <p className="text-xs text-black/80">{actionStatus.message}</p>
          </div>
          <button
            onClick={() => setActionStatus(null)}
            className="px-2.5 py-1 rounded-lg border border-black bg-white text-xs font-bold text-black"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="p-4 rounded-2xl border border-black bg-white">
          <p className="text-[10px] font-black uppercase tracking-wider text-black/60">Ledger Volume</p>
          <p className="text-xl font-black text-black mt-1">£{(summary.totalPence / 100).toFixed(2)}</p>
        </div>
        <div className="p-4 rounded-2xl border border-black bg-white">
          <p className="text-[10px] font-black uppercase tracking-wider text-black/60">Reconciled</p>
          <p className="text-xl font-black text-emerald-700 mt-1">{summary.reconciledCount}</p>
        </div>
        <div className="p-4 rounded-2xl border border-black bg-white">
          <p className="text-[10px] font-black uppercase tracking-wider text-black/60">Pending / Ambiguous</p>
          <p className="text-xl font-black text-amber-700 mt-1">
            {summary.pendingCount + summary.ambiguousCount}
          </p>
        </div>
        <div className="p-4 rounded-2xl border border-black bg-white">
          <p className="text-[10px] font-black uppercase tracking-wider text-black/60">Failed Transfers</p>
          <p className="text-xl font-black text-red-700 mt-1">{summary.failedCount}</p>
        </div>
        <div className="p-4 rounded-2xl border border-black bg-white">
          <p className="text-[10px] font-black uppercase tracking-wider text-black/60">FIN-05 Findings</p>
          <p className="text-xl font-black text-black mt-1">
            {fullAudit?.executed ? `${fullAudit.findingCount || 0} (${fullAudit.criticalCount || 0} crit)` : "Unavailable"}
          </p>
        </div>
      </div>

      {/* Collector Audit Status Banner */}
      {fullAudit && !fullAudit.executed && (
        <div className="p-4 rounded-2xl border border-black bg-amber-50 text-black flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-black text-black">Full FIN-05 Collector Audit Not Executed</p>
            <p className="text-xs text-black/80 mt-0.5">
              {fullAudit.unavailableReason || "Stripe credentials must be configured to reconcile live captures, refunds, and transfers."}
            </p>
          </div>
        </div>
      )}

      {/* Disputed Escrow Queue */}
      <div className="p-5 rounded-2xl border border-black bg-slate-50 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-black text-black">Disputed Jobs &amp; Escrow Review Queue</h4>
            <p className="text-xs text-black/70">
              {disputedJobs.length} disputed job(s) requiring operator settlement or mediation review.
            </p>
          </div>
          {onOpenDisputesTab && (
            <button
              onClick={onOpenDisputesTab}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-black bg-white text-xs font-bold text-black hover:bg-slate-100"
            >
              Open Disputes Tab
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {disputedJobs.length === 0 ? (
          <div className="p-3 rounded-xl border border-black bg-white text-xs font-bold text-black flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-700" />
            No active disputed escrow holds.
          </div>
        ) : (
          <div className="space-y-2">
            {disputedJobs.slice(0, 5).map((job) => (
              <div
                key={job.id}
                className="p-3 rounded-xl border border-black bg-white flex flex-wrap items-center justify-between gap-3"
              >
                <div>
                  <p className="text-xs font-black text-black">{job.title || job.id}</p>
                  <p className="text-[11px] text-black/70">
                    Job ID: {job.id} • Quote: {job.acceptedQuoteId || "N/A"} • Stake Paid:{" "}
                    {job.mediationStakePaid ? "Yes" : "No"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setEscrowJobId(job.id);
                      setEscrowQuoteId(job.acceptedQuoteId || "");
                    }}
                    className="px-2.5 py-1.5 rounded-xl border border-black bg-slate-100 text-[11px] font-bold text-black"
                  >
                    Load into Inspector
                  </button>
                  {onResolveDispute && (
                    <button
                      onClick={() => onResolveDispute(job.id, "resolved")}
                      className="px-2.5 py-1.5 rounded-xl border border-black bg-emerald-600 text-[11px] font-bold text-white"
                    >
                      Mark Resolved
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* FIN-05 Findings Panel */}
      <div className="p-5 rounded-2xl border border-black bg-white space-y-3">
        <h4 className="text-sm font-black text-black">FIN-05 Discrepancy Findings</h4>
        {findings.length === 0 ? (
          <p className="text-xs text-black/70">
            {fullAudit?.executed
              ? "Zero critical or warning discrepancies found in the latest Stripe + Firestore collector run."
              : "Run the Full FIN-05 Collector Audit with Stripe configured to inspect cross-system discrepancies."}
          </p>
        ) : (
          <div className="space-y-2">
            {findings.map((finding: any, idx: number) => {
              const keyTag = `${finding.code}_${finding.entityId}_${idx}`;
              return (
                <div key={keyTag} className="p-3 rounded-xl border border-black bg-slate-50 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded-lg border border-black text-[10px] font-black uppercase ${
                          finding.severity === "critical" ? "bg-red-100 text-black" : "bg-amber-100 text-black"
                        }`}
                      >
                        {finding.severity}
                      </span>
                      <span className="text-xs font-black text-black">{finding.code}</span>
                      <span className="text-xs font-mono text-black/70">{finding.entityId}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        disabled={resolvingKey === keyTag}
                        onClick={() =>
                          runOperatorAction(
                            {
                              action: "acknowledge_finding",
                              findingCode: finding.code,
                              entityId: finding.entityId,
                              note: "Acknowledged in Admin Reconciliation Console",
                            },
                            keyTag
                          )
                        }
                        className="px-2.5 py-1 rounded-lg border border-black bg-white text-[11px] font-bold text-black hover:bg-slate-100"
                      >
                        Acknowledge
                      </button>
                      <button
                        disabled={resolvingKey === keyTag}
                        onClick={() =>
                          runOperatorAction(
                            {
                              action: "escalate_finding",
                              findingCode: finding.code,
                              entityId: finding.entityId,
                              note: "Escalated for manual Stripe/Escrow review",
                            },
                            keyTag
                          )
                        }
                        className="px-2.5 py-1 rounded-lg border border-black bg-amber-300 text-[11px] font-bold text-black hover:bg-amber-400"
                      >
                        Escalate
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-black">{finding.message}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Escrow Transfer Inspector & Verified Repair Workflow */}
      <div className="p-5 rounded-2xl border border-black bg-white space-y-4">
        <div className="flex items-center gap-2">
          <Wrench className="w-4 h-4 text-black" />
          <h4 className="text-sm font-black text-black">Escrow Transfer Inspector &amp; Ledger Recovery</h4>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input
            type="text"
            placeholder="Job ID"
            value={escrowJobId}
            onChange={(e) => setEscrowJobId(e.target.value)}
            className="px-3 py-2 rounded-xl border border-black bg-slate-50 text-xs font-bold text-black"
          />
          <input
            type="text"
            placeholder="Quote ID"
            value={escrowQuoteId}
            onChange={(e) => setEscrowQuoteId(e.target.value)}
            className="px-3 py-2 rounded-xl border border-black bg-slate-50 text-xs font-bold text-black"
          />
          <input
            type="text"
            placeholder="Milestone ID"
            value={escrowMilestoneId}
            onChange={(e) => setEscrowMilestoneId(e.target.value)}
            className="px-3 py-2 rounded-xl border border-black bg-slate-50 text-xs font-bold text-black"
          />
          <input
            type="text"
            placeholder="Release Idempotency Key"
            value={escrowIdempKey}
            onChange={(e) => setEscrowIdempKey(e.target.value)}
            className="px-3 py-2 rounded-xl border border-black bg-slate-50 text-xs font-bold text-black"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            disabled={resolvingKey === "inspect_escrow"}
            onClick={() =>
              runOperatorAction(
                {
                  action: "inspect_escrow",
                  jobId: escrowJobId.trim(),
                  quoteId: escrowQuoteId.trim(),
                  milestoneId: escrowMilestoneId.trim(),
                  idempotencyKey: escrowIdempKey.trim(),
                },
                "inspect_escrow"
              )
            }
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-black bg-slate-100 text-xs font-bold text-black hover:bg-slate-200"
          >
            <FileSearch className="w-3.5 h-3.5" />
            Inspect Read-Only Evidence
          </button>
          <button
            disabled={resolvingKey === "repair_escrow_ledger"}
            onClick={() =>
              runOperatorAction(
                {
                  action: "repair_escrow_ledger",
                  jobId: escrowJobId.trim(),
                  quoteId: escrowQuoteId.trim(),
                  milestoneId: escrowMilestoneId.trim(),
                  idempotencyKey: escrowIdempKey.trim(),
                },
                "repair_escrow_ledger"
              )
            }
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-black bg-emerald-600 text-xs font-bold text-white hover:bg-emerald-700"
          >
            <Search className="w-3.5 h-3.5" />
            Verify &amp; Repair Ledger
          </button>
        </div>

        {escrowEvidence && (
          <div className="p-3 rounded-xl border border-black bg-slate-50 text-xs space-y-1">
            <p className="font-black text-black">
              Evidence Status: {escrowEvidence.status} ({escrowEvidence.candidateTransfersCount} candidate transfer(s))
            </p>
            {escrowEvidence.matchedTransferId && (
              <p className="font-mono text-black">Matched Transfer: {escrowEvidence.matchedTransferId}</p>
            )}
            {escrowEvidence.unresolvedReason && <p className="text-black/80">{escrowEvidence.unresolvedReason}</p>}
          </div>
        )}
      </div>

      {/* Recent Payment Ledger Records */}
      <div className="p-5 rounded-2xl border border-black bg-white space-y-3 overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-black text-black">
            Sanitized Ledger Page ({records.length} record{records.length === 1 ? "" : "s"}
            {summary.unknownFeeCount > 0 ? ` · ${summary.unknownFeeCount} unverified fee` : ""})
          </h4>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrevPage}
              disabled={cursorStack.length === 0 || loading || runningAudit}
              className="px-3 py-1 rounded-lg border border-black bg-white text-xs font-bold text-black disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={handleNextPage}
              disabled={!report?.hasMore || !report?.nextCursor || loading || runningAudit}
              className="px-3 py-1 rounded-lg border border-black bg-white text-xs font-bold text-black disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-black text-[10px] font-black uppercase text-black/60">
              <th className="py-2 pr-3">Ledger ID</th>
              <th className="py-2 pr-3">Job</th>
              <th className="py-2 pr-3">Gross</th>
              <th className="py-2 pr-3">Platform Fee</th>
              <th className="py-2 pr-3">Net Payout</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3">Transfer</th>
              <th className="py-2 pr-3">Stripe ID (Masked)</th>
              <th className="py-2">Schema</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {records.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-4 text-center text-black/60 font-bold">
                  No matching ledger entries found.
                </td>
              </tr>
            ) : (
              records.map((rec: any) => (
                <tr key={rec.ledgerId} className="hover:bg-slate-50">
                  <td className="py-2 pr-3 font-mono">{rec.ledgerId}</td>
                  <td className="py-2 pr-3 font-bold">{rec.jobId}</td>
                  <td className="py-2 pr-3 font-black">{rec.formattedAmount}</td>
                  <td className="py-2 pr-3 font-medium text-black">
                    {rec.feeVerificationStatus === "unknown" ? (
                      <span className="px-1.5 py-0.5 rounded border border-black bg-amber-50 text-[10px] font-bold">
                        Unknown / Unverified
                      </span>
                    ) : (
                      rec.formattedPlatformFee
                    )}
                  </td>
                  <td className="py-2 pr-3 font-medium text-black">
                    {rec.feeVerificationStatus === "unknown" ? (
                      <span className="px-1.5 py-0.5 rounded border border-black bg-amber-50 text-[10px] font-bold">
                        Unknown / Unverified
                      </span>
                    ) : (
                      rec.formattedNetPayout
                    )}
                  </td>
                  <td className="py-2 pr-3 font-bold uppercase">{rec.reconciliationStatus}</td>
                  <td className="py-2 pr-3">{rec.transferStatus}</td>
                  <td className="py-2 pr-3 font-mono">{rec.stripeTransferIdMasked || "—"}</td>
                  <td className="py-2">{rec.schemaVariant}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
