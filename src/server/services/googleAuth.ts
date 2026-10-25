/**
 * "Continue with Google" (docs/ACCOUNTS.md §1, §8 B; contract docs/ACCOUNTS-PLAN.md §4 AREA google). The protocol
 * lives in src/server/auth/google-oidc.ts; this file decides what a verified Google identity means for Proofline.
 *
 *   beginGoogleSignIn(req, raw, deps)       GET /api/auth/google/start: state + nonce + PKCE in a signed, httpOnly,
 *                                           10-minute cookie (`GOOGLE_OAUTH_COOKIE`, purpose "google_oauth") and the
 *                                           Google URL. `googleStartRedirect` = the same, never throwing (route).
 *                                           Never for "connect": a GET lands back on the account page's card.
 *   beginGoogleConnect(db, req, ctx, raw)   POST /api/auth/google/connect `{ password }`: Connect Google on My account
 *                                           — the current password first (SEC-03), then the same round trip.
 *   handleGoogleCallback(db, req, deps)     GET /api/auth/google/callback → `{ location }` (+ the session cookie).
 *                                           Never throws: every failure lands on a page with `?google=<result>`.
 *   completeGoogleSignUp(db, raw, deps)     POST /api/auth/google/complete: the /signup/google form → a new studio
 *                                           whose owner signs in with Google only (no password, email confirmed).
 *   disconnectGoogle(db, ctx)               POST /api/auth/google/disconnect (only with a password; not in a demo).
 *   readPendingGoogleSignUp()               what /signup/google shows (from the signed 15-minute finish cookie).
 *
 * Callback resolution, in order (first match wins):
 *   1. intent "connect"   → link to the SIGNED-IN person (the session must still be the one that pressed Connect,
 *                           which needed their current password: `beginGoogleConnect`, SEC-03); a Google account
 *                           linked to someone else → `linked_elsewhere`. → <account>?google=connected, and "Google
 *                           sign-in was added" goes to the account's address.
 *   2. intent "invite"    → a live invite: accept it through `completeInviteAcceptance` (via "google") + link + sign
 *                           in. Dead invite → /invite/<token> (the dead-link card). Linked elsewhere → that message.
 *   3. a known google_sub → `startSession` as THAT account (a Google account maps to one Proofline account, always).
 *   4. the same email     → only when Google is authoritative for the address (Gmail / Workspace), the account is not
 *                           in a demo studio and has no other Google account: a pending invitee with a LIVE invite
 *                           accepts through `completeInviteAcceptance`; an account WITH A PASSWORD is never taken over
 *                           (SEC-01: whoever chose that password may not own the address) → `use_password` ("sign in
 *                           with your password, then connect Google"); an account without one is linked + signed in.
 *                           Otherwise the generic `refused` (never why) + `auth.login_failed` (metadata.method "google").
 *   5. no account         → the finish cookie (`GOOGLE_SIGNUP_COOKIE`, 15 min) → /signup/google (?from=signin).
 *
 * Every mutation runs in ONE transaction with its audit events (`user.google_connected` / `_disconnected`,
 * `user.accepted_invite` via "google", `user.email_confirmed` via "google", `auth.logged_in` method "google",
 * `org.created` / `user.created` cause "signup"). Codes, verifiers and id_tokens are never stored, logged or audited.
 */
import { and, eq, ne } from "drizzle-orm";
import { cookies } from "next/headers";
import { isUniqueViolation, pgError } from "@/db/errors";
import { first, one, type Db, type DbLike, type Tx } from "@/db/index";
import { users } from "@/db/schema";
import {
  GOOGLE_INTENTS,
  GOOGLE_OAUTH_COOKIE,
  GOOGLE_OAUTH_TTL_MINUTES,
  GOOGLE_SIGNUP_COOKIE,
  GOOGLE_SIGNUP_TTL_MINUTES,
  type GoogleIntent,
  type GoogleResult,
  type Role,
} from "@/lib/constants";
import type { AuthContext, User } from "@/lib/types";
import { GoogleCompleteInput, GoogleConnectInput, GoogleStartInput, TokenSchema } from "@/lib/validation/auth";
import { recordEvent } from "@/server/audit";
import { enforceRateLimit, knownIpKey, signupKey } from "@/server/auth/db-rate-limit";
import { assertNotDemo, isDemoOrganisation } from "@/server/auth/demo";
import { markEmailConfirmed } from "@/server/auth/email-confirmation";
import { googleAuthConfig, googleRedirectUri } from "@/server/auth/google-config";
import {
  GoogleOidcError,
  buildAuthorizeUrl,
  completeGoogleCodeFlow,
  googleIsAuthoritative,
  newFlowSecrets,
  sameSecret,
  type GoogleIdentity,
  type GoogleOidcDeps,
} from "@/server/auth/google-oidc";
import { hasUsablePassword } from "@/server/auth/password";
import { loginRedirectTarget, safeNextPath } from "@/server/auth/redirect";
import { buildContextFromDb, readSessionToken, systemContext } from "@/server/auth/session";
import { signPurposeToken, verifyPurposeToken } from "@/server/auth/session-token";
import { issueSessionCookie, recordSignIn, startSession } from "@/server/auth/sign-in";
import { markSignedUp } from "@/server/auth/signed-up";
import { latestLiveToken, unusablePasswordHash } from "@/server/auth/tokens";
import { nowIso } from "@/server/clock";
import { ForbiddenError, NotFoundError, RuleViolationError, UnauthorizedError, ValidationError } from "@/server/errors";
import { clientIp, trustedProxyCount } from "@/server/http";
import { accountPathFor } from "@/server/queries/accountSecurity";
import { currentRequestId, newRequestId } from "@/server/request-scope";
import { checkCurrentPassword } from "./account";
import { sendGoogleConnectedNotice } from "./accountNotices";
import { completeInviteAcceptance, findLiveInvite, type AcceptInviteResult } from "./invites";
import { enforceLimit } from "./authLimits";
import {
  EMAIL_IN_USE_MESSAGE,
  SIGNUP_REFUSED_MESSAGE,
  bootstrapOrganisation,
  createOrganisationWithOwner,
  emailTaken,
  emailUse,
  emailUseMessage,
  honeypotFilled,
} from "./organisations";
import { parseInput, withTx } from "./_shared";

