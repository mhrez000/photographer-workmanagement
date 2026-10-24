/**
 * The ONE way to send an ACCOUNT email (docs/ACCOUNTS.md "Emails"): invite links, password resets, "Confirm your
 * email", "Confirm your new email", the email-changed and password-changed notices. It decides, per message:
 *
 *   1. demo studio (the account's organisation `is_demo`)       → never sent            reason "demo"
 *   2. email not configured (RESEND_API_KEY + EMAIL_FROM)        → console line only     reason "not_configured"
 *   3. `senderUserId` given and that person's email unconfirmed  → not sent (anti-abuse) reason "unconfirmed_sender"
 *   4. otherwise sendEmail → provider rejected / threw           → reason "failed"
 *
 * `devLink` (= the `link` you pass) comes back ONLY outside production and only for "not_configured" / "failed",
 * so local development can follow the flow without a mail provider (the existing DevOnlyLink pattern). Production
 * never gets a link back from here — the owner-facing invite link is the caller's business (deliverInvite).
 *
 * Call it AFTER the transaction that issued the link has committed. It never throws for a mail problem.
 */
import { eq } from "drizzle-orm";
import { first, type DbLike } from "@/db/index";
import { organisations, users } from "@/db/schema";
import { emailConfig, emailConfigured, sendEmail, type EmailMessage, type SendEmailResult } from "./index";
import type { EmailContent } from "./templates";

type Env = Readonly<Record<string, string | undefined>>;

export type AccountEmailNotSentReason = "not_configured" | "demo" | "unconfirmed_sender" | "failed";

export interface AccountEmailResult {
  sent: boolean;
  /** Why nothing went out (null when sent). */
  reason: AccountEmailNotSentReason | null;
  /** Development / test only: the link inside the email, to show instead (never in production). */
  devLink?: string;
}

export interface AccountEmailInput {
  /** The account the email is about: its organisation decides the demo rule; its address is the default recipient. */
  userId: string;
  /** Another recipient (e.g. the NEW address of an email change, the OLD one for the notice). */
  to?: string;
  content: EmailContent;
  /** The one-time link inside, for the development fallback. */
  link?: string;
  /** Suppress when this person's own email is not confirmed (invites / resends sent on their behalf). */
  senderUserId?: string | null;
}

export interface AccountEmailOptions {
  /** Environment (tests): decides "configured" and "production". */
  env?: Env;
  /** Test seam: replaces `sendEmail`. */
  send?: (message: EmailMessage) => Promise<SendEmailResult>;
}

/** Outside production (`NODE_ENV !== "production"`): may a one-time link be handed back to the screen? */
export function devLinksAllowed(env: Env = process.env): boolean {
  return env.NODE_ENV !== "production";
}

/**
 * Why an account email about `userId` (sent on behalf of `senderUserId`) would NOT go out right now — the same
 * decision `sendAccountEmail` makes, without sending. null = it would be sent. Never "failed".
 */
export async function accountEmailBlock(
  db: DbLike,
  input: { userId: string; senderUserId?: string | null },
  opts: Pick<AccountEmailOptions, "env"> = {},
): Promise<Exclude<AccountEmailNotSentReason, "failed"> | null> {
  const row = await first(
    db
      .select({ isDemo: organisations.isDemo })
      .from(users)
      .innerJoin(organisations, eq(organisations.id, users.organisationId))
      .where(eq(users.id, input.userId)),
  );
  if (row?.isDemo) return "demo";
  if (!emailConfigured(opts.env)) return "not_configured";
  if (input.senderUserId) {
    const sender = await first(db.select({ emailVerifiedAt: users.emailVerifiedAt }).from(users).where(eq(users.id, input.senderUserId)));
    if (!sender || sender.emailVerifiedAt === null) return "unconfirmed_sender";
  }
  return null;
}

/** Sends one account email (see the module doc for the rules). Resolves, never rejects. */
export async function sendAccountEmail(db: DbLike, input: AccountEmailInput, opts: AccountEmailOptions = {}): Promise<AccountEmailResult> {
  const env = opts.env ?? process.env;
  const send = opts.send ?? ((message: EmailMessage) => sendEmail(message, { config: emailConfig(env) }));
  const block = await accountEmailBlock(db, input, { env });
  const devLink = devLinksAllowed(env) && input.link ? { devLink: input.link } : {};
  if (block === "demo" || block === "unconfirmed_sender") return { sent: false, reason: block };

  const to = input.to ?? (await first(db.select({ email: users.email }).from(users).where(eq(users.id, input.userId))))?.email;
  if (!to) return { sent: false, reason: "failed", ...devLink };
  if (block === "not_configured") {
    // The console provider logs one line (recipient + subject, never the body or the link).
    await send({ to, subject: input.content.subject, text: input.content.text, html: input.content.html });
    return { sent: false, reason: "not_configured", ...devLink };
  }
  const result = await send({ to, subject: input.content.subject, text: input.content.text, html: input.content.html });
  return result.ok ? { sent: true, reason: null } : { sent: false, reason: "failed", ...devLink };
}
