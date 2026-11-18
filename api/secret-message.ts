import process from 'node:process';
import nodemailer from 'nodemailer';

const DEFAULT_RECIPIENT = 'akramjonabduhakimov1@gmail.com';
const MAX_MESSAGE_LENGTH = 2000;
const REQUEST_TIMEOUT_MS = 10000;

interface ApiRequest {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  on?: (event: string, listener: (chunk: Uint8Array | string) => void) => void;
}

interface ApiResponse {
  status: (statusCode: number) => ApiResponse;
  json: (body: unknown) => void;
  end?: () => void;
}

interface SendOutcome {
  ok: boolean;
  status: number;
  provider?: string;
  id?: string;
  code?: string;
  error?: string;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildEmailHtml(message: string): string {
  const safeMessage = escapeHtml(message);
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background-color:#05060c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f1f5f9;">
    <div style="max-width:560px;margin:0 auto;border:1px solid rgba(255,255,255,0.12);border-radius:16px;background-color:#0b0e1c;padding:28px;">
      <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#fda4af;">For Hamidabonu</p>
      <h1 style="margin:0 0 20px;font-size:24px;font-weight:500;color:#ffffff;">Secret message</h1>
      <div style="border-radius:12px;background-color:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);padding:18px;font-size:15px;line-height:1.65;color:#e2e8f0;white-space:pre-wrap;">${safeMessage}</div>
    </div>
  </body>
</html>`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonBody(req: ApiRequest): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object' && !(req.body instanceof Uint8Array)) {
    return req.body as Record<string, unknown>;
  }

  if (typeof req.body === 'string') {
    return (JSON.parse(req.body) as Record<string, unknown>) || {};
  }

  if (req.body instanceof Uint8Array) {
    const decoded = new TextDecoder().decode(req.body);
    return decoded.trim() ? ((JSON.parse(decoded) as Record<string, unknown>) || {}) : {};
  }

  if (!req.on) {
    return {};
  }

  const decoder = new TextDecoder();
  const raw = await new Promise<string>((resolve, reject) => {
    let text = '';
    req.on?.('data', (chunk) => {
      text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    });
    req.on?.('end', () => {
      text += decoder.decode();
      resolve(text);
    });
    req.on?.('error', (err) => reject(err));
  });

  if (!raw.trim()) {
    return {};
  }

  return (JSON.parse(raw) as Record<string, unknown>) || {};
}

async function sendViaTelegram(
  botToken: string,
  chatId: string,
  message: string,
): Promise<SendOutcome> {
  const response = await fetchWithTimeout(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: `Secret message (For Hamidabonu)\n\n${message}`,
        disable_web_page_preview: true,
      }),
    },
    REQUEST_TIMEOUT_MS,
  );

  const data = (await response.json().catch(() => null)) as
    | { ok?: boolean; result?: { message_id?: number }; description?: string }
    | null;

  if (!response.ok || !data?.ok) {
    return {
      ok: false,
      status: response.status >= 400 ? response.status : 502,
      error: data?.description || 'Could not send message via Telegram.',
    };
  }

  return {
    ok: true,
    status: 200,
    provider: 'telegram',
    ...(data.result?.message_id !== undefined
      ? { id: String(data.result.message_id) }
      : {}),
  };
}

async function sendViaWeb3Forms(
  accessKey: string,
  message: string,
): Promise<SendOutcome> {
  const response = await fetchWithTimeout(
    'https://api.web3forms.com/submit',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        access_key: accessKey,
        name: 'Hamidabonu',
        from_name: 'For Hamidabonu',
        subject: 'Secret message',
        message,
      }),
    },
    REQUEST_TIMEOUT_MS,
  );

  const data = (await response.json().catch(() => null)) as
    | { success?: boolean; message?: string }
    | null;

  if (!response.ok || !data?.success) {
    return {
      ok: false,
      status: response.status >= 400 ? response.status : 502,
      error: data?.message || 'Could not send email via Web3Forms.',
    };
  }

  return { ok: true, status: 200, provider: 'web3forms' };
}

async function sendViaBrevo(
  apiKey: string,
  senderEmail: string,
  recipient: string,
  message: string,
): Promise<SendOutcome> {
  const response = await fetchWithTimeout(
    'https://api.brevo.com/v3/smtp/email',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        sender: {
          name: 'For Hamidabonu',
          email: senderEmail,
        },
        to: [{ email: recipient }],
        subject: 'Secret message',
        textContent: `From: Hamidabonu\n\n${message}`,
        htmlContent: buildEmailHtml(message),
      }),
    },
    REQUEST_TIMEOUT_MS,
  );

  const data = (await response.json().catch(() => null)) as
    | { messageId?: string; message?: string }
    | null;

  if (!response.ok) {
    return {
      ok: false,
      status: response.status >= 400 ? response.status : 502,
      error: data?.message || 'Could not send email via Brevo.',
    };
  }

  return { ok: true, status: 200, provider: 'brevo', id: data?.messageId };
}

async function sendViaGmailSmtp(
  gmailUser: string,
  gmailAppPassword: string,
  recipient: string,
  message: string,
): Promise<SendOutcome> {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: gmailUser,
      pass: gmailAppPassword.replace(/\s+/g, ''),
    },
    connectionTimeout: REQUEST_TIMEOUT_MS,
    greetingTimeout: REQUEST_TIMEOUT_MS,
    socketTimeout: REQUEST_TIMEOUT_MS,
  });

  const info = await transporter.sendMail({
    from: `For Hamidabonu <${gmailUser}>`,
    to: recipient,
    subject: 'Secret message',
    text: `From: Hamidabonu\n\n${message}`,
    html: buildEmailHtml(message),
  });

  return { ok: true, status: 200, provider: 'gmail', id: info.messageId };
}

async function dispatchSecretMessage(message: string): Promise<SendOutcome> {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const telegramChatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (telegramBotToken && telegramChatId) {
    return sendViaTelegram(telegramBotToken, telegramChatId, message);
  }

  const recipient =
    process.env.SECRET_MESSAGE_RECIPIENT_EMAIL?.trim() || DEFAULT_RECIPIENT;

  const web3formsKey = process.env.WEB3FORMS_ACCESS_KEY?.trim();
  if (web3formsKey) {
    return sendViaWeb3Forms(web3formsKey, message);
  }

  const brevoApiKey = process.env.BREVO_API_KEY?.trim();
  if (brevoApiKey) {
    const senderEmail = process.env.BREVO_FROM_EMAIL?.trim() || recipient;
    return sendViaBrevo(brevoApiKey, senderEmail, recipient, message);
  }

  const gmailUser = process.env.GMAIL_USER?.trim();
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD?.trim();
  if (gmailUser && gmailAppPassword) {
    return sendViaGmailSmtp(gmailUser, gmailAppPassword, recipient, message);
  }

  if (telegramBotToken || telegramChatId) {
    return {
      ok: false,
      status: 503,
      code: 'INCOMPLETE_TELEGRAM_CONFIG',
      error: 'Both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be configured on the server.',
    };
  }

  if (gmailUser || gmailAppPassword) {
    return {
      ok: false,
      status: 503,
      code: 'INCOMPLETE_GMAIL_CONFIG',
      error: 'Both GMAIL_USER and GMAIL_APP_PASSWORD must be configured on the server.',
    };
  }

  return {
    ok: false,
    status: 503,
    code: 'MISSING_DELIVERY_PROVIDER',
    error:
      'Delivery is not configured on the server. Add TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (or WEB3FORMS_ACCESS_KEY, BREVO_API_KEY, or GMAIL_USER + GMAIL_APP_PASSWORD).',
  };
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === 'OPTIONS') {
    res.status(204).end?.();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    res.status(400).json({ ok: false, error: 'Invalid request body.' });
    return;
  }

  const rawMessage = typeof body.message === 'string' ? body.message : '';
  const trimmedMessage = rawMessage.trim();

  if (!trimmedMessage) {
    res.status(400).json({ ok: false, error: 'Please write a message before sending.' });
    return;
  }

  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    res.status(400).json({
      ok: false,
      error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`,
    });
    return;
  }

  try {
    const outcome = await dispatchSecretMessage(trimmedMessage);
    if (!outcome.ok) {
      res.status(outcome.status).json({
        ok: false,
        ...(outcome.code ? { code: outcome.code } : {}),
        error: outcome.error || 'Could not send message.',
      });
      return;
    }

    res.status(200).json({
      ok: true,
      provider: outcome.provider,
      ...(outcome.id ? { id: outcome.id } : {}),
    });
  } catch (error) {
    const detail =
      error instanceof Error && error.name === 'AbortError'
        ? 'Delivery provider request timed out. Please try again in a moment.'
        : 'Could not send right now. Please try again in a moment.';
    res.status(502).json({
      ok: false,
      error: detail,
    });
  }
}
