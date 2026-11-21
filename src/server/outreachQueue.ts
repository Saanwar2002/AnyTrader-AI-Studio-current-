import admin from "firebase-admin";
import { BadRequestError, ForbiddenError, ServiceUnavailableError } from "./httpErrors.ts";

export type OutreachChannel = "email" | "whatsapp" | "sms";
export type OutreachDeliveryStatus =
  | "queued"
  | "sent"
  | "failed"
  | "skipped_no_provider";

export interface EnqueueOutreachInput {
  db: any;
  adminUid: string;
  adminEmail?: string | null;
  leadId: string;
  businessName: string;
  channel: OutreachChannel;
  recipient: string;
  subject?: string;
  body: string;
  campaignName?: string;
  providerConfig?: {
    emailConfigured?: boolean;
    smsConfigured?: boolean;
    whatsappConfigured?: boolean;
  };
  now?: Date;
}

export interface OutreachQueueRecord {
  id: string;
  leadId: string;
  businessName: string;
  channel: OutreachChannel;
  recipient: string;
  subject: string | null;
  body: string;
  campaignName: string | null;
  deliveryStatus: OutreachDeliveryStatus;
  providerConfigured: boolean;
  providerNotice: string;
  queuedByAdminUid: string;
  queuedByAdminEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

const ALLOWED_CHANNELS = new Set<OutreachChannel>(["email", "whatsapp", "sms"]);

function serverTimestampOrIso(now: Date): string {
  return now.toISOString();
}

export function detectOutreachProviderConfigured(
  channel: OutreachChannel,
  override?: { emailConfigured?: boolean; smsConfigured?: boolean; whatsappConfigured?: boolean }
): boolean {
  if (channel === "email") {
    if (typeof override?.emailConfigured === "boolean") return override.emailConfigured;
    return Boolean(
      (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) ||
      process.env.SENDGRID_API_KEY ||
      process.env.RESEND_API_KEY
    );
  }
  if (channel === "sms") {
    if (typeof override?.smsConfigured === "boolean") return override.smsConfigured;
    return Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_PHONE_NUMBER
    );
  }
  if (typeof override?.whatsappConfigured === "boolean") return override.whatsappConfigured;
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_NUMBER
  );
}

/**
 * AT-OUTREACH-02: Durable server-backed outreach outbound message queue.
 * Never fabricates "sent" status — persists honest `queued` (when a transport provider
 * is configured for worker dispatch) or `skipped_no_provider` when unconfigured.
 */
export async function enqueueOutreachMessageCommand(
  input: EnqueueOutreachInput
): Promise<OutreachQueueRecord> {
  const { db, adminUid, adminEmail = null, now = new Date() } = input;
  if (!db) {
    throw new ServiceUnavailableError("Database unavailable — cannot enqueue outreach message.");
  }
  if (!adminUid) {
    throw new ForbiddenError("Administrator authentication required.");
  }

  const channel = String(input.channel || "").trim().toLowerCase() as OutreachChannel;
  if (!ALLOWED_CHANNELS.has(channel)) {
    throw new BadRequestError("Channel must be one of: email, whatsapp, sms.");
  }

  const leadId = String(input.leadId || "").trim().slice(0, 120);
  const businessName = String(input.businessName || "").trim().slice(0, 160);
  const recipient = String(input.recipient || "").trim().slice(0, 160);
  const body = String(input.body || "").trim().slice(0, 4000);
  const subject = input.subject ? String(input.subject).trim().slice(0, 200) : null;
  const campaignName = input.campaignName ? String(input.campaignName).trim().slice(0, 160) : null;

  if (!leadId || !businessName || !recipient || !body) {
    throw new BadRequestError("leadId, businessName, recipient, and body are required.");
  }

  const providerConfigured = detectOutreachProviderConfigured(channel, input.providerConfig);
  const deliveryStatus: OutreachDeliveryStatus = providerConfigured ? "queued" : "skipped_no_provider";
  const providerNotice = providerConfigured
    ? `Queued for authoritative ${channel} delivery worker.`
    : `No outbound ${channel} provider configured — persisted in queue with status 'skipped_no_provider' (not delivered).`;

  const docRef = db.collection("outreach_outbound_queue").doc();
  const tsIso = serverTimestampOrIso(now);

  const record: OutreachQueueRecord = {
    id: docRef.id,
    leadId,
    businessName,
    channel,
    recipient,
    subject,
    body,
    campaignName,
    deliveryStatus,
    providerConfigured,
    providerNotice,
    queuedByAdminUid: adminUid,
    queuedByAdminEmail: adminEmail,
    createdAt: tsIso,
    updatedAt: tsIso,
  };

  await docRef.set({
    ...record,
    serverTimestamp:
      admin?.firestore?.FieldValue?.serverTimestamp
        ? admin.firestore.FieldValue.serverTimestamp()
        : tsIso,
  });

  return record;
}

export async function listOutreachQueueCommand(
  db: any,
  limitCount = 50
): Promise<OutreachQueueRecord[]> {
  if (!db) {
    throw new ServiceUnavailableError("Database unavailable — cannot load outreach queue.");
  }
  const safeLimit = Math.max(1, Math.min(200, Number(limitCount) || 50));
  const snap = await db
    .collection("outreach_outbound_queue")
    .orderBy("createdAt", "desc")
    .limit(safeLimit)
    .get();

  return (snap.docs || []).map((d: any) => ({
    id: d.id,
    ...(typeof d.data === "function" ? d.data() : d.data),
  })) as OutreachQueueRecord[];
}
