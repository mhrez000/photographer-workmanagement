/**
 * Email templates for the front door and accounts (plain text + minimal HTML). Pure module.
 * Plain words only (SIMPLIFICATION-PLAN glossary): "studio", "editor", "photographer", "owner", "client".
 */
import { EMAIL_CHANGE_TTL_HOURS, EMAIL_VERIFY_TTL_HOURS, INVITE_TTL_HOURS, RESET_TTL_MINUTES, type Persona } from "@/lib/constants";
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

/* ------------------------------------------------------------------ */
/*  Accounts (docs/ACCOUNTS.md): confirm email, email change, notices   */
/* ------------------------------------------------------------------ */

/** A short, quiet paragraph (HTML). */
function note(text: string): string {
  return `<p style="font-size:13px;color:#6b7280;">${escapeHtml(text)}</p>`;
}

function hours(minutes: number): string {
  const h = Math.round(minutes / 60);
  return h === 1 ? "an hour" : `${h} hours`;
}

export interface ConfirmEmailInput {
  name: string;
  confirmUrl: string;
  expiresAt: string;
  timezone?: string;
  studioName?: string | null;
}

/** "Confirm your email for Proofline" — sent after sign-up and on "Send again". */
export function confirmEmailEmail(input: ConfirmEmailInput): EmailContent {
  const expires = formatDateTime(input.expiresAt, input.timezone ?? DEFAULT_TIMEZONE);
  const lasts = hours(EMAIL_VERIFY_TTL_HOURS * 60);
  const where = input.studioName ? ` for ${input.studioName}` : "";
  const subject = "Confirm your email for Proofline";
  const text = [
    `Hi ${input.name},`,
    ``,
    `Please confirm this is your email address for your Proofline account${where}. Open this link and press "Confirm my email":`,
    input.confirmUrl,
    ``,
    `The link works for ${lasts} (until ${expires}). You can ask for a new one from your account at any time.`,
    ``,
    `If you did not create a Proofline account, you can ignore this email.`,
  ].join("\n");
  const html = layout(
    "Confirm your email",
    `<p>Hi ${escapeHtml(input.name)},</p>` +
      `<p>Please confirm this is your email address for your Proofline account${escapeHtml(where)}.</p>` +
      button(input.confirmUrl, "Confirm my email") +
      note(`The link works for ${lasts} (until ${expires}). You can ask for a new one from your account at any time.`),
    "If you did not create a Proofline account, you can ignore this email.",
  );
  return { subject, text, html };
}

export interface ConfirmNewEmailInput {
  name: string;
  newEmail: string;
  confirmUrl: string;
  expiresAt: string;
  timezone?: string;
}

/** "Confirm your new email address" — sent to the NEW address of an email change. */
export function confirmNewEmailEmail(input: ConfirmNewEmailInput): EmailContent {
  const expires = formatDateTime(input.expiresAt, input.timezone ?? DEFAULT_TIMEZONE);
  const lasts = hours(EMAIL_CHANGE_TTL_HOURS * 60);
  const subject = "Confirm your new email address for Proofline";
  const text = [
    `Hi ${input.name},`,
    ``,
    `You asked to use ${input.newEmail} for your Proofline account. Open this link and press "Confirm my new email" to finish:`,
    input.confirmUrl,
    ``,
    `Nothing changes until you do. The link works for ${lasts} (until ${expires}).`,
    ``,
    `If you did not ask for this, you can ignore this email.`,
  ].join("\n");
  const html = layout(
    "Confirm your new email address",
    `<p>Hi ${escapeHtml(input.name)},</p>` +
      `<p>You asked to use <strong>${escapeHtml(input.newEmail)}</strong> for your Proofline account.</p>` +
      button(input.confirmUrl, "Confirm my new email") +
      note(`Nothing changes until you do. The link works for ${lasts} (until ${expires}).`),
    "If you did not ask for this, you can ignore this email.",
  );
  return { subject, text, html };
}

