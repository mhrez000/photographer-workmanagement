/**
 * Security notices about an account (docs/ACCOUNTS.md "Emails"): "Your password was changed" and "Your email is
 * being / was changed". Sent through `sendAccountEmail`, so a demo studio never gets one and nothing goes out
 * without an email provider. Call AFTER the transaction that made the change has committed. Never throws for a
 * mail problem; the result says whether it went out.
 *
 *   sendPasswordChangedNotice(db, { userId, via })                       → the account's address
 *       via "changed" (change password, wired in services/auth.ts) · "reset" (reset link, services/passwordReset.ts)
 *       · "set" (a first password added — AREA account calls it)
 *   sendEmailChangedNotice(db, { userId, oldEmail, newEmail, stage })    → the OLD address (AREA account calls it)
 *       stage "requested" when the confirm link goes to the new address · "changed" once it took effect
 *   sendGoogleConnectedNotice(db, { userId, googleEmail })               → the account's address, when Connect Google
 *       linked a Google account (SEC-03: a new way in never appears silently)
 */
import { eq } from "drizzle-orm";
import { first, type DbLike } from "@/db/index";
import { organisationSettings, users } from "@/db/schema";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { nowIso } from "@/server/clock";
import { sendAccountEmail, type AccountEmailOptions, type AccountEmailResult } from "@/server/email/account";
import { emailChangedNoticeEmail, googleConnectedNoticeEmail, passwordChangedNoticeEmail } from "@/server/email/templates";

async function recipient(db: DbLike, userId: string): Promise<{ name: string; email: string; timezone: string } | null> {
  const row = await first(
    db
      .select({ name: users.name, email: users.email, timezone: organisationSettings.timezone })
      .from(users)
      .leftJoin(organisationSettings, eq(organisationSettings.organisationId, users.organisationId))
      .where(eq(users.id, userId)),
  );
  return row ? { name: row.name, email: row.email, timezone: row.timezone ?? DEFAULT_TIMEZONE } : null;
}

/** "Your Proofline password was changed" / "A password was added…" to the account's own address. */
export async function sendPasswordChangedNotice(
  db: DbLike,
  input: { userId: string; via: "changed" | "reset" | "set" },
  opts: AccountEmailOptions = {},
): Promise<AccountEmailResult> {
  const who = await recipient(db, input.userId);
  if (!who) return { sent: false, reason: "failed" };
  const content = passwordChangedNoticeEmail({ name: who.name, via: input.via, at: nowIso(), timezone: who.timezone });
  return sendAccountEmail(db, { userId: input.userId, to: who.email, content }, opts);
}

/** "Google sign-in was added to your Proofline account" to the account's own address (SEC-03: Connect Google). */
export async function sendGoogleConnectedNotice(
  db: DbLike,
  input: { userId: string; googleEmail: string },
  opts: AccountEmailOptions = {},
): Promise<AccountEmailResult> {
  const who = await recipient(db, input.userId);
  if (!who) return { sent: false, reason: "failed" };
  const content = googleConnectedNoticeEmail({ name: who.name, googleEmail: input.googleEmail, at: nowIso(), timezone: who.timezone });
  return sendAccountEmail(db, { userId: input.userId, to: who.email, content }, opts);
}

/** The email-change notice, to the OLD address (`oldEmail`). */
export async function sendEmailChangedNotice(
  db: DbLike,
  input: { userId: string; oldEmail: string; newEmail: string; stage: "requested" | "changed" },
  opts: AccountEmailOptions = {},
): Promise<AccountEmailResult> {
  const who = await recipient(db, input.userId);
  if (!who) return { sent: false, reason: "failed" };
  const content = emailChangedNoticeEmail({ name: who.name, newEmail: input.newEmail, stage: input.stage, at: nowIso(), timezone: who.timezone });
  return sendAccountEmail(db, { userId: input.userId, to: input.oldEmail, content }, opts);
}
