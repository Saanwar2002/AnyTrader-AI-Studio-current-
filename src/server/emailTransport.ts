import * as admin from 'firebase-admin';

export type EmailProviderKind = 'sendgrid' | 'resend' | 'none';
export type EmailDeliveryStatus = 'delivered' | 'failed' | 'unconfigured';

export interface EmailTransportConfig {
  configured: boolean;
  provider: EmailProviderKind;
  apiKey?: string;
  fromEmail: string;
}

export interface DispatchEmailInput {
  db?: admin.firestore.Firestore | any | null;
  to: string;
  subject: string;
  html: string;
  text?: string;
  metadata?: Record<string, any>;
  queueCollection?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

export interface DispatchEmailResult {
  success: boolean;
  delivered: boolean;
  status: EmailDeliveryStatus;
  provider: EmailProviderKind;
  queueId?: string;
  providerMessageId?: string;
  error?: string;
  timestamp: string;
}

const BASIC_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function getEmailTransportConfig(env: NodeJS.ProcessEnv = process.env): EmailTransportConfig {
  const fromEmail =
    (env.EMAIL_FROM || env.SENDGRID_FROM_EMAIL || env.RESEND_FROM_EMAIL || '').trim() ||
    'no-reply@anytrader.co.uk';

  const sendgridKey = (env.SENDGRID_API_KEY || '').trim();
  if (sendgridKey && sendgridKey !== 'placeholder' && !sendgridKey.startsWith('REPLACE_')) {
    return {
      configured: true,
      provider: 'sendgrid',
      apiKey: sendgridKey,
      fromEmail,
    };
  }

  const resendKey = (env.RESEND_API_KEY || '').trim();
  if (resendKey && resendKey !== 'placeholder' && !resendKey.startsWith('REPLACE_')) {
    return {
      configured: true,
      provider: 'resend',
      apiKey: resendKey,
      fromEmail,
    };
  }

  return {
    configured: false,
    provider: 'none',
    fromEmail,
  };
}

/**
 * Durable server email dispatcher with explicit provider configuration verification.
 * Records every attempt in `email_queue` (or custom queue collection) and NEVER returns
 * `success: true` / `delivered` when the provider is unconfigured or fails delivery.
 */
export async function dispatchTransactionalEmail(
  input: DispatchEmailInput
): Promise<DispatchEmailResult> {
  const now = new Date().toISOString();
  const recipient = (input.to || '').trim();
  const subject = (input.subject || '').trim();
  const html = input.html || '';

  if (!recipient || !BASIC_EMAIL_REGEX.test(recipient)) {
    return {
      success: false,
      delivered: false,
      status: 'failed',
      provider: 'none',
      error: `Invalid recipient email address: '${recipient}'`,
      timestamp: now,
    };
  }
  if (!subject) {
    return {
      success: false,
      delivered: false,
      status: 'failed',
      provider: 'none',
      error: 'Email subject is required',
      timestamp: now,
    };
  }

  const config = getEmailTransportConfig(input.env);
  const queueCollection = input.queueCollection || 'email_queue';
  let queueDocRef: any = null;
  let queueId: string | undefined;

  if (input.db) {
    const record = {
      to: recipient,
      from: config.fromEmail,
      subject,
      html,
      ...(input.text ? { text: input.text } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      provider: config.provider,
      status: config.configured ? 'pending' : 'unconfigured',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    const col = input.db.collection(queueCollection);
    if (typeof col.add === 'function') {
      queueDocRef = await col.add(record);
      queueId = queueDocRef.id;
    } else {
      queueId = `email_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      queueDocRef = col.doc(queueId);
      await queueDocRef.set(record);
    }
  }

  if (!config.configured || !config.apiKey) {
    const errorMsg =
      'Email transport provider is not configured (set SENDGRID_API_KEY or RESEND_API_KEY). Email was NOT delivered.';
    if (queueDocRef && typeof queueDocRef.update === 'function') {
      await queueDocRef.update({
        status: 'unconfigured',
        error: errorMsg,
        updatedAt: new Date().toISOString(),
      });
    } else if (queueDocRef && typeof queueDocRef.set === 'function') {
      await queueDocRef.set({ status: 'unconfigured', error: errorMsg, updatedAt: new Date().toISOString() }, { merge: true });
    }
    return {
      success: false,
      delivered: false,
      status: 'unconfigured',
      provider: 'none',
      queueId,
      error: errorMsg,
      timestamp: now,
    };
  }

  const doFetch = input.fetchFn || fetch;

  try {
    let providerMessageId: string | undefined;

    if (config.provider === 'sendgrid') {
      const sgRes = await doFetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: recipient }] }],
          from: { email: config.fromEmail, name: 'AnyTrader Security & Operations' },
          subject,
          content: [
            ...(input.text ? [{ type: 'text/plain', value: input.text }] : []),
            { type: 'text/html', value: html || `<p>${subject}</p>` },
          ],
        }),
      });
      if (!sgRes.ok) {
        const errBody = await sgRes.text().catch(() => '');
        throw new Error(`SendGrid HTTP ${sgRes.status}: ${errBody.slice(0, 200) || sgRes.statusText}`);
      }
      providerMessageId = sgRes.headers?.get?.('x-message-id') || `sg_${Date.now()}`;
    } else if (config.provider === 'resend') {
      const rsRes = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.fromEmail,
          to: [recipient],
          subject,
          html: html || `<p>${subject}</p>`,
          ...(input.text ? { text: input.text } : {}),
        }),
      });
      const rsJson = await rsRes.json().catch(() => ({} as any));
      if (!rsRes.ok) {
        throw new Error(`Resend HTTP ${rsRes.status}: ${rsJson?.message || rsRes.statusText}`);
      }
      providerMessageId = rsJson?.id || `rs_${Date.now()}`;
    }

    const deliveredAt = new Date().toISOString();
    if (queueDocRef) {
      const updatePatch = {
        status: 'delivered',
        provider: config.provider,
        providerMessageId,
        attempts: 1,
        deliveredAt,
        updatedAt: deliveredAt,
      };
      if (typeof queueDocRef.update === 'function') {
        await queueDocRef.update(updatePatch);
      } else if (typeof queueDocRef.set === 'function') {
        await queueDocRef.set(updatePatch, { merge: true });
      }
    }

    return {
      success: true,
      delivered: true,
      status: 'delivered',
      provider: config.provider,
      queueId,
      providerMessageId,
      timestamp: deliveredAt,
    };
  } catch (err: any) {
    const failedAt = new Date().toISOString();
    const errorMessage = err?.message || 'Email provider delivery failed';
    if (queueDocRef) {
      const failPatch = {
        status: 'failed',
        provider: config.provider,
        attempts: 1,
        error: errorMessage,
        failedAt,
        updatedAt: failedAt,
      };
      if (typeof queueDocRef.update === 'function') {
        await queueDocRef.update(failPatch);
      } else if (typeof queueDocRef.set === 'function') {
        await queueDocRef.set(failPatch, { merge: true });
      }
    }
    return {
      success: false,
      delivered: false,
      status: 'failed',
      provider: config.provider,
      queueId,
      error: errorMessage,
      timestamp: failedAt,
    };
  }
}
