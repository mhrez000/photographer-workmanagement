/**
 * Email templates for the front door (plain text + minimal HTML). Pure module.
 * Plain words only (SIMPLIFICATION-PLAN glossary): "studio", "editor", "photographer", "owner", "client".
 */
import { INVITE_TTL_HOURS, RESET_TTL_MINUTES, type Persona } from "@/lib/constants";
import { DEFAULT_TIMEZONE, formatDateTime } from "@/lib/dates";

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

/** HTML-escapes text that goes into a template. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The role in plain words, with its article ("an editor"). */
export function roleInPlainWords(persona: Persona): string {
  switch (persona) {
    case "admin":
      return "an owner";
    case "member":
      return "a photographer";
    case "editor":
      return "an editor";
    case "client":
      return "a client (portal access)";
  }
}

function layout(title: string, bodyHtml: string, footer: string): string {
  return [
    `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">`,
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">`,
    `<h1 style="font-size:20px;margin:0 0 16px;">${escapeHtml(title)}</h1>`,
    bodyHtml,
    `<p style="font-size:12px;color:#6b7280;margin:24px 0 0;">${escapeHtml(footer)}</p>`,
    `</div></body></html>`,
  ].join("");
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">${escapeHtml(label)}</a></p><p style="font-size:13px;color:#6b7280;">Or copy this link into your browser:<br><a href="${escapeHtml(href)}" style="color:#2563eb;word-break:break-all;">${escapeHtml(href)}</a></p>`;
}

export interface InviteEmailInput {
  studioName: string;
  inviterName: string;
  persona: Persona;
  inviteUrl: string;
  expiresAt: string;
  timezone?: string;
}

/** "You're invited to join <studio> on Proofline". */
export function inviteEmail(input: InviteEmailInput): EmailContent {
  const role = roleInPlainWords(input.persona);
  const expires = formatDateTime(input.expiresAt, input.timezone ?? DEFAULT_TIMEZONE);
  const days = Math.round(INVITE_TTL_HOURS / 24);
  const subject = `${input.inviterName} invited you to ${input.studioName} on Proofline`;
  const text = [
    `Hi,`,
    ``,
    `${input.inviterName} has invited you to join ${input.studioName} on Proofline as ${role}.`,
    ``,
    `Open this link to choose a password and get started:`,
    input.inviteUrl,
    ``,
    `The link works for ${days} days (until ${expires}). If it has expired, ask ${input.inviterName} to send a new one.`,
    ``,
    `If you were not expecting this, you can ignore this email.`,
  ].join("\n");
  const html = layout(
    `Join ${input.studioName} on Proofline`,
    `<p>${escapeHtml(input.inviterName)} has invited you to join <strong>${escapeHtml(input.studioName)}</strong> as ${escapeHtml(role)}.</p>` +
      `<p>Open the link to choose a password and get started.</p>` +
      button(input.inviteUrl, "Accept the invite") +
      `<p style="font-size:13px;color:#6b7280;">The link works for ${days} days (until ${escapeHtml(expires)}). If it has expired, ask ${escapeHtml(input.inviterName)} to send a new one.</p>`,
    "If you were not expecting this, you can ignore this email.",
  );
  return { subject, text, html };
}

export interface PasswordResetEmailInput {
  resetUrl: string;
  expiresAt: string;
  timezone?: string;
  studioName?: string | null;
}

/** "Reset your Proofline password". */
export function passwordResetEmail(input: PasswordResetEmailInput): EmailContent {
  const expires = formatDateTime(input.expiresAt, input.timezone ?? DEFAULT_TIMEZONE);
  const where = input.studioName ? ` for ${input.studioName}` : "";
  const subject = "Reset your Proofline password";
  const text = [
    `Hi,`,
    ``,
    `Someone asked to reset the password of your Proofline account${where}. If that was you, open this link to choose a new password:`,
    input.resetUrl,
    ``,
    `The link works for ${RESET_TTL_MINUTES} minutes (until ${expires}) and can be used once.`,
    ``,
    `If you did not ask for this, you can ignore this email: your password stays as it is.`,
  ].join("\n");
  const html = layout(
    "Reset your password",
    `<p>Someone asked to reset the password of your Proofline account${escapeHtml(where)}. If that was you, choose a new password here.</p>` +
      button(input.resetUrl, "Choose a new password") +
      `<p style="font-size:13px;color:#6b7280;">The link works for ${RESET_TTL_MINUTES} minutes (until ${escapeHtml(expires)}) and can be used once.</p>`,
    "If you did not ask for this, you can ignore this email: your password stays as it is.",
  );
  return { subject, text, html };
}