type Env = Readonly<Record<string, string | undefined>>;

/* ------------------------------------------------------------------ */
/*  Messages                                                           */
/* ------------------------------------------------------------------ */

/** `beginGoogleSignIn` without GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (404). */
export const GOOGLE_DISABLED_MESSAGE = "Continue with Google is turned off";
/** /api/auth/google/complete without a (valid) finish cookie. */
export const GOOGLE_SIGNUP_EXPIRED_MESSAGE = "Start again with Continue with Google";
/** `details.reason` of that 400, so the form can switch to its "start again" state. */
export const GOOGLE_SIGNUP_EXPIRED_REASON = "google_signup_expired";
/** The honeypot answer: the very same generic words the email sign-up gives a bot (`SIGNUP_REFUSED_MESSAGE`). */
export const GOOGLE_SIGNUP_REFUSED_MESSAGE = SIGNUP_REFUSED_MESSAGE;
/** A race: this Google account got a Proofline account while the finish page was open. */
export const GOOGLE_ACCOUNT_TAKEN_MESSAGE = "That Google account already has a Proofline account. Sign in with Google instead.";
/** Disconnecting would leave the account with no way in. */
export const GOOGLE_NEEDS_PASSWORD_MESSAGE = "Set a password before you disconnect Google";

const OAUTH_PURPOSE = "google_oauth";
const SIGNUP_PURPOSE = "google_signup";
/** Account pages a "connect" round trip may come back to. */
const ACCOUNT_PATHS = ["/settings/account", "/portal/account"] as const;
const OWNER_NAME_MAX = 120;

/* ------------------------------------------------------------------ */
/*  Cookies                                                            */
/* ------------------------------------------------------------------ */

export interface GoogleCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
}

export interface GoogleCookie {
  name: string;
  value: string;
  options: GoogleCookieOptions;
}

/**
 * The round-trip cookie: httpOnly, `SameSite=Lax` (sent on Google's top-level redirect back to the callback, never
 * on cross-site sub-requests), scoped to /api/auth/google, 10 minutes.
 */
export function googleFlowCookieOptions(maxAge: number = GOOGLE_OAUTH_TTL_MINUTES * 60): GoogleCookieOptions {
  return { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/auth/google", maxAge };
}

/** The finish cookie (read by /signup/google and /api/auth/google/complete): httpOnly, Lax, 15 minutes. */
export function googleSignupCookieOptions(maxAge: number = GOOGLE_SIGNUP_TTL_MINUTES * 60): GoogleCookieOptions {
  return { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge };
}

/** What the round-trip cookie carries (signed, not encrypted: only this browser's own values). */
interface GoogleFlow {
  state: string;
  nonce: string;
  verifier: string;
  intent: GoogleIntent;
  /** intent "invite": the (cleaned) invite token from the page. */
  invite: string | null;
  /** intent "signin": the sanitised `next`. */
  next: string | null;
  /** intent "connect": the signed-in person who pressed Connect, and their account page. */
  uid: string | null;
  acct: (typeof ACCOUNT_PATHS)[number] | null;
}

function isIntent(value: unknown): value is GoogleIntent {
  return typeof value === "string" && (GOOGLE_INTENTS as readonly string[]).includes(value);
}

function nonEmpty(value: unknown, max = 256): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/** Re-validates the claims of a verified round-trip cookie (defence in depth: shapes, enums, allow-lists). */
function flowFromClaims(claims: Record<string, unknown> | null): GoogleFlow | null {
  if (!claims) return null;
  const state = nonEmpty(claims.state);
  const nonce = nonEmpty(claims.nonce);
  const verifier = nonEmpty(claims.verifier);
  if (!state || !nonce || !verifier || !isIntent(claims.intent)) return null;
  const invite = TokenSchema.safeParse(claims.invite);
  const acct = ACCOUNT_PATHS.find((p) => p === claims.acct) ?? null;
  return {
    state,
    nonce,
    verifier,
    intent: claims.intent,
    invite: claims.intent === "invite" && invite.success ? invite.data : null,
    next: claims.intent === "signin" ? safeNextPath(claims.next) : null,
    uid: claims.intent === "connect" ? nonEmpty(claims.uid, 64) : null,
    acct: claims.intent === "connect" ? acct : null,
  };
}

/** The verified Google identity waiting on /signup/google. */
interface PendingIdentity {
  sub: string;
  email: string;
  name: string | null;
  /** A sign-in's sanitised `next` (where the new owner lands after creating the studio; default /home). */
  next: string | null;
}

async function verifyPending(value: string | undefined): Promise<PendingIdentity | null> {
  const claims = await verifyPurposeToken<Record<string, unknown>>(value, SIGNUP_PURPOSE);
  if (!claims) return null;
  const sub = nonEmpty(claims.sub, 255);
  const email = nonEmpty(claims.email, 254);
  if (!sub || !email) return null;
  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, OWNER_NAME_MAX) : null;
  return { sub, email, name, next: safeNextPath(claims.next) };
}

