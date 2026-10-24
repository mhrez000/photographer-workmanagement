/**
 * The demo studio (docs/ACCOUNTS.md "Demo studio"). `organisations.is_demo` marks the seeded Northlight studio and
 * the isolation org. Inside a demo studio:
 *
 *   - no email is ever sent (src/server/email/account.ts suppresses it)
 *   - invites are off, and nobody can change a password, an email, a sign-in method, sign out other devices or
 *     reset another person's password — `assertNotDemo(ctx, what)` in each of those services
 *   - the four persona accounts (DEMO_ACCOUNTS) cannot be deactivated, re-roled or switched (they are the demo)
 *   - the sign-in page offers one button per persona (POST /api/auth/demo) instead of showing emails / passwords
 *
 * `ctx.isDemo` is set by every context builder (src/server/auth/session.ts).
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { first, type DbLike } from "@/db/index";
import { organisations, users } from "@/db/schema";
import { DEMO_ACCOUNTS, DEMO_SIGN_IN_ENV, type DemoPersona } from "@/lib/constants";
import type { AuthContext, User } from "@/lib/types";
import { ForbiddenError } from "@/server/errors";

/** What a demo studio blocks. The 403's action is `demo.<what>`. */
export type DemoBlockedAction = "invite" | "password" | "email" | "sign_in_methods" | "sessions" | "reset_password" | "demo_accounts";

/** The plain-words 403 messages (shown as-is by the forms and toasts). */
export const DEMO_BLOCKED_MESSAGES: Readonly<Record<DemoBlockedAction, string>> = {
  invite: "Invites are turned off in the demo studio",
  password: "Passwords can't be changed in the demo studio",
  email: "Email addresses can't be changed in the demo studio",
  sign_in_methods: "Sign-in methods can't be changed in the demo studio",
  sessions: "Logging out of other devices is turned off in the demo studio",
  reset_password: "Passwords can't be reset in the demo studio",
  demo_accounts: "The demo accounts can't be changed. Create your own studio to try this.",
};

/** Throws a 403 with plain copy when `ctx` belongs to the demo studio. */
export function assertNotDemo(ctx: Pick<AuthContext, "isDemo">, what: DemoBlockedAction): void {
  if (ctx.isDemo) throw new ForbiddenError(`demo.${what}`, DEMO_BLOCKED_MESSAGES[what]);
}

/** `organisations.is_demo` for one organisation (false when it does not exist). */
export async function isDemoOrganisation(db: DbLike, organisationId: string): Promise<boolean> {
  const row = await first(db.select({ isDemo: organisations.isDemo }).from(organisations).where(eq(organisations.id, organisationId)));
  return row?.isDemo ?? false;
}

/** Demo sign-in is on unless `DEMO_SIGN_IN=off` (also "false" / "0" / "no"). */
export function demoSignInEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const raw = env[DEMO_SIGN_IN_ENV]?.trim().toLowerCase();
  return !(raw === "off" || raw === "false" || raw === "0" || raw === "no");
}

const DEMO_EMAILS: ReadonlySet<string> = new Set(DEMO_ACCOUNTS.map((a) => a.email));

/** Is this one of the four demo persona addresses (DEMO_ACCOUNTS)? */
export function isDemoPersonaEmail(email: string): boolean {
  return DEMO_EMAILS.has(email.trim().toLowerCase());
}

/**
 * The seeded user behind a demo persona: the DEMO_ACCOUNTS address, active, accepted, not anonymised, and in an
 * `is_demo` organisation. Never anyone else — a real studio's user with a look-alike address is not a demo user.
 */
export async function findDemoPersonaUser(db: DbLike, persona: DemoPersona): Promise<User | null> {
  const account = DEMO_ACCOUNTS.find((a) => a.persona === persona);
  if (!account) return null;
  const row = await first(
    db
      .select({ user: users })
      .from(users)
      .innerJoin(organisations, eq(organisations.id, users.organisationId))
      .where(
        and(
          eq(users.email, account.email),
          eq(organisations.isDemo, true),
          eq(users.isActive, true),
          isNull(users.anonymisedAt),
          isNotNull(users.acceptedAt),
        ),
      ),
  );
  return row?.user ?? null;
}

/**
 * In a demo studio: does the Client persona belong to this client? Then the client's portal can't be switched off and
 * the client can't be archived (SEC-07 / DEMO-01): either would sign every "Look around as Client" visitor out and
 * break that button for everyone.
 */
export async function isDemoPersonaClient(db: DbLike, ctx: Pick<AuthContext, "isDemo" | "organisationId">, clientId: string): Promise<boolean> {
  if (!ctx.isDemo) return false;
  const persona = DEMO_ACCOUNTS.find((a) => a.persona === "client");
  if (!persona) return false;
  const row = await first(
    db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.organisationId, ctx.organisationId), eq(users.clientId, clientId), eq(users.email, persona.email))),
  );
  return row !== undefined;
}

/** 403 `demo.demo_accounts` (plain copy) when `clientId` is the demo Client persona's client. */
export async function assertNotDemoPersonaClient(db: DbLike, ctx: Pick<AuthContext, "isDemo" | "organisationId">, clientId: string): Promise<void> {
  if (await isDemoPersonaClient(db, ctx, clientId)) assertNotDemo(ctx, "demo_accounts");
}

/** Should the sign-in page offer the "Look around the demo" panel? (enabled + the demo owner exists) */
export async function demoSignInAvailable(db: DbLike, env: Readonly<Record<string, string | undefined>> = process.env): Promise<boolean> {
  if (!demoSignInEnabled(env)) return false;
  return (await findDemoPersonaUser(db, "owner")) !== null;
}
