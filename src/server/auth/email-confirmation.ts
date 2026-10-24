/**
 * Email confirmation state (`users.email_verified_at`, docs/ACCOUNTS.md "Email confirmation"). Shared by every flow
 * that proves the person owns their address — a "Confirm your email" link, accepting an invite, completing a
 * password reset, Google sign-in, confirming an email change — and by every flow that changes the address.
 *
 * In-transaction helpers: call them inside the caller's `withTx`, with the caller's context.
 */
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { first, type Tx } from "@/db/index";
import { authTokens, users } from "@/db/schema";
import type { EmailConfirmationVia } from "@/lib/constants";
import type { AuthContext } from "@/lib/types";
import { recordEvent } from "@/server/audit";
import { consumeLiveTokens } from "./tokens";

/**
 * Marks `userId`'s CURRENT email as confirmed (`email_verified_at = ctx.now()`), consumes their live `email_verify`
 * links and audits `user.email_confirmed` (`metadata.via`). Returns false (and writes nothing) when the email was
 * already confirmed or the user is not in `ctx`'s organisation. `users.version` is not bumped (like
 * `last_login_at`, it is not a profile edit).
 */
export async function markEmailConfirmed(tx: Tx, ctx: AuthContext, input: { userId: string; via: EmailConfirmationVia }): Promise<boolean> {
  const user = await first(
    tx
      .select({ id: users.id, email: users.email, name: users.name, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(and(eq(users.id, input.userId), eq(users.organisationId, ctx.organisationId))),
  );
  if (!user || user.emailVerifiedAt !== null) return false;
  const now = ctx.now();
  const updated = await tx
    .update(users)
    .set({ emailVerifiedAt: now })
    .where(and(eq(users.id, user.id), isNull(users.emailVerifiedAt)))
    .returning({ id: users.id });
  if (updated.length === 0) return false;
  const consumed = await consumeLiveTokens(tx, user.id, "email_verify", now);
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: user.id,
    eventType: "user.email_confirmed",
    action: "confirmed",
    previousValue: { emailVerifiedAt: null },
    newValue: { emailVerifiedAt: now, email: user.email, name: user.name },
    metadata: { targetUserId: user.id, via: input.via, linksClosed: consumed },
    visibility: "management",
  });
  return true;
}

/**
 * The address changed (or is about to): it is no longer confirmed. Sets `email_verified_at = null` and consumes
 * every live link that went to the OLD address — `email_verify`, `email_change` AND `password_reset` (SEC-08: a reset
 * link sitting in the old mailbox must not take the account over, nor "confirm" the new address it never reached).
 * Writes no event: the caller's own event (`user.updated` / `user.email_changed`) records the change.
 */
export async function clearEmailConfirmation(tx: Tx, input: { userId: string; now: string }): Promise<void> {
  await tx.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, input.userId));
  await tx
    .update(authTokens)
    .set({ usedAt: input.now })
    .where(
      and(
        eq(authTokens.userId, input.userId),
        inArray(authTokens.kind, ["email_verify", "email_change", "password_reset"]),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, input.now),
      ),
    );
}