export interface PendingGoogleSignUp {
  /** The Google address the new studio's owner will have (confirmed). */
  email: string;
  /** Google's display name (prefills "Your name"); null when Google sent none. */
  name: string | null;
}

/** /signup/google: the identity in this browser's finish cookie, or null (none / expired / tampered). */
export async function readPendingGoogleSignUp(): Promise<PendingGoogleSignUp | null> {
  const jar = await cookies();
  const pending = await verifyPending(jar.get(GOOGLE_SIGNUP_COOKIE)?.value);
  return pending ? { email: pending.email, name: pending.name } : null;
}

/* ------------------------------------------------------------------ */
/*  Where a round trip lands                                           */
/* ------------------------------------------------------------------ */

type FlowTarget = Pick<GoogleFlow, "intent" | "invite" | "next" | "acct">;

function withQuery(path: string, params: Record<string, string | null | undefined>, hash = ""): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const qs = search.toString();
  return `${path}${qs ? `?${qs}` : ""}${hash}`;
}

/**
 * The page a result is shown on: the account page for "connect", the invite page for "invite", /signup for
 * "signup" (except `refused` / `use_password`, sign-in answers), else /login (keeping a sign-in's `next`).
 */
export function googleResultLocation(flow: FlowTarget | null, result: GoogleResult): string {
  if (flow?.intent === "connect") return withQuery(flow.acct ?? ACCOUNT_PATHS[0], { google: result }, "#google");
  if (flow?.intent === "invite" && flow.invite) return withQuery(`/invite/${encodeURIComponent(flow.invite)}`, { google: result });
  if (flow?.intent === "signup" && result !== "refused" && result !== "use_password") return withQuery("/signup", { google: result });
  return withQuery("/login", { google: result, next: flow?.intent === "signin" ? flow.next : null });
}

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

export interface GoogleBeginDeps {
  env?: Env;
  /** The signed-in person (required for intent "connect"; ignored otherwise). */
  ctx?: AuthContext | null;
}

export interface GoogleBeginResult {
  /** Google's authorization URL (302 target). */
  location: string;
  /** The signed round-trip cookie for the route to set. */
  cookie: GoogleCookie;
}

/** GET /api/auth/google/start?intent=connect (an old link, a bookmark): Connect Google now needs the password first. */
export const GOOGLE_CONNECT_NEEDS_PASSWORD_MESSAGE = "Connect Google from My account (it asks for your password)";

/**
 * GET /api/auth/google/start `{ intent, invite?, next? }` (GoogleStartInput). 404 `NotFoundError` when Google is not
 * configured; 400 for a bad query (intent "invite" needs a well-formed token); intent "connect" is never started here
 * (401 signed out, else 403 — `beginGoogleConnect` checks the password first, SEC-03). `next` goes through
 * `safeNextPath` (sign-in only).
 */
export async function beginGoogleSignIn(req: Request, raw: unknown, deps: GoogleBeginDeps = {}): Promise<GoogleBeginResult> {
  const config = googleAuthConfig(deps.env);
  if (!config) throw new NotFoundError("Google sign-in", GOOGLE_DISABLED_MESSAGE);
  const input = parseInput(GoogleStartInput, raw);
  if (input.intent === "invite" && !input.invite) {
    throw new ValidationError("This invite link is not valid", { formErrors: ["This invite link is not valid"], fieldErrors: { invite: ["This invite link is not valid"] } });
  }
  if (input.intent === "connect") {
    const ctx = deps.ctx;
    if (!ctx?.userId || ctx.isSystem) throw new UnauthorizedError();
    throw new ForbiddenError("google.connect", GOOGLE_CONNECT_NEEDS_PASSWORD_MESSAGE);
  }
  return startFlow(req, config, { intent: input.intent, invite: input.invite ?? null, next: input.intent === "signin" ? safeNextPath(input.next) : null }, deps.env);
}

export interface GoogleConnectDeps {
  env?: Env;
}

/**
 * POST /api/auth/google/connect `{ password }` — "Connect Google" on My account (self, any role). 404 when Google is not
 * configured; 401 signed out; 403 in a demo studio; 422 without a password (nothing to check it against); the current
 * password is checked with the shared wrong-password limiter (`passwordCheck`: 400 `fieldErrors.password`, 429 when
 * over). Then the round trip starts as the signed-in person and comes back to their account page. A new way into the
 * account is never added by whoever happens to be at an unlocked computer (SEC-03).
 */
export async function beginGoogleConnect(db: Db, req: Request, ctx: AuthContext | null, raw: unknown, deps: GoogleConnectDeps = {}): Promise<GoogleBeginResult> {
  const config = googleAuthConfig(deps.env);
  if (!config) throw new NotFoundError("Google sign-in", GOOGLE_DISABLED_MESSAGE);
  if (!ctx?.userId || ctx.isSystem) throw new UnauthorizedError();
  assertNotDemo(ctx, "sign_in_methods");
  const input = parseInput(GoogleConnectInput, raw);
  const me = await first(db.select().from(users).where(and(eq(users.id, ctx.userId), eq(users.organisationId, ctx.organisationId))));
  if (!me || !me.isActive || me.anonymisedAt !== null) throw new UnauthorizedError();
  if (!hasUsablePassword(me)) throw new RuleViolationError(GOOGLE_CONNECT_NO_PASSWORD_MESSAGE, { formErrors: [GOOGLE_CONNECT_NO_PASSWORD_MESSAGE], fieldErrors: {} });
  await checkCurrentPassword(db, me, input.password, "password");
  return startFlow(req, config, { intent: "connect", invite: null, next: null, uid: me.id, acct: accountPathFor(me.role) as GoogleFlow["acct"] }, deps.env);
}