export interface EmailChangedNoticeInput {
  name: string;
  newEmail: string;
  /** "requested": a link went to the new address (nothing changed yet); "changed": the address now IS the new one. */
  stage: "requested" | "changed";
  /** When it happened (ISO). */
  at: string;
  timezone?: string;
}

/** Sent to the OLD address of an email change: when it is asked for, and when it takes effect. */
export function emailChangedNoticeEmail(input: EmailChangedNoticeInput): EmailContent {
  const when = formatDateTime(input.at, input.timezone ?? DEFAULT_TIMEZONE);
  const requested = input.stage === "requested";
  const subject = requested ? "Someone asked to change your Proofline email" : "Your Proofline email was changed";
  const what = requested
    ? `Someone signed in to your Proofline account asked to change its email to ${input.newEmail} (${when}). Nothing changes until the link we sent to ${input.newEmail} is opened.`
    : `The email address of your Proofline account was changed to ${input.newEmail} (${when}). We will use that address from now on.`;
  const ifNot = requested
    ? "If this wasn't you, sign in and change your password now: that cancels the change."
    : "If this wasn't you, contact your studio straight away so they can put your old address back.";
  const text = [`Hi ${input.name},`, ``, what, ``, ifNot].join("\n");
  const html = layout(requested ? "Email change requested" : "Your email was changed", `<p>Hi ${escapeHtml(input.name)},</p><p>${escapeHtml(what)}</p>`, ifNot);
  return { subject, text, html };
}

export interface PasswordChangedNoticeInput {
  name: string;
  /** "changed": with the current password · "reset": through a reset link · "set": a first password was added. */
  via: "changed" | "reset" | "set";
  /** When it happened (ISO). */
  at: string;
  timezone?: string;
}

/** "Your Proofline password was changed" (or "A password was added…"), sent to the account's address. */
export function passwordChangedNoticeEmail(input: PasswordChangedNoticeInput): EmailContent {
  const when = formatDateTime(input.at, input.timezone ?? DEFAULT_TIMEZONE);
  const added = input.via === "set";
  const subject = added ? "A password was added to your Proofline account" : "Your Proofline password was changed";
  const what = added
    ? `A password was added to your Proofline account (${when}). You can now sign in with your email and that password too.`
    : input.via === "reset"
      ? `The password of your Proofline account was reset with a reset link (${when}). Every other device was logged out.`
      : `The password of your Proofline account was changed (${when}). Every other device was logged out.`;
  const ifNot = "If this wasn't you, reset your password straight away from the sign-in page (\"Forgot password?\"), or contact your studio.";
  const text = [`Hi ${input.name},`, ``, what, ``, ifNot].join("\n");
  const html = layout(added ? "A password was added" : "Your password was changed", `<p>Hi ${escapeHtml(input.name)},</p><p>${escapeHtml(what)}</p>`, ifNot);
  return { subject, text, html };
}

export interface GoogleConnectedNoticeInput {
  name: string;
  /** The Google account that can now sign in. */
  googleEmail: string;
  /** When it happened (ISO). */
  at: string;
  timezone?: string;
}

/**
 * "Google sign-in was added to your Proofline account" (SEC-03), to the account's own address: a new way in must
 * never appear silently.
 */
export function googleConnectedNoticeEmail(input: GoogleConnectedNoticeInput): EmailContent {
  const when = formatDateTime(input.at, input.timezone ?? DEFAULT_TIMEZONE);
  const subject = "Google sign-in was added to your Proofline account";
  const what = `The Google account ${input.googleEmail} can now sign in to your Proofline account (${when}).`;
  const ifNot =
    "If this wasn't you, sign in, open My account, press Disconnect next to Google and change your password — or reset it from the sign-in page (\"Forgot password?\"), or contact your studio.";
  const text = [`Hi ${input.name},`, ``, what, ``, ifNot].join("\n");
  const html = layout("Google sign-in was added", `<p>Hi ${escapeHtml(input.name)},</p><p>${escapeHtml(what)}</p>`, ifNot);
  return { subject, text, html };
}
