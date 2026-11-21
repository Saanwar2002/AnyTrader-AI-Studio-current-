// AT-CJ-CHAT-03: Server-Authoritative Chat Safety (Report / Block Participant)
import crypto from "crypto";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from "./httpErrors";

export type ChatSafetyAction = "report" | "block" | "report_and_block";

export interface ReportOrBlockInput {
  conversationId: string;
  targetUserId: string;
  action: ChatSafetyAction;
  reason?: string;
  details?: string;
}

export interface ChatBlockRecord {
  id: string;
  blockerUid: string;
  blockedUid: string;
  conversationId: string;
  reason: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatReportRecord {
  id: string;
  reporterUid: string;
  reportedUid: string;
  conversationId: string;
  jobId: string | null;
  reason: string;
  details: string;
  actionTaken: ChatSafetyAction;
  status: "open" | "reviewed" | "resolved";
  createdAt: string;
}

const VALID_ACTIONS = new Set<ChatSafetyAction>(["report", "block", "report_and_block"]);

export function buildChatBlockDocId(blockerUid: string, blockedUid: string): string {
  return `${blockerUid}__${blockedUid}`;
}

export async function reportOrBlockChatParticipantCommand(
  db: any,
  caller: { uid: string; email?: string },
  input: ReportOrBlockInput
): Promise<{
  action: ChatSafetyAction;
  blockRecord?: ChatBlockRecord;
  reportRecord?: ChatReportRecord;
}> {
  if (!db) {
    throw new ServiceUnavailableError("Database service unavailable.");
  }

  const conversationId = String(input?.conversationId || "").trim();
  const targetUserId = String(input?.targetUserId || "").trim();
  const action = String(input?.action || "").trim() as ChatSafetyAction;
  const reason = String(input?.reason || "inappropriate_behavior").trim().slice(0, 120);
  const details = String(input?.details || "").trim().slice(0, 1000);

  if (!conversationId) {
    throw new BadRequestError("conversationId is required.");
  }
  if (!targetUserId) {
    throw new BadRequestError("targetUserId is required.");
  }
  if (!VALID_ACTIONS.has(action)) {
    throw new BadRequestError("action must be one of 'report', 'block', or 'report_and_block'.");
  }
  if (targetUserId === caller.uid) {
    throw new BadRequestError("You cannot report or block yourself.");
  }
  if ((action === "report" || action === "report_and_block") && reason.length < 3) {
    throw new BadRequestError("Please provide a valid reason for reporting this participant.");
  }

  // Verify conversation exists and BOTH caller and targetUserId are participants
  const convRef = db.collection("conversations").doc(conversationId);
  const convSnap = await convRef.get();
  if (!convSnap.exists) {
    throw new NotFoundError("Conversation not found.");
  }
  const convData = convSnap.data() || {};
  const participants: string[] = Array.isArray(convData.participants) ? convData.participants : [];

  if (!participants.includes(caller.uid)) {
    throw new ForbiddenError("You are not a participant in this conversation.");
  }
  if (!participants.includes(targetUserId)) {
    throw new BadRequestError("The specified user is not a participant in this conversation.");
  }

  const nowIso = new Date().toISOString();
  let blockRecord: ChatBlockRecord | undefined;
  let reportRecord: ChatReportRecord | undefined;

  if (action === "block" || action === "report_and_block") {
    const blockId = buildChatBlockDocId(caller.uid, targetUserId);
    blockRecord = {
      id: blockId,
      blockerUid: caller.uid,
      blockedUid: targetUserId,
      conversationId,
      reason,
      active: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await db.collection("chat_user_blocks").doc(blockId).set(blockRecord, { merge: true });
  }

  if (action === "report" || action === "report_and_block") {
    const reportId = `chatrep_${crypto.randomBytes(8).toString("hex")}`;
    reportRecord = {
      id: reportId,
      reporterUid: caller.uid,
      reportedUid: targetUserId,
      conversationId,
      jobId: convData.jobId ? String(convData.jobId) : null,
      reason,
      details,
      actionTaken: action,
      status: "open",
      createdAt: nowIso,
    };
    await db.collection("chat_reports").doc(reportId).set(reportRecord);

    await db.collection("admin_audit_logs").doc(`audit_${reportId}`).set({
      action: "chat_participant_reported",
      actorUid: caller.uid,
      actorEmail: caller.email || null,
      targetUid: targetUserId,
      conversationId,
      jobId: convData.jobId ? String(convData.jobId) : null,
      reportId,
      reason,
      blockedParticipant: action === "report_and_block",
      createdAt: nowIso,
    });
  }

  return { action, blockRecord, reportRecord };
}

export async function unblockChatParticipantCommand(
  db: any,
  callerUid: string,
  targetUserId: string
): Promise<{ unblocked: boolean; blockId: string }> {
  if (!db) {
    throw new ServiceUnavailableError("Database service unavailable.");
  }
  const cleanTarget = String(targetUserId || "").trim();
  if (!cleanTarget) {
    throw new BadRequestError("targetUserId is required.");
  }

  const blockId = buildChatBlockDocId(callerUid, cleanTarget);
  const blockRef = db.collection("chat_user_blocks").doc(blockId);
  const snap = await blockRef.get();
  if (!snap.exists) {
    return { unblocked: false, blockId };
  }
  const data = snap.data() || {};
  if (data.blockerUid !== callerUid) {
    throw new ForbiddenError("You can only remove your own chat blocks.");
  }

  await blockRef.set(
    {
      active: false,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
  return { unblocked: true, blockId };
}

export async function listUserChatBlocksCommand(
  db: any,
  callerUid: string
): Promise<{ blockedUserIds: string[]; blocks: ChatBlockRecord[] }> {
  if (!db) {
    throw new ServiceUnavailableError("Database service unavailable.");
  }
  const snap = await db
    .collection("chat_user_blocks")
    .where("blockerUid", "==", callerUid)
    .where("active", "==", true)
    .limit(100)
    .get();

  const blocks: ChatBlockRecord[] = (snap.docs || []).map((d: any) => ({
    id: d.id,
    ...(d.data() || {}),
  }));
  const blockedUserIds = Array.from(new Set(blocks.map((b) => b.blockedUid).filter(Boolean)));
  return { blockedUserIds, blocks };
}