/** Connect without a password: there is nothing to check it against (Google-only accounts are connected already). */
export const GOOGLE_CONNECT_NO_PASSWORD_MESSAGE = "Set a password first, then you can connect Google";

/** Signs the round-trip cookie and builds Google's URL for one flow. */
async function startFlow(
  req: Request,
  config: NonNullable<ReturnType<typeof googleAuthConfig>>,
  flow: Pick<GoogleFlow, "intent" | "invite" | "next"> & { uid?: string | null; acct?: GoogleFlow["acct"] },
  env: Env | undefined,
): Promise<GoogleBeginResult> {
  const secrets = newFlowSecrets();
  const claims: Record<string, unknown> = {
    ...secrets,
    intent: flow.intent,
    ...(flow.intent === "invite" && flow.invite ? { invite: flow.invite } : {}),
    ...(flow.intent === "signin" && flow.next ? { next: flow.next } : {}),
    ...(flow.intent === "connect" && flow.uid ? { uid: flow.uid, acct: flow.acct } : {}),
  };
  const ttl = GOOGLE_OAUTH_TTL_MINUTES * 60;
  const value = await signPurposeToken(claims, OAUTH_PURPOSE, ttl);
  const location = buildAuthorizeUrl({
    clientId: config.clientId,
    redirectUri: googleRedirectUri(req, env),
    state: secrets.state,
    nonce: secrets.nonce,
    codeVerifier: secrets.verifier,
  });
  return { location, cookie: { name: GOOGLE_OAUTH_COOKIE, value, options: googleFlowCookieOptions(ttl) } };
}

/**
 * The route's version of `beginGoogleSignIn`: never throws. Not configured → the page's `?google=disabled`; a bad
 * query → /login?google=failed; "connect" while signed out → /login; "connect" signed in → the account page's Google
 * card (where Connect asks for the password).
 */
export async function googleStartRedirect(req: Request, raw: unknown, deps: GoogleBeginDeps = {}): Promise<{ location: string; cookie: GoogleCookie | null }> {
  try {
    return await beginGoogleSignIn(req, raw, deps);
  } catch (err) {
    const parsed = GoogleStartInput.safeParse(raw);
    const target: FlowTarget | null = parsed.success
      ? {
          intent: parsed.data.intent,
          invite: parsed.data.invite ?? null,
          next: parsed.data.intent === "signin" ? safeNextPath(parsed.data.next) : null,
          acct: deps.ctx?.userId ? (accountPathFor(deps.ctx.role) as GoogleFlow["acct"]) : null,
        }
      : null;
    if (err instanceof NotFoundError) {
      // "connect" without a session has no account page to come back to.
      const where = target?.intent === "connect" && !target.acct ? null : target;
      return { location: googleResultLocation(where, "disabled"), cookie: null };
    }
    if (err instanceof UnauthorizedError) return { location: "/login", cookie: null };
    if (err instanceof ForbiddenError) return { location: `${target?.acct ?? ACCOUNT_PATHS[0]}#google`, cookie: null };
    if (!(err instanceof ValidationError)) console.error("[google] start failed", err instanceof Error ? err.name : "unknown");
    return { location: googleResultLocation(null, "failed"), cookie: null };
  }
}

/* ------------------------------------------------------------------ */
/*  Callback                                                           */
/* ------------------------------------------------------------------ */

export interface GoogleCallbackDeps extends GoogleOidcDeps {
  env?: Env;
  requestId?: string;
  /** Rate-limiter clock (ms); default `Date.now()`. */
  rateLimitNowMs?: number;
}

/** What happened (tests, logs). Failures carry their `?google=` result. */
export type GoogleCallbackOutcome = "signed_in" | "linked" | "invite_accepted" | "connected" | "signup_pending" | "invite_dead" | GoogleResult;

export interface GoogleCallbackResult {
  /** Relative path to send the browser to (303/302). */
  location: string;
  outcome: GoogleCallbackOutcome;
}

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  env: Env;
}

function fail(flow: FlowTarget | null, result: GoogleResult): GoogleCallbackResult {
  return { location: googleResultLocation(flow, result), outcome: result };
}

/**
 * GET /api/auth/google/callback. Rate-limited per client IP (`googleCallback`; skipped when the IP is unknown, so one
 * person can never lock everybody out — SEC-10), single-use round-trip cookie (cleared on every callback), state
 * compared in constant time, then the code exchange + id_token checks, then the resolution order in the file header.
 * Never throws and never answers with JSON: the browser always lands on a page.
 */
