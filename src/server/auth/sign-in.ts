/**
 * Starting a session (docs/ACCOUNTS.md "Sessions"): the ONE place that stamps `last_login_at`, audits
 * `auth.logged_in` (with `metadata.method`) and issues the session cookie. Every way in uses it: password login
 * (services/auth.ts), invite accept / password reset / sign-up (their own transaction already stamps the row, then
 * `issueSessionCookie`), demo persona sign-in and Google (`startSession`).
 *
 *   recordSignIn(tx, ctx, …)       in-transaction half: last_login_at + auth.logged_in
 *   issueSessionCookie(user)       cookie half (route handlers / server actions only)
 *   startSession(db, …)            both, for an EXISTING account signing in (demo, Google): refuses inactive,
 *                                  anonymised, not-yet-accepted and closed-portal accounts with the generic 401
 */
import { eq } from "drizzle-orm";
import { first, type Db, type Tx } from "@/db/index";
import { users } from "@/db/schema";
import type { Role, SignInMethod } from "@/lib/constants";
import type { AuthContext } from "@/lib/types";
import { recordEvent } from "@/server/audit";
import { UnauthorizedError } from "@/server/errors";
import { currentRequestId, newRequestId } from "@/server/request-scope";
import { withTx } from "@/server/services/_shared";
import { demoSignInEnabled } from "./demo";
import { rememberThisDevice } from "./known-device";
import { buildContextFromDb, createSession, sessionKindForRole } from "./session";

/**
 * The one refusal every sign-in path gives (wrong password, unknown email, deactivated, invite not accepted,
 * client portal off): it never says which.
 */
export const SIGN_IN_REFUSED_MESSAGE = "Incorrect email or password";

/** What the session cookie needs. */
export interface SessionSubject {
  id: string;
  role: Role;
  sessionVersion: number;
  /**
   * The address that just signed in: this browser is remembered as a known device for it (src/server/auth/known-device.ts,
   * SEC-06). Leave it out for the shared demo personas and for a cookie that is only being re-issued.
   */
  email?: string;
  /**
   * When this browser really signed in (epoch seconds; the cookie's `at`). Default now — a real sign-in. A cookie that
   * is only RE-ISSUED without proving who this is ("Log out of other devices") passes the old value on.
   */
  signedInAt?: number | null;
}

/** Sets this browser's session cookie for `user` (kind from the role; `r` landing hint) and, with `email`, remembers the browser. */
export async function issueSessionCookie(user: SessionSubject): Promise<void> {
  // `undefined` → now (createSession's default, the services' clock); `null` → no sign-in time on the cookie.
  await createSession(user.id, user.sessionVersion, sessionKindForRole(user.role), user.role, user.signedInAt);
  if (user.email) await rememberThisDevice(user.email);
}

export interface RecordSignInInput {
  method: SignInMethod;
  ip?: string | null;
  userAgent?: string | null;
  /** Extra audit metadata (keys must not match /password|secret|token/i — the redactor drops them). */
  metadata?: Record<string, unknown>;
}

/**
 * In the caller's transaction: stamps `users.last_login_at = ctx.now()` (an audit exemption, no version bump) and
 * records `auth.logged_in` as the person (`metadata: { method, ip, userAgent, … }`, management visibility).
 */
export async function recordSignIn(tx: Tx, ctx: AuthContext, input: RecordSignInInput): Promise<void> {
  if (!ctx.userId || ctx.isSystem) throw new Error("recordSignIn: needs the signing-in person's own context");
  const user = await first(tx.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId)));
  await tx.update(users).set({ lastLoginAt: ctx.now() }).where(eq(users.id, ctx.userId));
  await recordEvent(tx, ctx, {
    entityType: "auth",
    entityId: ctx.userId,
    eventType: "auth.logged_in",
    action: "logged_in",
    previousValue: null,
    newValue: { email: user?.email ?? null },
    metadata: { ...(input.metadata ?? {}), method: input.method, ip: input.ip ?? null, userAgent: input.userAgent ?? null },
    visibility: "management",
  });
}

export interface StartSessionInput {
  userId: string;
  method: SignInMethod;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export interface StartedSession {
  userId: string;
  organisationId: string;
  name: string;
  email: string;
  role: Role;
  sessionVersion: number;
}

/**
 * Signs an EXISTING account in on this browser (demo persona, Google): the account must be active, not
 * anonymised, accepted (an invitee accepts first) and have a context (a client whose portal is off has none); a
 * person of the demo studio only through the demo buttons while demo sign-in is on (DEMO-02).
 * Otherwise `UnauthorizedError(SIGN_IN_REFUSED_MESSAGE)` — never why. Then `recordSignIn` in its own transaction
 * and the cookie (a real sign-in also marks this browser as known for the address; a demo persona never).
 * Does NOT check a password: the caller has already established who this is.
 */
export async function startSession(db: Db, input: StartSessionInput, opts: { env?: Readonly<Record<string, string | undefined>> } = {}): Promise<StartedSession> {
  const user = await first(db.select().from(users).where(eq(users.id, input.userId)));
  if (!user || !user.isActive || user.anonymisedAt !== null || user.acceptedAt === null) throw new UnauthorizedError(SIGN_IN_REFUSED_MESSAGE);
  const requestId = input.requestId ?? currentRequestId() ?? newRequestId();
  const ctx = await buildContextFromDb(db, user.id, { sessionVersion: user.sessionVersion, requestId, cause: "user" });
  if (!ctx) throw new UnauthorizedError(SIGN_IN_REFUSED_MESSAGE);
  if (ctx.isDemo && (input.method !== "demo" || !demoSignInEnabled(opts.env))) throw new UnauthorizedError(SIGN_IN_REFUSED_MESSAGE);
  await withTx((tx) => recordSignIn(tx, ctx, { method: input.method, ip: input.ip, userAgent: input.userAgent, metadata: input.metadata }), { db });
  await issueSessionCookie({ id: user.id, role: user.role, sessionVersion: user.sessionVersion, ...(input.method === "demo" ? {} : { email: user.email }) });
  return { userId: user.id, organisationId: user.organisationId, name: user.name, email: user.email, role: user.role, sessionVersion: user.sessionVersion };
}
