/**
 * Reads for the account screens (docs/ACCOUNTS-PLAN.md §3, §6):
 *
 *   getAccountSecurity(db, ctx)     the "Sign-in & security" section of Settings → My account and /portal/account
 *   accountBannerState(viewer)      the quiet banners above every signed-in page (demo studio / confirm your email)
 *   accountPathFor(role)            "/settings/account" (staff) or "/portal/account" (clients)
 *
 * Self only: every value is about the signed-in person. Pure reads (no audit).
 */
import { and, eq } from "drizzle-orm";
import { first, type DbLike } from "@/db/index";
import { users } from "@/db/schema";
import type { AccountSurface, Role } from "@/lib/constants";
import type { AccountBannerState, AccountSecurityOverview, AuthContext } from "@/lib/types";
import { googleAuthConfig } from "@/server/auth/google-config";
import { hasUsablePassword } from "@/server/auth/password";
import { latestLiveToken } from "@/server/auth/tokens";
import { nowIso } from "@/server/clock";
import { emailConfigured } from "@/server/email";
import { NotFoundError, UnauthorizedError } from "@/server/errors";

type Env = Readonly<Record<string, string | undefined>>;

/** Clients manage their account in the portal; everyone else in Settings → My account. */
export function accountSurfaceFor(role: Role): AccountSurface {
  return role === "client" ? "portal" : "staff";
}

/** "/portal/account" for clients, "/settings/account" for staff. */
export function accountPathFor(role: Role): string {
  return role === "client" ? "/portal/account" : "/settings/account";
}

/** The signed-in person's sign-in & security overview (email, confirmation, password, Google, pending change). */
export async function getAccountSecurity(db: DbLike, ctx: AuthContext, env: Env = process.env): Promise<AccountSecurityOverview> {
  if (!ctx.userId || ctx.isSystem) throw new UnauthorizedError();
  const user = await first(db.select().from(users).where(and(eq(users.id, ctx.userId), eq(users.organisationId, ctx.organisationId))));
  if (!user) throw new NotFoundError("User");
  const pending = await latestLiveToken(db, user.id, "email_change", nowIso());
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt,
    emailConfigured: emailConfigured(env),
    isDemo: ctx.isDemo ?? false,
    // The stored hash decides (DATA-04), not only the flag.
    hasPassword: hasUsablePassword(user),
    google: {
      configured: googleAuthConfig(env) !== null,
      connected: user.googleSub !== null,
      email: user.googleEmail,
    },
    pendingEmailChange: pending?.targetEmail ? { newEmail: pending.targetEmail, expiresAt: pending.expiresAt } : null,
    surface: accountSurfaceFor(user.role),
    accountPath: accountPathFor(user.role),
    timezone: ctx.settings.timezone,
  };
}

/**
 * What the banners above a signed-in page show. The demo banner in a demo studio; otherwise "Please confirm your
 * email" only while the email is unconfirmed AND email is configured (without a provider the feature is invisible).
 */
export function accountBannerState(
  viewer: { role: Role; email: string; isDemo: boolean; emailVerifiedAt: string | null },
  env: Env = process.env,
): AccountBannerState {
  const accountPath = accountPathFor(viewer.role);
  const unconfirmed = !viewer.isDemo && viewer.emailVerifiedAt === null && emailConfigured(env);
  return {
    demo: viewer.isDemo,
    unconfirmedEmail: unconfirmed ? viewer.email : null,
    accountHref: `${accountPath}#email`,
    surface: accountSurfaceFor(viewer.role),
  };
}