export async function handleGoogleCallback(db: Db, req: Request, deps: GoogleCallbackDeps = {}): Promise<GoogleCallbackResult> {
  const env = deps.env ?? process.env;
  const url = new URL(req.url);
  const jar = await cookies();
  const rawFlow = jar.get(GOOGLE_OAUTH_COOKIE)?.value;
  // Single use: whatever happens next, this round trip cannot be replayed from this browser.
  if (rawFlow !== undefined) jar.set(GOOGLE_OAUTH_COOKIE, "", googleFlowCookieOptions(0));

  const config = googleAuthConfig(env);
  if (!config) return fail(null, "disabled");
  const flow = flowFromClaims(await verifyPurposeToken<Record<string, unknown>>(rawFlow, OAUTH_PURPOSE));
  const meta: RequestMeta = {
    ip: clientIp(req.headers, trustedProxyCount(env)),
    userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
    requestId: deps.requestId ?? currentRequestId() ?? newRequestId(),
    env,
  };

  const network = knownIpKey(meta.ip);
  if (network) {
    try {
      await enforceRateLimit(db, "googleCallback", network, deps.rateLimitNowMs);
    } catch {
      return fail(flow, "failed");
    }
  }
  if (!flow) return fail(null, "expired");
  if (!sameSecret(url.searchParams.get("state"), flow.state)) return fail(flow, "expired");
  const error = url.searchParams.get("error");
  if (error) return fail(flow, error === "access_denied" ? "cancelled" : "failed");
  const code = url.searchParams.get("code");
  if (!code || code.length > 2048) return fail(flow, "failed");

  let identity: GoogleIdentity;
  try {
    identity = await completeGoogleCodeFlow(config, { code, codeVerifier: flow.verifier, redirectUri: googleRedirectUri(req, env), nonce: flow.nonce }, deps);
  } catch (err) {
    return fail(flow, err instanceof GoogleOidcError && err.reason === "unverified_email" ? "unverified_email" : "failed");
  }

  try {
    return await resolveIdentity(db, flow, identity, meta);
  } catch (err) {
    // Never the message: a database error's text can carry query parameters (addresses).
    console.error("[google] callback failed", err instanceof Error ? err.name : "unknown", pgError(err)?.code ?? "");
    return fail(flow, "failed");
  }
}

async function resolveIdentity(db: Db, flow: GoogleFlow, identity: GoogleIdentity, meta: RequestMeta): Promise<GoogleCallbackResult> {
  if (flow.intent === "connect") return connectToSessionUser(db, flow, identity, meta);
  if (flow.intent === "invite") return acceptInviteWithGoogle(db, flow, identity, meta);
  const linked = await first(db.select().from(users).where(eq(users.googleSub, identity.sub)));
  if (linked) return signInLinked(db, flow, linked, meta);
  const sameEmail = await first(db.select().from(users).where(eq(users.email, identity.email)));
  if (sameEmail) return linkByEmail(db, flow, sameEmail, identity, meta);
  return pendingSignUp(flow, identity);
}

/** Links `identity` to `userId` (in `tx`, as `ctx`) and audits `user.google_connected`. */
async function linkGoogle(tx: Tx, ctx: AuthContext, userId: string, identity: GoogleIdentity, via: "connect" | "sign_in" | "invite" | "signup"): Promise<void> {
  const before = await one(
    tx
      .select({ googleEmail: users.googleEmail, version: users.version, name: users.name })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.organisationId, ctx.organisationId))),
    "user",
  );
  const now = ctx.now();
  await tx
    .update(users)
    .set({ googleSub: identity.sub, googleEmail: identity.email, updatedAt: now, version: before.version + 1 })
    .where(eq(users.id, userId));
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: userId,
    eventType: "user.google_connected",
    action: "connected",
    previousValue: before.googleEmail ? { googleEmail: before.googleEmail } : null,
    newValue: { googleEmail: identity.email, name: before.name },
    metadata: { targetUserId: userId, via },
    visibility: "management",
  });
}

/** `auth.login_failed` for a Google sign-in that matched an account but was refused (never shown to the person). */
async function auditRefusal(db: Db, user: User, meta: RequestMeta, reason: string): Promise<void> {
  const ctx = await systemContext(user.organisationId, { db, cause: "user", requestId: meta.requestId });
  await withTx(
    (tx) =>
      recordEvent(tx, ctx, {
        entityType: "auth",
        entityId: user.id,
        eventType: "auth.login_failed",
        action: "login_failed",
        previousValue: null,
        newValue: { email: user.email },
        metadata: { method: "google", reason, ip: meta.ip, userAgent: meta.userAgent, targetUserId: user.id },
        visibility: "management",
      }),
    { db },
  );
}

function refusalReason(user: User): string {
  if (user.anonymisedAt) return "anonymised";
  if (!user.isActive) return "inactive";
  if (!user.acceptedAt) return "not_accepted";
  return "no_access";
}

/** The generic refusal for a sign-in (signin / signup intents): /login?google=refused. */
async function refuse(db: Db, flow: GoogleFlow, user: User, meta: RequestMeta, reason: string): Promise<GoogleCallbackResult> {
  await auditRefusal(db, user, meta, reason);
  return fail(flow, "refused");
}

/** (3) A known Google account: sign in as the account it is linked to — whatever the email says now. */
async function signInLinked(db: Db, flow: GoogleFlow, user: User, meta: RequestMeta): Promise<GoogleCallbackResult> {
  try {
    const session = await startSession(db, { userId: user.id, method: "google", ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId }, { env: meta.env });
    return { location: loginRedirectTarget(session.role, flow.next), outcome: "signed_in" };
  } catch (err) {
    if (err instanceof UnauthorizedError) return refuse(db, flow, user, meta, refusalReason(user));
    throw err;
  }
}

