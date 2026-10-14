/**
 * Pluggable outbound email (front door: invite links, password resets).
 *
 * Provider selection (`emailConfig()`):
 *   - "resend"  when RESEND_API_KEY and EMAIL_FROM are both set — sends through the `resend` SDK
 *   - "console" otherwise (local dev / tests) — logs ONE line (recipient + subject, never the body or a
 *     token); the UI shows the copyable link instead
 *
 * `sendEmail()` never throws into a request: a provider failure is logged and returned as `{ ok: false }`,
 * so an invite or reset still succeeds and the caller can fall back to the copyable link.
 * In-app notifications are NOT delivered by email yet (`organisation_settings.email_notifications_enabled`
 * is reserved); a NotificationChannel built on `sendEmail` would plug into
 * `registerNotificationChannel()` (src/server/services/notifications.ts).
 */
import { Resend } from "resend";

export type EmailProvider = "resend" | "console";

export interface EmailConfig {
  provider: EmailProvider;
  /** Sender ("Proofline <hello@example.com>" or a bare address); null for the console provider. */
  from: string | null;
  /** True when real emails go out (provider "resend"). */
  configured: boolean;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendEmailResult {
  ok: boolean;
  provider: EmailProvider;
  /** Provider message id when known. */
  id?: string;
  /** Short failure reason (never the message body). */
  error?: string;
}

export interface SendEmailOptions {
  config?: EmailConfig;
  /** Console provider output + failure log (tests inject a spy). Defaults to console.info / console.warn. */
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** Test seam: the resend client factory. */
  resendClient?: (apiKey: string) => Pick<Resend, "emails">;
}

/** Reads the provider configuration from the environment. */
export function emailConfig(env: Readonly<Record<string, string | undefined>> = process.env): EmailConfig {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (apiKey && from) return { provider: "resend", from, configured: true };
  return { provider: "console", from: null, configured: false };
}

/** True when invites / resets are emailed for real. */
export function emailConfigured(env?: Readonly<Record<string, string | undefined>>): boolean {
  return emailConfig(env).configured;
}

function resendApiKey(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.RESEND_API_KEY?.trim() ?? "";
}

/**
 * Sends one email through the configured provider. Resolves (never rejects) with the outcome.
 * The console provider's single log line names the recipient and subject only.
 */
export async function sendEmail(message: EmailMessage, opts: SendEmailOptions = {}): Promise<SendEmailResult> {
  const config = opts.config ?? emailConfig();
  const log = opts.log ?? ((line: string) => console.info(line));
  const warn = opts.warn ?? ((line: string) => console.warn(line));

  if (config.provider === "console") {
    log(`[email] not configured (set RESEND_API_KEY + EMAIL_FROM): would send "${message.subject}" to ${message.to}`);
    return { ok: false, provider: "console", error: "email_not_configured" };
  }

  try {
    const client = (opts.resendClient ?? ((key: string) => new Resend(key)))(resendApiKey());
    const result = await client.emails.send({
      from: config.from as string,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
    if (result.error) {
      warn(`[email] resend rejected "${message.subject}" to ${message.to}: ${result.error.name ?? "error"} ${result.error.message ?? ""}`.trim());
      return { ok: false, provider: "resend", error: result.error.message ?? result.error.name ?? "resend_error" };
    }
    return { ok: true, provider: "resend", id: result.data?.id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`[email] sending "${message.subject}" to ${message.to} failed: ${reason}`);
    return { ok: false, provider: "resend", error: reason };
  }
}