/** (4) No account has this Google account yet, but one has its email address. */
async function linkByEmail(db: Db, flow: GoogleFlow, user: User, identity: GoogleIdentity, meta: RequestMeta): Promise<GoogleCallbackResult> {
  // Already tied to a DIFFERENT Google account: never swap it from the sign-in page.
  if (user.googleSub !== null) return refuse(db, flow, user, meta, "other_google_account");
  if (!googleIsAuthoritative(identity)) return refuse(db, flow, user, meta, "google_not_authoritative");
  if (await isDemoOrganisation(db, user.organisationId)) return refuse(db, flow, user, meta, "demo");
  if (!user.isActive || user.anonymisedAt) return refuse(db, flow, user, meta, refusalReason(user));

  if (user.acceptedAt === null) {
    // A pending invitee joins with Google only while their invite is live (a revoked invite means "no way in").
    if (!(await latestLiveToken(db, user.id, "invite", nowIso()))) return refuse(db, flow, user, meta, "invite_not_live");
    let accepted: AcceptInviteResult;
    try {
      accepted = await withTx(
        async (tx) => {
          const now = nowIso();
          const fresh = await one(tx.select().from(users).where(eq(users.id, user.id)), "user");
          if (fresh.acceptedAt !== null || fresh.googleSub !== null) throw new ValidationError("This invite link is no longer valid");
          // Re-read inside the transaction and use THAT link (fill-once): an invite revoked a moment ago never lets anyone in.
          const live = await latestLiveToken(tx, user.id, "invite", now);
          if (!live) throw new ValidationError("This invite link is no longer valid");
          const result = await completeInviteAcceptance(tx, {
            user: fresh,
            tokenId: live.id,
            now,
            via: "google",
            passwordHash: null,
            // Google is the authority for exactly this address (checked above): it is proven.
            emailConfirmed: true,
            ip: meta.ip,
            userAgent: meta.userAgent,
            requestId: meta.requestId,
          });
          const ctx = await buildContextFromDb(tx, user.id, { cause: "user", requestId: meta.requestId });
          if (!ctx) throw new ValidationError("This invite link is no longer valid");
          await linkGoogle(tx, ctx, user.id, identity, "invite");
          return result;
        },
        { db },
      );
    } catch (err) {
      if (isUniqueViolation(err, "users_google_sub_uq")) return fail(flow, "linked_elsewhere");
      if (err instanceof ValidationError) return refuse(db, flow, user, meta, "no_access");
      throw err;
    }
    await issueSessionCookie({ id: accepted.userId, role: accepted.role, sessionVersion: accepted.sessionVersion, email: accepted.email });
    return { location: loginRedirectTarget(accepted.role, flow.next), outcome: "invite_accepted" };
  }

  // A client whose portal is closed (or an archived client) has no context: refuse BEFORE linking anything.
  const ctx = await buildContextFromDb(db, user.id, { cause: "user", requestId: meta.requestId });
  if (!ctx) return refuse(db, flow, user, meta, "no_access");

  // SEC-01 / DATA-03: an account WITH a password is never taken over by "same email". Nothing proves the person who
  // chose that password owns this address (anyone can create an account in someone else's Gmail address and wait), so
  // linking would hand the address's real owner an account its creator can still open. The verified owner of the Google
  // address is told to sign in with the password (or reset it — the link goes to their inbox) and connect Google from
  // My account. Only they ever see this answer, so it tells a stranger nothing.
  if (hasUsablePassword(user)) {
    await auditRefusal(db, user, meta, "has_password");
    return fail(flow, "use_password");
  }
  try {
    await withTx(
      async (tx) => {
        const fresh = await one(tx.select({ googleSub: users.googleSub }).from(users).where(eq(users.id, user.id)), "user");
        if (fresh.googleSub !== null) throw new ValidationError("Already linked");
        await linkGoogle(tx, ctx, user.id, identity, "sign_in");
        await markEmailConfirmed(tx, ctx, { userId: user.id, via: "google" });
      },
      { db },
    );
  } catch (err) {
    if (isUniqueViolation(err, "users_google_sub_uq")) return fail(flow, "linked_elsewhere");
    if (err instanceof ValidationError) return refuse(db, flow, user, meta, "other_google_account");
    throw err;
  }
  const signedIn = await signInLinked(db, flow, user, meta);
  return signedIn.outcome === "signed_in" ? { ...signedIn, outcome: "linked" } : signedIn;
}

/** (5) Nobody has this Google account or its address: the finish page asks for a studio name. */
async function pendingSignUp(flow: GoogleFlow, identity: GoogleIdentity): Promise<GoogleCallbackResult> {
  const ttl = GOOGLE_SIGNUP_TTL_MINUTES * 60;
  const claims = { sub: identity.sub, email: identity.email, name: identity.name, ...(flow.next ? { next: flow.next } : {}) };
  const value = await signPurposeToken(claims, SIGNUP_PURPOSE, ttl);
  const jar = await cookies();
  jar.set(GOOGLE_SIGNUP_COOKIE, value, googleSignupCookieOptions(ttl));
  return { location: flow.intent === "signin" ? "/signup/google?from=signin" : "/signup/google", outcome: "signup_pending" };
}

/** (1) "Connect Google" on My account: link to the person who pressed it, if this browser is still them. */
async function connectToSessionUser(db: Db, flow: GoogleFlow, identity: GoogleIdentity, meta: RequestMeta): Promise<GoogleCallbackResult> {
  const session = await readSessionToken();
  if (!flow.uid || !session || session.sub !== flow.uid) return fail(null, "expired");
  const ctx = await buildContextFromDb(db, flow.uid, { sessionVersion: session.sv, cause: "user", requestId: meta.requestId });
  if (!ctx) return fail(null, "expired");
  if (ctx.isDemo) return fail(flow, "refused");
  const elsewhere = await first(db.select({ id: users.id }).from(users).where(and(eq(users.googleSub, identity.sub), ne(users.id, flow.uid))));
  if (elsewhere) return fail(flow, "linked_elsewhere");
  const me = await one(db.select().from(users).where(eq(users.id, flow.uid)), "user");
  if (me.googleSub === identity.sub && me.googleEmail === identity.email) return { location: googleResultLocation(flow, "connected"), outcome: "connected" };
  try {
    await withTx(
      async (tx) => {
        await linkGoogle(tx, ctx, me.id, identity, "connect");
        // Google vouches for the address only where it is the authority for it.
        if (identity.email === me.email && googleIsAuthoritative(identity)) await markEmailConfirmed(tx, ctx, { userId: me.id, via: "google" });
      },
      { db },
    );
  } catch (err) {
    if (isUniqueViolation(err, "users_google_sub_uq")) return fail(flow, "linked_elsewhere");
    throw err;
  }
  // A new way in never appears silently (SEC-03): "Google sign-in was added" to the account's own address.
  await sendGoogleConnectedNotice(db, { userId: me.id, googleEmail: identity.email });
  return { location: googleResultLocation(flow, "connected"), outcome: "connected" };
}

/** (2) Continue with Google on a live invite page: Google replaces choosing a password. */
async function acceptInviteWithGoogle(db: Db, flow: GoogleFlow, identity: GoogleIdentity, meta: RequestMeta): Promise<GoogleCallbackResult> {
  if (!flow.invite) return fail(null, "failed");
  const deadLink: GoogleCallbackResult = { location: `/invite/${encodeURIComponent(flow.invite)}`, outcome: "invite_dead" };
  const live = await findLiveInvite(db, flow.invite, nowIso());
  if (!live) return deadLink;
  const linkedTo = await first(db.select({ id: users.id }).from(users).where(eq(users.googleSub, identity.sub)));
  if (linkedTo && linkedTo.id !== live.user.id) return fail(flow, "linked_elsewhere");
  if (await isDemoOrganisation(db, live.user.organisationId)) return fail(flow, "refused");
  let accepted: AcceptInviteResult;
  try {
    accepted = await withTx(
      async (tx) => {
        const now = nowIso();
        const fresh = await findLiveInvite(tx, flow.invite ?? "", now);
        if (!fresh) throw new ValidationError("This invite link is no longer valid");
        const result = await completeInviteAcceptance(tx, {
          user: fresh.user,
          tokenId: fresh.tokenId,
          now,
          via: "google",
          passwordHash: null,
          // Only when Google is the authority for exactly the invited address (its "verified" flag can be stale elsewhere).
          emailConfirmed: identity.email === fresh.user.email.toLowerCase() && googleIsAuthoritative(identity),
          ip: meta.ip,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });
        const ctx = await buildContextFromDb(tx, fresh.user.id, { cause: "user", requestId: meta.requestId });
        if (!ctx) throw new ValidationError("This invite link is no longer valid");
        await linkGoogle(tx, ctx, fresh.user.id, identity, "invite");
        return result;
      },
      { db },
    );
  } catch (err) {
    if (isUniqueViolation(err, "users_google_sub_uq")) return fail(flow, "linked_elsewhere");
    if (err instanceof ValidationError) return fail(flow, "refused");
    throw err;
  }
  await issueSessionCookie({ id: accepted.userId, role: accepted.role, sessionVersion: accepted.sessionVersion, email: accepted.email });
  return { location: loginRedirectTarget(accepted.role, null), outcome: "invite_accepted" };
}

/* ------------------------------------------------------------------ */
/*  Finish a Google sign-up                                            */
/* ------------------------------------------------------------------ */

export interface GoogleCompleteDeps {
  requestId?: string;
  /** Rate-limiter clock (ms); default `Date.now()`. */
  rateLimitNowMs?: number;
}

export interface GoogleSignUpResult {
  /** /home, or a sign-in's safe `next` (`loginRedirectTarget`). */
  redirectTo: string;
  organisationId: string;
  slug: string;
  user: { id: string; name: string; email: string; role: Role };
}

function formError(message: string, extra: Record<string, unknown> = {}): ValidationError {
  return new ValidationError(message, { formErrors: [message], fieldErrors: {}, ...extra });
}

function emailLocalPart(email: string): string {
  return email.slice(0, Math.max(1, email.indexOf("@"))).slice(0, OWNER_NAME_MAX);
}

/**
 * POST /api/auth/google/complete `{ studioName, ownerName?, timezone?, website? }` (public). Needs the finish cookie
 * (else 400 "Start again with Continue with Google", `details.reason` = GOOGLE_SIGNUP_EXPIRED_REASON); the honeypot
 * → generic 400; 5 sign-ups / hour / IP (shared with the email sign-up, keyed like it) → 429; a taken email or
 * Google account (a race) → 400. Lands on /home (or a sign-in's `next`, through `safeNextPath`). One transaction: organisation + owner (no password, email confirmed, Google linked)
 * + the structure bootstrap + `auth.logged_in` (method "google") + `user.google_connected` (via "signup"). Then the
 * session cookie, the "signed up here" marker, and the finish cookie is cleared.
 */
export async function completeGoogleSignUp(db: Db, raw: unknown, deps: GoogleCompleteDeps = {}): Promise<GoogleSignUpResult> {
  const jar = await cookies();
  const pending = await verifyPending(jar.get(GOOGLE_SIGNUP_COOKIE)?.value);
  if (!pending) throw formError(GOOGLE_SIGNUP_EXPIRED_MESSAGE, { reason: GOOGLE_SIGNUP_EXPIRED_REASON });
  const limitNow = deps.rateLimitNowMs ?? Date.now();
  if (honeypotFilled(raw)) {
    // A bot — answered exactly like the email sign-up: checked on the RAW body (no field errors to learn from), the
    // attempt still counts toward the shared sign-up limit, then the one generic 400.
    const rawIp = (raw as Record<string, unknown>).ip;
    await enforceLimit(db, "signup", signupKey(typeof rawIp === "string" ? rawIp : null, pending.email), "signup", limitNow);
    throw formError(SIGNUP_REFUSED_MESSAGE);
  }
  const input = parseInput(GoogleCompleteInput, raw);
  // The same plain 429 as the email sign-up ("Too many new studios from this network. Try again in N minutes.").
  await enforceLimit(db, "signup", signupKey(input.ip, pending.email), "signup", limitNow);

  const emailInUse = () => formError(EMAIL_IN_USE_MESSAGE);
  const accountTaken = () => formError(GOOGLE_ACCOUNT_TAKEN_MESSAGE);
  const googleTaken = async (dbx: DbLike) => (await first(dbx.select({ id: users.id }).from(users).where(eq(users.googleSub, pending.sub)))) !== undefined;
  // An address with an invite nobody opened yet gets the email sign-up's "use the invite link" words.
  const use = await emailUse(db, pending.email);
  if (use !== "free") throw formError(emailUseMessage(use));
  if (await googleTaken(db)) throw accountTaken();

  const ownerName = (input.ownerName ?? pending.name ?? emailLocalPart(pending.email)).slice(0, OWNER_NAME_MAX);
  const requestId = deps.requestId ?? currentRequestId() ?? newRequestId();
  let created: { organisationId: string; slug: string; userId: string; sessionVersion: number };
  try {
    created = await withTx(
      async (tx) => {
        if (await emailTaken(tx, pending.email)) throw emailInUse();
        if (await googleTaken(tx)) throw accountTaken();
        const now = nowIso();
        const org = await createOrganisationWithOwner(tx, {
          name: input.studioName,
          timezone: input.timezone,
          owner: {
            name: ownerName,
            email: pending.email,
            passwordHash: unusablePasswordHash(),
            hasPassword: false,
            emailVerifiedAt: now,
            googleSub: pending.sub,
            googleEmail: pending.email,
          },
          cause: "signup",
          requestId,
        });
        await bootstrapOrganisation(tx, { organisationId: org.organisationId, ownerUserId: org.ownerId, ctx: org.ctx });
        await recordSignIn(tx, org.ctx, { method: "google", ip: input.ip, userAgent: input.userAgent });
        await recordEvent(tx, org.ctx, {
          entityType: "user",
          entityId: org.ownerId,
          eventType: "user.google_connected",
          action: "connected",
          previousValue: null,
          newValue: { googleEmail: pending.email, name: ownerName },
          metadata: { targetUserId: org.ownerId, via: "signup" },
          visibility: "management",
        });
        const row = await one(tx.select({ sessionVersion: users.sessionVersion }).from(users).where(eq(users.id, org.ownerId)), "owner");
        return { organisationId: org.organisationId, slug: org.slug, userId: org.ownerId, sessionVersion: row.sessionVersion };
      },
      { db },
    );
  } catch (err) {
    if (isUniqueViolation(err, "users_email_uq")) throw emailInUse();
    if (isUniqueViolation(err, "users_google_sub_uq")) throw accountTaken();
    throw err;
  }

  await issueSessionCookie({ id: created.userId, role: "photographer", sessionVersion: created.sessionVersion, email: pending.email });
  await markSignedUp();
  jar.set(GOOGLE_SIGNUP_COOKIE, "", googleSignupCookieOptions(0));
  return {
    redirectTo: loginRedirectTarget("photographer", pending.next),
    organisationId: created.organisationId,
    slug: created.slug,
    user: { id: created.userId, name: ownerName, email: pending.email, role: "photographer" },
  };
}

/* ------------------------------------------------------------------ */
/*  Disconnect                                                         */
/* ------------------------------------------------------------------ */

export interface DisconnectGoogleResult {
  ok: true;
  /** false when no Google account was connected (nothing changed, nothing recorded). */
  disconnected: boolean;
}

/**
 * POST /api/auth/google/disconnect (self, any role). Demo studio → 403; no password yet → 422 (it would leave the
 * account without a way in). Clears `google_sub` / `google_email` and audits `user.google_disconnected`.
 */
export async function disconnectGoogle(db: Db, ctx: AuthContext): Promise<DisconnectGoogleResult> {
  if (!ctx.userId || ctx.isSystem) throw new UnauthorizedError();
  assertNotDemo(ctx, "sign_in_methods");
  const userId = ctx.userId;
  return withTx(
    async (tx) => {
      const user = await first(tx.select().from(users).where(and(eq(users.id, userId), eq(users.organisationId, ctx.organisationId))));
      if (!user) throw new NotFoundError("User");
      if (user.googleSub === null) return { ok: true as const, disconnected: false };
      // The stored hash decides (DATA-04): a flag older code wrote must never let the only way in be removed.
      if (!hasUsablePassword(user)) throw new RuleViolationError(GOOGLE_NEEDS_PASSWORD_MESSAGE, { formErrors: [GOOGLE_NEEDS_PASSWORD_MESSAGE], fieldErrors: {} });
      const now = ctx.now();
      await tx.update(users).set({ googleSub: null, googleEmail: null, updatedAt: now, version: user.version + 1 }).where(eq(users.id, user.id));
      await recordEvent(tx, ctx, {
        entityType: "user",
        entityId: user.id,
        eventType: "user.google_disconnected",
        action: "disconnected",
        previousValue: { googleEmail: user.googleEmail },
        newValue: { googleEmail: null, name: user.name },
        metadata: { targetUserId: user.id },
        visibility: "management",
      });
      return { ok: true as const, disconnected: true };
    },
    { db },
  );
}
