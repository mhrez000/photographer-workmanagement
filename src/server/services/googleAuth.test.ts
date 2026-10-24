/**
 * "Continue with Google" — the service (src/server/services/googleAuth.ts), every outcome without Google: a local RSA
 * key pair stands in for Google's signing keys, a fake token endpoint for https://oauth2.googleapis.com/token, and an
 * in-memory cookie jar for `next/headers`. Covers start (PKCE / state / nonce / cookie / next), every callback branch
 * (known account, link by email, pending invitee, invite page, connect, new person, refusals, replays, bad tokens,
 * rate limit), finishing a Google sign-up, and disconnecting — with the audit events each one writes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import type { SeedIds, TestDb } from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { GOOGLE_OAUTH_COOKIE, GOOGLE_SIGNUP_COOKIE, SESSION_COOKIE_NAME } from "@/lib/constants";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => {
      if (value) jar.set(name, value);
      else jar.delete(name);
    },
  }),
}));

// The setup file loaded the session module before this mock was registered: load fresh copies of everything.
// The connect route shares `_lib/route` (→ the Advanced-tools gate → src/server/page.ts, which is `server-only`).
vi.mock("server-only", () => ({}));

vi.resetModules();
const { and, eq } = await import("drizzle-orm");
const { setDbOverride } = await import("@/db/index");
const schema = await import("@/db/schema");
const { TEST_PASSWORD, closeTestDbs, contextFor, fakeClock, makeTestDb, seedMinimalOrg } = await import("@/db/test-db");
const { signPurposeToken, signSessionToken, verifyPurposeToken, verifySessionToken } = await import("@/server/auth/session-token");
const { requireAnyContext, requireContext } = await import("@/server/auth/session");
const { ipKey, limiters, signupKey } = await import("@/server/auth/db-rate-limit");
const { pkceChallenge } = await import("@/server/auth/google-oidc");
const { SIGNED_UP_COOKIE_NAME } = await import("@/server/auth/signed-up");
const { nowIso } = await import("@/server/clock");
const { ForbiddenError, NotFoundError, RateLimitedError, RuleViolationError, UnauthorizedError, ValidationError } = await import("@/server/errors");
const { withTx } = await import("./_shared");
const { revokeInvite } = await import("./invites");
const { EMAIL_IN_USE_MESSAGE, signUp } = await import("./organisations");
const { authenticate } = await import("./auth");
const { inviteUser } = await import("./users");
const G = await import("./googleAuth");

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const CLIENT_ID = "client-123.apps.googleusercontent.com";
const ENV = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "shh-secret" };
const ORIGIN = "http://localhost:3130";

let db: TestDb;
let ids: SeedIds;
let privateKey: CryptoKey;
let jwks: JWTVerifyGetKey;
let tokenCalls: URLSearchParams[];

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] });
});

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  setDbOverride(db);
  jar.clear();
  tokenCalls = [];
});
afterEach(async () => {
  vi.useRealTimers();
  setDbOverride(null);
  fakeClock.reset();
  await closeTestDbs();
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface Started {
  state: string;
  nonce: string;
  verifier: string;
  cookie: string;
  location: URL;
}

async function start(query: Record<string, string>, ctx?: AuthContext | null): Promise<Started> {
  const req = new Request(`${ORIGIN}/api/auth/google/start?${new URLSearchParams(query)}`);
  // Connect Google needs the current password (SEC-03): POST /api/auth/google/connect.
  const res =
    query.intent === "connect"
      ? await G.beginGoogleConnect(db, new Request(`${ORIGIN}/api/auth/google/connect`, { method: "POST" }), ctx ?? null, { password: TEST_PASSWORD }, { env: ENV })
      : await G.beginGoogleSignIn(req, query, { env: ENV, ctx });
  jar.set(res.cookie.name, res.cookie.value);
  const claims = await verifyPurposeToken<{ state: string; nonce: string; verifier: string }>(res.cookie.value, "google_oauth");
  if (!claims) throw new Error("no flow cookie");
  return { state: claims.state, nonce: claims.nonce, verifier: claims.verifier, cookie: res.cookie.value, location: new URL(res.location) };
}

interface GoogleClaims {
  sub?: string;
  email?: string;
  email_verified?: unknown;
  name?: string;
  hd?: string;
  nonce?: string;
  aud?: string;
  iss?: string;
  exp?: number;
}

const nowS = () => Math.floor(Date.parse(nowIso()) / 1000);

async function idTokenFor(started: Started, claims: GoogleClaims = {}): Promise<string> {
  const { aud, iss, exp, ...rest } = claims;
  return new SignJWT({ sub: "g-new", email: "newbie@gmail.com", email_verified: true, name: "Nia Newbie", nonce: started.nonce, ...rest })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(iss ?? "https://accounts.google.com")
    .setAudience(aud ?? CLIENT_ID)
    .setIssuedAt(nowS() - 5)
    .setExpirationTime(exp ?? nowS() + 3600)
    .sign(privateKey);
}

function tokenEndpoint(idToken: string | null): FetchLike {
  return async (_url, init) => {
    tokenCalls.push(new URLSearchParams(String(init?.body)));
    return idToken === null ? Response.json({ error: "invalid_grant" }, { status: 400 }) : Response.json({ id_token: idToken });
  };
}

interface FinishOptions {
  claims?: GoogleClaims;
  state?: string | null;
  code?: string | null;
  error?: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
  env?: Record<string, string | undefined>;
}

async function finish(started: Started | null, opts: FinishOptions = {}) {
  const params = new URLSearchParams();
  const state = opts.state === undefined ? started?.state : opts.state;
  if (state) params.set("state", state);
  if (opts.error) params.set("error", opts.error);
  const code = opts.code === undefined ? "4/0Acode" : opts.code;
  if (code && !opts.error) params.set("code", code);
  const req = new Request(`${ORIGIN}/api/auth/google/callback?${params}`, { headers: { "user-agent": "vitest-google", ...opts.headers } });
  const fetcher = opts.fetch ?? tokenEndpoint(started ? await idTokenFor(started, opts.claims) : null);
  return G.handleGoogleCallback(db, req, { env: opts.env ?? ENV, jwks, fetch: fetcher, requestId: "req-google" });
}

/** Start + callback in one go. */
async function roundTrip(query: Record<string, string>, claims: GoogleClaims, ctx?: AuthContext | null) {
  return finish(await start(query, ctx), { claims });
}

async function userRow(id: string) {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  return row;
}

async function userByEmail(email: string) {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  return row;
}

async function eventsOf(type: string, entityId?: string) {
  const rows = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.eventType, type as never));
  return entityId ? rows.filter((r) => r.entityId === entityId) : rows;
}

async function sessionSub(): Promise<string | null> {
  return (await verifySessionToken(jar.get(SESSION_COOKIE_NAME)))?.sub ?? null;
}

async function linkFixture(userId: string, sub: string, email: string) {
  await db.update(schema.users).set({ googleSub: sub, googleEmail: email }).where(eq(schema.users.id, userId));
}

async function inviteEditor(email: string, name = "Sam Invitee") {
  const ownerCtx = await contextFor(db, ids.users.owner);
  const invited = await withTx((tx) => inviteUser(tx, ownerCtx, { email, name, role: "editor" }), { db });
  if (!invited.invite) throw new Error("expected a link invite");
  return { userId: invited.user.id, token: invited.invite.token };
}

async function signInAs(userId: string) {
  const row = await userRow(userId);
  jar.set(SESSION_COOKIE_NAME, await signSessionToken({ sub: row.id, sv: row.sessionVersion, k: row.role === "client" ? "client" : "staff" }));
}

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

describe("beginGoogleSignIn", () => {
  it("sends the browser to Google's chooser with PKCE S256, state and nonce bound to a signed, httpOnly, 10-minute cookie", async () => {
    const req = new Request(`${ORIGIN}/api/auth/google/start?intent=signin`);
    const res = await G.beginGoogleSignIn(req, { intent: "signin" }, { env: ENV });
    const url = new URL(res.location);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const claims = await verifyPurposeToken<Record<string, unknown>>(res.cookie.value, "google_oauth");
    expect(claims).toMatchObject({ intent: "signin" });
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(claims?.state);
    expect(url.searchParams.get("nonce")).toBe(claims?.nonce);
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge(String(claims?.verifier)));
    expect(res.location).not.toContain(String(claims?.verifier));
    expect(res.cookie).toMatchObject({ name: GOOGLE_OAUTH_COOKIE, options: { httpOnly: true, sameSite: "lax", path: "/api/auth/google", maxAge: 600 } });
    // A session token is never a round-trip token (and the cookie is never a session).
    expect(await verifySessionToken(res.cookie.value)).toBeNull();
  });

  it("every start gets fresh state, nonce and verifier", async () => {
    const a = await start({ intent: "signin" });
    const b = await start({ intent: "signin" });
    expect(new Set([a.state, a.nonce, a.verifier, b.state, b.nonce, b.verifier]).size).toBe(6);
  });

  it("keeps a safe sign-in `next` and drops open redirects", async () => {
    const keep = await verifyPurposeToken<Record<string, unknown>>((await start({ intent: "signin", next: "/jobs?stage=done" })).cookie, "google_oauth");
    expect(keep?.next).toBe("/jobs?stage=done");
    for (const evil of ["//evil.example", "https://evil.example/x", "/\\evil.example", "/login?next=/x", "javascript:alert(1)"]) {
      const claims = await verifyPurposeToken<Record<string, unknown>>((await start({ intent: "signin", next: evil })).cookie, "google_oauth");
      expect(claims?.next, evil).toBeUndefined();
    }
    // `next` belongs to sign-in only.
    const signup = await verifyPurposeToken<Record<string, unknown>>((await start({ intent: "signup", next: "/jobs" })).cookie, "google_oauth");
    expect(signup?.next).toBeUndefined();
  });

  it("not configured → 404, and the route lands on the page's ?google=disabled", async () => {
    const req = new Request(`${ORIGIN}/api/auth/google/start`);
    await expect(G.beginGoogleSignIn(req, {}, { env: {} })).rejects.toThrow(NotFoundError);
    await expect(G.beginGoogleSignIn(req, {}, { env: { GOOGLE_CLIENT_ID: "only-the-id" } })).rejects.toThrow(NotFoundError);
    expect(await G.googleStartRedirect(req, {}, { env: {} })).toEqual({ location: "/login?google=disabled", cookie: null });
    expect((await G.googleStartRedirect(req, { intent: "signin", next: "/jobs" }, { env: {} })).location).toBe("/login?google=disabled&next=%2Fjobs");
    expect((await G.googleStartRedirect(req, { intent: "signup" }, { env: {} })).location).toBe("/signup?google=disabled");
    const token = "A".repeat(43);
    expect((await G.googleStartRedirect(req, { intent: "invite", invite: token }, { env: {} })).location).toBe(`/invite/${token}?google=disabled`);
    const ctx = await contextFor(db, ids.users.client);
    expect((await G.googleStartRedirect(req, { intent: "connect" }, { env: {}, ctx })).location).toBe("/portal/account?google=disabled#google");
  });

  it("refuses bad queries: unknown intent, invite without a well-formed token", async () => {
    const req = new Request(`${ORIGIN}/api/auth/google/start`);
    await expect(G.beginGoogleSignIn(req, { intent: "admin" }, { env: ENV })).rejects.toThrow(ValidationError);
    await expect(G.beginGoogleSignIn(req, { intent: "invite" }, { env: ENV })).rejects.toThrow(ValidationError);
    await expect(G.beginGoogleSignIn(req, { intent: "invite", invite: "short" }, { env: ENV })).rejects.toThrow(ValidationError);
    expect(await G.googleStartRedirect(req, { intent: "invite" }, { env: ENV })).toEqual({ location: "/login?google=failed", cookie: null });
  });

  it("connect needs a signed-in person outside the demo studio, and remembers who and where", async () => {
    const post = new Request(`${ORIGIN}/api/auth/google/connect`, { method: "POST" });
    await expect(G.beginGoogleConnect(db, post, null, { password: TEST_PASSWORD }, { env: ENV })).rejects.toThrow(UnauthorizedError);
    const ownerCtx = await contextFor(db, ids.users.owner);
    const res = await G.beginGoogleConnect(db, post, ownerCtx, { password: TEST_PASSWORD }, { env: ENV });
    expect(await verifyPurposeToken<Record<string, unknown>>(res.cookie.value, "google_oauth")).toMatchObject({ intent: "connect", uid: ids.users.owner, acct: "/settings/account" });
    await expect(G.beginGoogleConnect(db, post, ownerCtx, { password: TEST_PASSWORD }, { env: {} })).rejects.toThrow(NotFoundError);

    await db.update(schema.organisations).set({ isDemo: true }).where(eq(schema.organisations.id, ids.organisationId));
    const demoCtx = await contextFor(db, ids.users.owner);
    await expect(G.beginGoogleConnect(db, post, demoCtx, { password: TEST_PASSWORD }, { env: ENV })).rejects.toThrow(ForbiddenError);
  });

  it("SEC-03: Connect Google asks for the current password; a GET (old link, bookmark, forged page) never starts it", async () => {
    const get = new Request(`${ORIGIN}/api/auth/google/start?intent=connect`);
    const ownerCtx = await contextFor(db, ids.users.owner);
    // GET: signed out → /login; signed in → the account page's Google card, no round-trip cookie.
    await expect(G.beginGoogleSignIn(get, { intent: "connect" }, { env: ENV })).rejects.toThrow(UnauthorizedError);
    await expect(G.beginGoogleSignIn(get, { intent: "connect" }, { env: ENV, ctx: ownerCtx })).rejects.toThrow(ForbiddenError);
    expect(await G.googleStartRedirect(get, { intent: "connect" }, { env: ENV })).toEqual({ location: "/login", cookie: null });
    expect(await G.googleStartRedirect(get, { intent: "connect" }, { env: ENV, ctx: ownerCtx })).toEqual({ location: "/settings/account#google", cookie: null });
    const clientCtx = await contextFor(db, ids.users.client);
    expect((await G.googleStartRedirect(get, { intent: "connect" }, { env: ENV, ctx: clientCtx })).location).toBe("/portal/account#google");

    // POST without / with a wrong password: a field error, counted with the other wrong-password checks.
    const post = new Request(`${ORIGIN}/api/auth/google/connect`, { method: "POST" });
    const missing = await G.beginGoogleConnect(db, post, ownerCtx, {}, { env: ENV }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ValidationError);
    const wrong = await G.beginGoogleConnect(db, post, ownerCtx, { password: "not-my-password" }, { env: ENV }).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(ValidationError);
    const details = (wrong as { details?: { fieldErrors?: Record<string, string[]> } }).details;
    expect(details?.fieldErrors?.password).toEqual(["That password isn’t right"]);
    expect(await limiters.passwordCheck.hits(db, `user|${ids.users.owner}`, Date.parse(nowIso()))).toHaveLength(1);
    for (let i = 0; i < 9; i += 1) await G.beginGoogleConnect(db, post, ownerCtx, { password: "nope" }, { env: ENV }).catch(() => undefined);
    await expect(G.beginGoogleConnect(db, post, ownerCtx, { password: TEST_PASSWORD }, { env: ENV })).rejects.toThrow(RateLimitedError);
    expect(jar.has(GOOGLE_OAUTH_COOKIE)).toBe(false);

    // An account with no password (nothing to check it against) is told to set one first.
    await db.update(schema.users).set({ hasPassword: false, passwordHash: "!invite!none" }).where(eq(schema.users.id, ids.users.editor1));
    const editorCtx = await contextFor(db, ids.users.editor1);
    await expect(G.beginGoogleConnect(db, post, editorCtx, { password: "anything" }, { env: ENV })).rejects.toThrow(RuleViolationError);
  });
});

/* ------------------------------------------------------------------ */
/*  Callback: protocol failures                                        */
/* ------------------------------------------------------------------ */

describe("handleGoogleCallback — failures land on a page, never an error", () => {
  it("exchanges the code with the PKCE verifier and the same redirect URI", async () => {
    const started = await start({ intent: "signup" });
    await finish(started);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].get("code")).toBe("4/0Acode");
    expect(tokenCalls[0].get("code_verifier")).toBe(started.verifier);
    expect(tokenCalls[0].get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`);
    expect(tokenCalls[0].get("client_secret")).toBe("shh-secret");
  });

  it("no round-trip cookie → expired (and nothing is exchanged)", async () => {
    const started = await start({ intent: "signin" });
    jar.delete(GOOGLE_OAUTH_COOKIE);
    expect(await finish(started)).toEqual({ location: "/login?google=expired", outcome: "expired" });
    expect(tokenCalls).toHaveLength(0);
  });

  it("a replayed callback finds no cookie: the round trip is single use", async () => {
    await linkFixture(ids.users.editor1, "g-editor", "eve@gmail.com");
    const started = await start({ intent: "signin" });
    const first = await finish(started, { claims: { sub: "g-editor", email: "eve@gmail.com" } });
    expect(first.outcome).toBe("signed_in");
    expect(jar.has(GOOGLE_OAUTH_COOKIE)).toBe(false);
    jar.delete(SESSION_COOKIE_NAME);
    expect((await finish(started, { claims: { sub: "g-editor", email: "eve@gmail.com" } })).outcome).toBe("expired");
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  it("state mismatch (another tab, a forged link) → expired; the cookie is still used up", async () => {
    const started = await start({ intent: "signup" });
    expect(await finish(started, { state: "x".repeat(43) })).toEqual({ location: "/signup?google=expired", outcome: "expired" });
    expect(jar.has(GOOGLE_OAUTH_COOKIE)).toBe(false);
    expect((await finish(started, { state: null })).outcome).toBe("expired");
    expect(tokenCalls).toHaveLength(0);
  });

  it("a tampered or wrong-purpose cookie → expired", async () => {
    const started = await start({ intent: "signin" });
    jar.set(GOOGLE_OAUTH_COOKIE, `${started.cookie.slice(0, -4)}AAAA`);
    expect((await finish(started)).outcome).toBe("expired");
    jar.set(GOOGLE_OAUTH_COOKIE, await signPurposeToken({ state: started.state, nonce: started.nonce, verifier: started.verifier, intent: "signin" }, "google_signup", 600));
    expect((await finish(started)).outcome).toBe("expired");
    jar.set(GOOGLE_OAUTH_COOKIE, await signSessionToken({ sub: ids.users.owner, sv: 1, k: "staff" }));
    expect((await finish(started)).outcome).toBe("expired");
  });

  it("an expired round-trip cookie (over 10 minutes) → expired", async () => {
    const started = await start({ intent: "signin" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await finish(started)).outcome).toBe("expired");
  });

  it("cancelled on Google's page → cancelled, on the page the person came from", async () => {
    expect(await finish(await start({ intent: "signin", next: "/jobs" }), { error: "access_denied" })).toEqual({ location: "/login?google=cancelled&next=%2Fjobs", outcome: "cancelled" });
    expect((await finish(await start({ intent: "signup" }), { error: "access_denied" })).location).toBe("/signup?google=cancelled");
    const { token } = await inviteEditor("sam.cancel@studio.test");
    expect((await finish(await start({ intent: "invite", invite: token }), { error: "access_denied" })).location).toBe(`/invite/${token}?google=cancelled`);
    await signInAs(ids.users.owner);
    const ownerCtx = await contextFor(db, ids.users.owner);
    expect((await finish(await start({ intent: "connect" }, ownerCtx), { error: "access_denied" })).location).toBe("/settings/account?google=cancelled#google");
    expect(tokenCalls).toHaveLength(0);
  });

  it("any other Google error, a missing code, a failed exchange → failed", async () => {
    expect((await finish(await start({ intent: "signin" }), { error: "server_error" })).outcome).toBe("failed");
    expect((await finish(await start({ intent: "signin" }), { code: null })).outcome).toBe("failed");
    expect((await finish(await start({ intent: "signin" }), { fetch: tokenEndpoint(null) })).location).toBe("/login?google=failed");
    const throwing: FetchLike = async () => {
      throw new TypeError("network down");
    };
    expect((await finish(await start({ intent: "signin" }), { fetch: throwing })).outcome).toBe("failed");
  });

  it("bad id_tokens → failed: wrong nonce, audience, issuer, expired", async () => {
    for (const claims of [{ nonce: "someone-elses-nonce" }, { aud: "other-client.apps.googleusercontent.com" }, { iss: "https://evil.example" }, { exp: nowS() - 600 }]) {
      const result = await finish(await start({ intent: "signin" }), { claims });
      expect(result.outcome, JSON.stringify(claims)).toBe("failed");
    }
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(jar.has(GOOGLE_SIGNUP_COOKIE)).toBe(false);
  });

  it("email not verified by Google → unverified_email; nothing is linked or created", async () => {
    await db.update(schema.users).set({ emailVerifiedAt: null }).where(eq(schema.users.id, ids.users.owner));
    const result = await finish(await start({ intent: "signin" }), { claims: { email: ids.emails.owner, hd: "studio.test", email_verified: false } });
    expect(result).toEqual({ location: "/login?google=unverified_email", outcome: "unverified_email" });
    expect((await userRow(ids.users.owner)).googleSub).toBeNull();
    expect(jar.has(GOOGLE_SIGNUP_COOKIE)).toBe(false);
  });

  it("Google not configured → disabled, and the round-trip cookie is still cleared", async () => {
    const started = await start({ intent: "signin" });
    expect(await finish(started, { env: {} })).toEqual({ location: "/login?google=disabled", outcome: "disabled" });
    expect(jar.has(GOOGLE_OAUTH_COOKIE)).toBe(false);
  });

  it("rate limit: 30 callbacks / 15 min per IP, counted on every callback → failed", async () => {
    const env = { ...ENV, TRUSTED_PROXY_COUNT: "1" };
    const headers = { "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < 29; i += 1) await limiters.googleCallback.hit(db, ipKey("203.0.113.7"));
    const ok = await finish(await start({ intent: "signup" }), { env, headers });
    expect(ok.outcome).toBe("signup_pending");
    expect(await limiters.googleCallback.hits(db, ipKey("203.0.113.7"))).toHaveLength(30);
    const blocked = await finish(await start({ intent: "signup" }), { env, headers });
    expect(blocked).toEqual({ location: "/signup?google=failed", outcome: "failed" });
    // Another network is unaffected.
    expect((await finish(await start({ intent: "signup" }), { env, headers: { "x-forwarded-for": "198.51.100.1" } })).outcome).toBe("signup_pending");
  });

  it("SEC-10: without a known client IP nothing is counted — one person can never lock Google sign-in for everybody", async () => {
    // TRUSTED_PROXY_COUNT unset: every forwarding header is ignored, so there is no network to count per.
    for (let i = 0; i < 40; i += 1) await finish(null, { headers: { "x-forwarded-for": "203.0.113.66" } });
    expect(await limiters.googleCallback.hits(db, ipKey(null))).toHaveLength(0);
    expect((await finish(await start({ intent: "signup" }))).outcome).toBe("signup_pending");
  });
});

/* ------------------------------------------------------------------ */
/*  Callback: known Google accounts                                    */
/* ------------------------------------------------------------------ */

describe("handleGoogleCallback — a Google account Proofline already knows", () => {
  it("signs in as the linked account: session cookie, landing by role, auth.logged_in (method google)", async () => {
    await linkFixture(ids.users.editor1, "g-editor", "eve@gmail.com");
    const result = await roundTrip({ intent: "signin" }, { sub: "g-editor", email: "eve@gmail.com" });
    expect(result).toEqual({ location: "/my-jobs", outcome: "signed_in" });
    expect(await sessionSub()).toBe(ids.users.editor1);
    await expect(requireContext()).resolves.toMatchObject({ userId: ids.users.editor1 });
    const [event] = await eventsOf("auth.logged_in", ids.users.editor1);
    expect(event.metadata).toMatchObject({ method: "google", userAgent: "vitest-google" });
    expect((await userRow(ids.users.editor1)).lastLoginAt).toBe(nowIso());
  });

  it("honours a safe next; a client lands in the portal", async () => {
    await linkFixture(ids.users.owner, "g-owner", "olivia@gmail.com");
    expect((await roundTrip({ intent: "signin", next: "/settings/people" }, { sub: "g-owner", email: "olivia@gmail.com" })).location).toBe("/settings/people");
    jar.clear();
    await linkFixture(ids.users.client, "g-client", "cleo@gmail.com");
    expect((await roundTrip({ intent: "signin", next: "/jobs" }, { sub: "g-client", email: "cleo@gmail.com" })).location).toBe("/portal");
  });

  it("a forged next inside a (validly signed) round-trip cookie is still sanitised", async () => {
    await linkFixture(ids.users.owner, "g-owner", "olivia@gmail.com");
    const started = await start({ intent: "signin" });
    jar.set(GOOGLE_OAUTH_COOKIE, await signPurposeToken({ state: started.state, nonce: started.nonce, verifier: started.verifier, intent: "signin", next: "//evil.example" }, "google_oauth", 600));
    expect((await finish(started, { claims: { sub: "g-owner", email: "olivia@gmail.com" } })).location).toBe("/home");
  });

  it("a Google account linked to A signs in as A even when its email is now B's address (never as B)", async () => {
    await linkFixture(ids.users.editor1, "g-editor", "eve@gmail.com");
    const result = await roundTrip({ intent: "signin" }, { sub: "g-editor", email: ids.emails.editor2, hd: "studio.test" });
    expect(result.outcome).toBe("signed_in");
    expect(await sessionSub()).toBe(ids.users.editor1);
    expect((await userRow(ids.users.editor2)).googleSub).toBeNull();
  });

  it("a deactivated account → refused (generic), auth.login_failed with method google, no cookie", async () => {
    await linkFixture(ids.users.inactiveEditor, "g-inactive", "iris@gmail.com");
    const result = await roundTrip({ intent: "signin" }, { sub: "g-inactive", email: "iris@gmail.com" });
    expect(result).toEqual({ location: "/login?google=refused", outcome: "refused" });
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    const [failed] = await eventsOf("auth.login_failed", ids.users.inactiveEditor);
    expect(failed.metadata).toMatchObject({ method: "google", reason: "inactive", targetUserId: ids.users.inactiveEditor });
    expect(failed.actorUserId).toBeNull();
  });

  it("a client whose portal is closed → refused", async () => {
    await linkFixture(ids.users.client, "g-client", "cleo@gmail.com");
    await db.update(schema.clients).set({ portalEnabled: false }).where(eq(schema.clients.id, ids.clientId));
    expect((await roundTrip({ intent: "signin" }, { sub: "g-client", email: "cleo@gmail.com" })).outcome).toBe("refused");
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  it("pressing Continue with Google on /signup with a known Google account simply signs in", async () => {
    await linkFixture(ids.users.owner, "g-owner", "olivia@gmail.com");
    expect(await roundTrip({ intent: "signup" }, { sub: "g-owner", email: "olivia@gmail.com" })).toEqual({ location: "/home", outcome: "signed_in" });
  });
});

/* ------------------------------------------------------------------ */
/*  Callback: an account with the same email                           */
/* ------------------------------------------------------------------ */

describe("handleGoogleCallback — an existing account with the same email", () => {
  it("SEC-01: an account WITH a password is never taken over — the address's Google owner is told to sign in with the password", async () => {
    // An attacker creates a studio in the victim's Gmail address and keeps the password…
    const attacker = await signUp(db, { ownerName: "Mallory", email: "victim.person@gmail.com", password: "AttackerPass123", studioName: "Trap Studio", ip: "6.6.6.6" });
    const before = await userRow(attacker.userId);
    // …later the real owner of that address presses Continue with Google (sign-in or sign-up page).
    for (const intent of ["signin", "signup"] as const) {
      jar.clear();
      const query: Record<string, string> = intent === "signin" ? { intent, next: "/jobs" } : { intent };
      const result = await roundTrip(query, { sub: "g-real-victim", email: "victim.person@gmail.com", name: "Real Victim" });
      expect(result).toEqual({ location: intent === "signin" ? "/login?google=use_password&next=%2Fjobs" : "/login?google=use_password", outcome: "use_password" });
      expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
      expect(jar.has(GOOGLE_SIGNUP_COOKIE)).toBe(false);
    }
    // Nothing was linked or confirmed, and the account is exactly as it was.
    const after = await userRow(attacker.userId);
    expect(after).toMatchObject({ googleSub: null, googleEmail: null, emailVerifiedAt: null, sessionVersion: before.sessionVersion, version: before.version });
    expect(await eventsOf("user.google_connected", attacker.userId)).toHaveLength(0);
    expect((await eventsOf("auth.login_failed", attacker.userId))[0].metadata).toMatchObject({ method: "google", reason: "has_password" });
    // The same answer for an existing, confirmed account: Google never links by email when a password exists.
    const pia = await roundTrip({ intent: "signin" }, { sub: "g-pia", email: ids.emails.photographer1.toUpperCase(), hd: "studio.test" });
    expect(pia.outcome).toBe("use_password");
    expect((await userRow(ids.users.photographer1)).googleSub).toBeNull();
    // The way in that remains: password, then Connect Google (password-checked) on My account.
    await expect(authenticate(db, { email: "victim.person@gmail.com", password: "AttackerPass123" })).resolves.toMatchObject({ id: attacker.userId });
  });

  it("SEC-02: a sign-in's next with a TAB / LF / backslash never leaves the site", async () => {
    await linkFixture(ids.users.owner, "g-olivia", "olivia@gmail.com");
    for (const next of ["/\t/evil.example/x", "/\n/evil.example", "/\\evil.example"]) {
      jar.clear();
      const result = await roundTrip({ intent: "signin", next }, { sub: "g-olivia", email: "olivia@gmail.com" });
      expect(result, JSON.stringify(next)).toEqual({ location: "/home", outcome: "signed_in" });
    }
  });

  it("an account WITHOUT a password (nothing anybody could have chosen) is linked: Google is the authority for the address", async () => {
    await db
      .update(schema.users)
      .set({ emailVerifiedAt: null, hasPassword: false, passwordHash: "!invite!google-only" })
      .where(eq(schema.users.id, ids.users.photographer1));
    const before = await userRow(ids.users.photographer1);
    const result = await roundTrip({ intent: "signin" }, { sub: "g-pia", email: ids.emails.photographer1.toUpperCase(), hd: "studio.test" });
    expect(result).toEqual({ location: "/home", outcome: "linked" });
    const after = await userRow(ids.users.photographer1);
    expect(after).toMatchObject({ googleSub: "g-pia", googleEmail: ids.emails.photographer1, emailVerifiedAt: nowIso(), version: before.version + 1, sessionVersion: before.sessionVersion });
    expect(await sessionSub()).toBe(ids.users.photographer1);
    const [connected] = await eventsOf("user.google_connected", ids.users.photographer1);
    expect(connected).toMatchObject({ actorUserId: ids.users.photographer1, organisationId: ids.organisationId, visibility: "management" });
    expect(connected.metadata).toMatchObject({ via: "sign_in", targetUserId: ids.users.photographer1 });
    expect(connected.newValue).toMatchObject({ googleEmail: ids.emails.photographer1 });
    const [confirmed] = await eventsOf("user.email_confirmed", ids.users.photographer1);
    expect(confirmed.metadata).toMatchObject({ via: "google" });
    expect((await eventsOf("auth.logged_in", ids.users.photographer1))[0].metadata).toMatchObject({ method: "google" });
  });

  it("an address Google is not the authority for (no Workspace domain) is never linked to an existing account", async () => {
    const result = await roundTrip({ intent: "signin" }, { sub: "g-pia", email: ids.emails.photographer1 });
    expect(result).toEqual({ location: "/login?google=refused", outcome: "refused" });
    expect((await userRow(ids.users.photographer1)).googleSub).toBeNull();
    expect((await eventsOf("auth.login_failed", ids.users.photographer1))[0].metadata).toMatchObject({ method: "google", reason: "google_not_authoritative" });
    expect(jar.has(GOOGLE_SIGNUP_COOKIE)).toBe(false);
  });

  it("an account already tied to a different Google account is not swapped → refused", async () => {
    await linkFixture(ids.users.photographer1, "g-old", "pia.old@gmail.com");
    expect((await roundTrip({ intent: "signin" }, { sub: "g-new-pia", email: ids.emails.photographer1, hd: "studio.test" })).outcome).toBe("refused");
    expect((await userRow(ids.users.photographer1)).googleSub).toBe("g-old");
  });

  it("deactivated → refused, nothing linked", async () => {
    expect((await roundTrip({ intent: "signin" }, { sub: "g-iris", email: ids.emails.inactiveEditor, hd: "studio.test" })).outcome).toBe("refused");
    expect((await userRow(ids.users.inactiveEditor)).googleSub).toBeNull();
    expect((await eventsOf("auth.login_failed", ids.users.inactiveEditor))[0].metadata).toMatchObject({ reason: "inactive" });
  });

  it("a client whose portal is off → refused BEFORE anything is linked", async () => {
    await db.update(schema.clients).set({ portalEnabled: false }).where(eq(schema.clients.id, ids.clientId));
    expect((await roundTrip({ intent: "signin" }, { sub: "g-cleo", email: ids.emails.client, hd: "studio.test" })).outcome).toBe("refused");
    expect((await userRow(ids.users.client)).googleSub).toBeNull();
  });

  it("a demo studio account is never linked → refused", async () => {
    jar.clear();
    const demoDb = await makeTestDb();
    const demoIds = await seedMinimalOrg(demoDb, { isDemo: true, slug: "demo", emailDomain: "demo.test" });
    db = demoDb;
    ids = demoIds;
    setDbOverride(demoDb);
    expect((await roundTrip({ intent: "signin" }, { sub: "g-demo-owner", email: demoIds.emails.owner, hd: "demo.test" })).outcome).toBe("refused");
    expect((await userRow(demoIds.users.owner)).googleSub).toBeNull();
    expect((await eventsOf("auth.login_failed", demoIds.users.owner))[0].metadata).toMatchObject({ reason: "demo" });
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  it("a pending invitee with a live invite joins with Google: accepted, linked, confirmed, signed in", async () => {
    const { userId } = await inviteEditor("sam@studio.test");
    const before = await userRow(userId);
    const result = await roundTrip({ intent: "signin" }, { sub: "g-sam", email: "sam@studio.test", hd: "studio.test" });
    expect(result).toEqual({ location: "/my-jobs", outcome: "invite_accepted" });
    const after = await userRow(userId);
    expect(after.acceptedAt).toBe(nowIso());
    expect(after).toMatchObject({ hasPassword: false, googleSub: "g-sam", googleEmail: "sam@studio.test", sessionVersion: before.sessionVersion + 1 });
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(await verifySessionToken(jar.get(SESSION_COOKIE_NAME))).toMatchObject({ sub: userId, sv: before.sessionVersion + 1 });
    expect((await eventsOf("user.accepted_invite", userId))[0].metadata).toMatchObject({ via: "google" });
    expect((await eventsOf("user.google_connected", userId))[0].metadata).toMatchObject({ via: "invite" });
    // The invite link is used up.
    const [token] = await db.select().from(schema.authTokens).where(and(eq(schema.authTokens.userId, userId), eq(schema.authTokens.kind, "invite")));
    expect(token.usedAt).not.toBeNull();
  });

  it("a pending invitee whose invite was revoked has no way in → refused", async () => {
    const { userId } = await inviteEditor("sam.revoked@studio.test");
    const ownerCtx = await contextFor(db, ids.users.owner);
    await withTx((tx) => revokeInvite(tx, ownerCtx, { userId }), { db });
    expect((await roundTrip({ intent: "signin" }, { sub: "g-sam", email: "sam.revoked@studio.test", hd: "studio.test" })).outcome).toBe("refused");
    expect((await userRow(userId))).toMatchObject({ acceptedAt: null, googleSub: null });
    expect((await eventsOf("auth.login_failed", userId))[0].metadata).toMatchObject({ reason: "invite_not_live" });
  });
});

/* ------------------------------------------------------------------ */
/*  Callback: nobody yet                                               */
/* ------------------------------------------------------------------ */

describe("handleGoogleCallback — a new person", () => {
  it("sign-in page: the finish cookie + /signup/google?from=signin; nothing is created yet", async () => {
    const users = (await db.select().from(schema.users)).length;
    const result = await roundTrip({ intent: "signin" }, { sub: "g-nia", email: "Nia@Gmail.com", name: "Nia Newbie" });
    expect(result).toEqual({ location: "/signup/google?from=signin", outcome: "signup_pending" });
    expect((await db.select().from(schema.users)).length).toBe(users);
    expect(await G.readPendingGoogleSignUp()).toEqual({ email: "nia@gmail.com", name: "Nia Newbie" });
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  it("sign-up page: /signup/google", async () => {
    expect(await roundTrip({ intent: "signup" }, { sub: "g-nia" })).toEqual({ location: "/signup/google", outcome: "signup_pending" });
  });

  it("the finish page reads nothing from a missing, tampered or wrong-purpose cookie", async () => {
    expect(await G.readPendingGoogleSignUp()).toBeNull();
    jar.set(GOOGLE_SIGNUP_COOKIE, await signPurposeToken({ sub: "g", email: "x@gmail.com" }, "google_oauth", 600));
    expect(await G.readPendingGoogleSignUp()).toBeNull();
    jar.set(GOOGLE_SIGNUP_COOKIE, "garbage");
    expect(await G.readPendingGoogleSignUp()).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Callback: the invite page                                          */
/* ------------------------------------------------------------------ */

describe("handleGoogleCallback — Continue with Google on an invite", () => {
  it("accepts the invite through the shared core: same address Google is the authority for → email confirmed", async () => {
    const { userId, token } = await inviteEditor("sam@studio.test");
    await db.update(schema.users).set({ emailVerifiedAt: null }).where(eq(schema.users.id, userId));
    const result = await roundTrip({ intent: "invite", invite: token }, { sub: "g-sam", email: "sam@studio.test", hd: "studio.test" });
    expect(result).toEqual({ location: "/my-jobs", outcome: "invite_accepted" });
    const after = await userRow(userId);
    expect(after).toMatchObject({ googleSub: "g-sam", googleEmail: "sam@studio.test", hasPassword: false });
    expect(after.acceptedAt).not.toBeNull();
    expect(after.emailVerifiedAt).not.toBeNull();
    expect((await eventsOf("user.accepted_invite", userId))[0].metadata).toMatchObject({ via: "google" });
    expect((await eventsOf("user.google_connected", userId))[0].metadata).toMatchObject({ via: "invite" });
    await expect(requireAnyContext()).resolves.toMatchObject({ userId });
  });

  it("the same address but Google is not its authority (no Workspace domain): joins, the email stays unconfirmed", async () => {
    const { userId, token } = await inviteEditor("sam@studio.test");
    await db.update(schema.users).set({ emailVerifiedAt: null }).where(eq(schema.users.id, userId));
    expect((await roundTrip({ intent: "invite", invite: token }, { sub: "g-sam", email: "sam@studio.test" })).outcome).toBe("invite_accepted");
    expect(await userRow(userId)).toMatchObject({ googleSub: "g-sam", emailVerifiedAt: null });
  });

  it("a different Google address still joins, but the invited email stays unconfirmed", async () => {
    const { userId, token } = await inviteEditor("sam@studio.test");
    await db.update(schema.users).set({ emailVerifiedAt: null }).where(eq(schema.users.id, userId));
    expect((await roundTrip({ intent: "invite", invite: token }, { sub: "g-sam", email: "sam.personal@gmail.com" })).outcome).toBe("invite_accepted");
    expect(await userRow(userId)).toMatchObject({ email: "sam@studio.test", googleEmail: "sam.personal@gmail.com", emailVerifiedAt: null });
  });

  it("a dead invite → back to /invite/<token> (the dead-link card); nothing changes", async () => {
    const { userId, token } = await inviteEditor("sam@studio.test");
    const ownerCtx = await contextFor(db, ids.users.owner);
    await withTx((tx) => revokeInvite(tx, ownerCtx, { userId }), { db });
    expect(await roundTrip({ intent: "invite", invite: token }, { sub: "g-sam", email: "sam@studio.test" })).toEqual({ location: `/invite/${token}`, outcome: "invite_dead" });
    expect(await userRow(userId)).toMatchObject({ acceptedAt: null, googleSub: null });
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  it("a Google account already linked to someone else → linked_elsewhere; the invite stays live", async () => {
    await linkFixture(ids.users.editor1, "g-taken", "eve@gmail.com");
    const { userId, token } = await inviteEditor("sam@studio.test");
    expect(await roundTrip({ intent: "invite", invite: token }, { sub: "g-taken", email: "eve@gmail.com" })).toEqual({ location: `/invite/${token}?google=linked_elsewhere`, outcome: "linked_elsewhere" });
    expect((await userRow(userId)).acceptedAt).toBeNull();
    const { findLiveInvite } = await import("./invites");
    expect(await findLiveInvite(db, token, nowIso())).not.toBeNull();
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  it("a client invitee whose portal is closed → refused on the invite page; not accepted", async () => {
    const ownerCtx = await contextFor(db, ids.users.owner);
    const invited = await withTx((tx) => inviteUser(tx, ownerCtx, { email: "buyer@harbour.test", name: "Bea Buyer", role: "client", clientId: ids.clientId }), { db });
    const token = invited.invite?.token ?? "";
    await db.update(schema.clients).set({ portalEnabled: false }).where(eq(schema.clients.id, ids.clientId));
    expect(await roundTrip({ intent: "invite", invite: token }, { sub: "g-bea", email: "buyer@harbour.test" })).toEqual({ location: `/invite/${token}?google=refused`, outcome: "refused" });
    expect(await userRow(invited.user.id)).toMatchObject({ acceptedAt: null, googleSub: null });
  });
});

/* ------------------------------------------------------------------ */
/*  Callback: Connect Google (My account)                              */
/* ------------------------------------------------------------------ */

describe("handleGoogleCallback — Connect Google on My account", () => {
  it("links the signed-in person, audits via connect, comes back to the card, and tells the account's address (SEC-03)", async () => {
    await signInAs(ids.users.editor1);
    const ctx = await contextFor(db, ids.users.editor1);
    const before = await userRow(ids.users.editor1);
    const mail = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = await roundTrip({ intent: "connect" }, { sub: "g-eve", email: "eve.personal@gmail.com" }, ctx);
    expect(result).toEqual({ location: "/settings/account?google=connected#google", outcome: "connected" });
    // "Google sign-in was added" goes to the ACCOUNT's address (the console provider logs subject + recipient).
    expect(mail.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringContaining(`"Google sign-in was added to your Proofline account" to ${ids.emails.editor1}`));
    mail.mockRestore();
    expect(await userRow(ids.users.editor1)).toMatchObject({ googleSub: "g-eve", googleEmail: "eve.personal@gmail.com", sessionVersion: before.sessionVersion });
    const [event] = await eventsOf("user.google_connected", ids.users.editor1);
    expect(event.metadata).toMatchObject({ via: "connect" });
    expect(event.actorUserId).toBe(ids.users.editor1);
    // A different address: the account email's confirmation is untouched.
    expect(await eventsOf("user.email_confirmed", ids.users.editor1)).toHaveLength(0);
  });

  it("a client comes back to the portal's account page", async () => {
    await signInAs(ids.users.client);
    const ctx = await contextFor(db, ids.users.client);
    expect((await roundTrip({ intent: "connect" }, { sub: "g-cleo", email: "cleo@gmail.com" }, ctx)).location).toBe("/portal/account?google=connected#google");
  });

  it("the same Google address (authoritative) also confirms the account email", async () => {
    await db.update(schema.users).set({ emailVerifiedAt: null }).where(eq(schema.users.id, ids.users.owner));
    await signInAs(ids.users.owner);
    const ctx = await contextFor(db, ids.users.owner);
    await roundTrip({ intent: "connect" }, { sub: "g-olivia", email: ids.emails.owner, hd: "studio.test" }, ctx);
    expect((await userRow(ids.users.owner)).emailVerifiedAt).toBe(nowIso());
    expect((await eventsOf("user.email_confirmed", ids.users.owner))[0].metadata).toMatchObject({ via: "google" });
  });

  it("a Google account linked to someone else → linked_elsewhere, nothing changes", async () => {
    await linkFixture(ids.users.editor2, "g-shared", "ed@gmail.com");
    await signInAs(ids.users.editor1);
    const ctx = await contextFor(db, ids.users.editor1);
    expect(await roundTrip({ intent: "connect" }, { sub: "g-shared", email: "ed@gmail.com" }, ctx)).toEqual({ location: "/settings/account?google=linked_elsewhere#google", outcome: "linked_elsewhere" });
    expect((await userRow(ids.users.editor1)).googleSub).toBeNull();
    expect((await userRow(ids.users.editor2)).googleSub).toBe("g-shared");
  });

  it("someone else signed in on this browser meanwhile (or nobody) → expired; nothing is linked", async () => {
    await signInAs(ids.users.editor1);
    const ctx = await contextFor(db, ids.users.editor1);
    const started = await start({ intent: "connect" }, ctx);
    await signInAs(ids.users.editor2);
    expect(await finish(started, { claims: { sub: "g-eve" } })).toEqual({ location: "/login?google=expired", outcome: "expired" });
    const again = await start({ intent: "connect" }, ctx);
    jar.delete(SESSION_COOKIE_NAME);
    expect((await finish(again, { claims: { sub: "g-eve" } })).outcome).toBe("expired");
    expect((await userRow(ids.users.editor1)).googleSub).toBeNull();
    expect((await userRow(ids.users.editor2)).googleSub).toBeNull();
  });

  it("a session revoked meanwhile (password changed elsewhere) → expired", async () => {
    await signInAs(ids.users.editor1);
    const ctx = await contextFor(db, ids.users.editor1);
    const started = await start({ intent: "connect" }, ctx);
    await db.update(schema.users).set({ sessionVersion: 99 }).where(eq(schema.users.id, ids.users.editor1));
    expect((await finish(started, { claims: { sub: "g-eve" } })).outcome).toBe("expired");
    expect((await userRow(ids.users.editor1)).googleSub).toBeNull();
  });

  it("connecting the same Google account again is a quiet no-op", async () => {
    await linkFixture(ids.users.editor1, "g-eve", "eve@gmail.com");
    await signInAs(ids.users.editor1);
    const ctx = await contextFor(db, ids.users.editor1);
    expect((await roundTrip({ intent: "connect" }, { sub: "g-eve", email: "eve@gmail.com" }, ctx)).outcome).toBe("connected");
    expect(await eventsOf("user.google_connected", ids.users.editor1)).toHaveLength(0);
  });

  it("only ever touches the session person's own row in their own studio", async () => {
    const other = await seedMinimalOrg(db, { slug: "other", emailDomain: "other.test" });
    await signInAs(other.users.editor1);
    const ctx = await contextFor(db, other.users.editor1);
    await roundTrip({ intent: "connect" }, { sub: "g-other-eve", email: "eve.other@gmail.com" }, ctx);
    expect((await userRow(other.users.editor1)).googleSub).toBe("g-other-eve");
    expect((await userRow(ids.users.editor1)).googleSub).toBeNull();
    const [event] = await eventsOf("user.google_connected", other.users.editor1);
    expect(event.organisationId).toBe(other.organisationId);
  });
});

/* ------------------------------------------------------------------ */
/*  Finish a Google sign-up                                            */
/* ------------------------------------------------------------------ */

async function pendingFor(claims: GoogleClaims, intent: "signin" | "signup" = "signup", next?: string) {
  const result = await roundTrip({ intent, ...(next ? { next } : {}) }, { sub: "g-nia", email: "nia@gmail.com", name: "Nia Newbie", ...claims });
  expect(result.outcome).toBe("signup_pending");
}

describe("completeGoogleSignUp", () => {
  it("creates the studio with a Google-only owner (no password, email confirmed), signs them in, clears the finish cookie", async () => {
    await pendingFor({});
    const result = await G.completeGoogleSignUp(db, { studioName: "Nia Photo", timezone: "Australia/Perth", ip: "203.0.113.9", userAgent: "vitest" }, { requestId: "req-g" });
    expect(result).toMatchObject({ redirectTo: "/home", user: { name: "Nia Newbie", email: "nia@gmail.com", role: "photographer" } });
    const owner = await userRow(result.user.id);
    expect(owner).toMatchObject({ hasPassword: false, googleSub: "g-nia", googleEmail: "nia@gmail.com", emailVerifiedAt: nowIso(), lastLoginAt: nowIso(), isAdmin: true, role: "photographer" });
    expect(owner.passwordHash.startsWith("$2")).toBe(false);
    const [org] = await db.select().from(schema.organisations).where(eq(schema.organisations.id, result.organisationId));
    expect(org).toMatchObject({ name: "Nia Photo", slug: result.slug, isDemo: false });
    expect(jar.has(GOOGLE_SIGNUP_COOKIE)).toBe(false);
    expect(jar.get(SIGNED_UP_COOKIE_NAME)).toBe("1");
    expect(await sessionSub()).toBe(result.user.id);
    await expect(requireContext()).resolves.toMatchObject({ userId: result.user.id, organisationId: result.organisationId, isAdmin: true, isPrimaryOwner: true });
    expect((await eventsOf("org.created")).filter((e) => e.organisationId === result.organisationId)[0].metadata).toMatchObject({ cause: "signup" });
    expect((await eventsOf("auth.logged_in", result.user.id))[0].metadata).toMatchObject({ method: "google", ip: "203.0.113.9" });
    expect((await eventsOf("user.google_connected", result.user.id))[0].metadata).toMatchObject({ via: "signup" });
    // The default structure is there (one workflow, the usual types of shoot).
    expect((await db.select().from(schema.jobTypes).where(eq(schema.jobTypes.organisationId, result.organisationId))).length).toBeGreaterThan(0);
  });

  it("uses the edited name, and a sign-in's safe next", async () => {
    await pendingFor({}, "signin", "/settings/people");
    const result = await G.completeGoogleSignUp(db, { studioName: "Nia Photo", ownerName: "  Nia N.  " });
    expect(result.user.name).toBe("Nia N.");
    expect(result.redirectTo).toBe("/settings/people");
  });

  it("no / expired / tampered finish cookie → 400 'Start again', with a reason the form recognises", async () => {
    const err = await G.completeGoogleSignUp(db, { studioName: "Nia Photo" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as InstanceType<typeof ValidationError>).message).toBe(G.GOOGLE_SIGNUP_EXPIRED_MESSAGE);
    expect((err as InstanceType<typeof ValidationError>).details).toMatchObject({ reason: G.GOOGLE_SIGNUP_EXPIRED_REASON });
    jar.set(GOOGLE_SIGNUP_COOKIE, await signPurposeToken({ sub: "g", email: "x@gmail.com" }, "google_oauth", 600));
    await expect(G.completeGoogleSignUp(db, { studioName: "Nia Photo" })).rejects.toThrow(G.GOOGLE_SIGNUP_EXPIRED_MESSAGE);
    await pendingFor({});
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await expect(G.completeGoogleSignUp(db, { studioName: "Nia Photo" })).rejects.toThrow(G.GOOGLE_SIGNUP_EXPIRED_MESSAGE);
    vi.useRealTimers();
    expect(await userByEmail("nia@gmail.com")).toBeUndefined();
  });

  it("field errors: studio name too short, unknown fields refused", async () => {
    await pendingFor({});
    const err = (await G.completeGoogleSignUp(db, { studioName: "N" }).catch((e: unknown) => e)) as InstanceType<typeof ValidationError>;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toMatchObject({ fieldErrors: { studioName: [expect.stringMatching(/at least 2/)] } });
    await expect(G.completeGoogleSignUp(db, { studioName: "Nia Photo", email: "hijack@evil.test" })).rejects.toThrow(ValidationError);
    expect(await userByEmail("nia@gmail.com")).toBeUndefined();
    expect(await userByEmail("hijack@evil.test")).toBeUndefined();
  });

  it("the honeypot → the generic refusal, nothing created", async () => {
    await pendingFor({});
    await expect(G.completeGoogleSignUp(db, { studioName: "Nia Photo", website: "http://spam.example" })).rejects.toThrow(G.GOOGLE_SIGNUP_REFUSED_MESSAGE);
    expect(await userByEmail("nia@gmail.com")).toBeUndefined();
    // An empty honeypot is fine.
    await expect(G.completeGoogleSignUp(db, { studioName: "Nia Photo", website: "" })).resolves.toMatchObject({ redirectTo: "/home" });
  });

  it("the honeypot answers exactly like the email sign-up: before validation, and it still counts toward the limit", async () => {
    await pendingFor({});
    const { SIGNUP_REFUSED_MESSAGE } = await import("./organisations");
    expect(G.GOOGLE_SIGNUP_REFUSED_MESSAGE).toBe(SIGNUP_REFUSED_MESSAGE);
    for (let i = 0; i < 4; i += 1) await limiters.signup.hit(db, signupKey("203.0.113.77", "someone@else.test"));
    // An invalid studio name too: a bot never gets field errors to learn from.
    const bot = (await G.completeGoogleSignUp(db, { studioName: "N", website: "http://spam.example", ip: "203.0.113.77" }).catch((e: unknown) => e)) as InstanceType<typeof ValidationError>;
    expect(bot).toBeInstanceOf(ValidationError);
    expect(bot.message).toBe(SIGNUP_REFUSED_MESSAGE);
    expect(bot.details).toMatchObject({ fieldErrors: {} });
    // That was the 5th attempt from this network: the next one is throttled, in the email sign-up's plain words.
    const limited = (await G.completeGoogleSignUp(db, { studioName: "Nia Photo", ip: "203.0.113.77" }).catch((e: unknown) => e)) as InstanceType<typeof RateLimitedError>;
    expect(limited).toBeInstanceOf(RateLimitedError);
    expect(limited.message).toMatch(/^Too many new studios from this network\. Try again in (a minute|\d+ minutes)\.$/);
    expect(await userByEmail("nia@gmail.com")).toBeUndefined();
  });

  it("an address invited meanwhile (link not opened yet) is pointed at the invite link, like the email sign-up", async () => {
    await pendingFor({});
    await inviteEditor("nia@gmail.com", "Nia Invitee");
    const { PENDING_INVITE_MESSAGE } = await import("./organisations");
    await expect(G.completeGoogleSignUp(db, { studioName: "Nia Photo" })).rejects.toThrow(PENDING_INVITE_MESSAGE);
    expect((await db.select().from(schema.organisations).where(eq(schema.organisations.name, "Nia Photo"))).length).toBe(0);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  it("shares the sign-up limit: 5 per hour per network (email AND Google sign-ups)", async () => {
    await pendingFor({});
    for (let i = 0; i < 5; i += 1) await limiters.signup.hit(db, signupKey("203.0.113.9", "someone@else.test"));
    await expect(G.completeGoogleSignUp(db, { studioName: "Nia Photo", ip: "203.0.113.9" })).rejects.toThrow(RateLimitedError);
    expect(await userByEmail("nia@gmail.com")).toBeUndefined();
    await expect(G.completeGoogleSignUp(db, { studioName: "Nia Photo", ip: "198.51.100.4" })).resolves.toMatchObject({ redirectTo: "/home" });
  });

  it("the email or the Google account got an account meanwhile → 400, nothing created", async () => {
    await pendingFor({ email: "race@gmail.com" });
    await db.update(schema.users).set({ email: "race@gmail.com" }).where(eq(schema.users.id, ids.users.photographer2));
    await expect(G.completeGoogleSignUp(db, { studioName: "Race Photo" })).rejects.toThrow(EMAIL_IN_USE_MESSAGE);
    jar.clear();
    await pendingFor({ sub: "g-linked", email: "fresh@gmail.com" });
    await linkFixture(ids.users.editor2, "g-linked", "ed@gmail.com");
    await expect(G.completeGoogleSignUp(db, { studioName: "Race Photo" })).rejects.toThrow(G.GOOGLE_ACCOUNT_TAKEN_MESSAGE);
    expect((await db.select().from(schema.organisations).where(eq(schema.organisations.name, "Race Photo"))).length).toBe(0);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  it("a Google-only owner can't sign in with a password", async () => {
    await pendingFor({});
    await G.completeGoogleSignUp(db, { studioName: "Nia Photo" });
    const { authenticate } = await import("./auth");
    await expect(authenticate(db, { email: "nia@gmail.com", password: "anything-goes-here" })).rejects.toThrow(UnauthorizedError);
  });
});

/* ------------------------------------------------------------------ */
/*  Disconnect                                                         */
/* ------------------------------------------------------------------ */

describe("disconnectGoogle", () => {
  it("clears the link and audits user.google_disconnected", async () => {
    await linkFixture(ids.users.editor1, "g-eve", "eve@gmail.com");
    const ctx = await contextFor(db, ids.users.editor1);
    const before = await userRow(ids.users.editor1);
    await expect(G.disconnectGoogle(db, ctx)).resolves.toEqual({ ok: true, disconnected: true });
    expect(await userRow(ids.users.editor1)).toMatchObject({ googleSub: null, googleEmail: null, version: before.version + 1, sessionVersion: before.sessionVersion });
    const [event] = await eventsOf("user.google_disconnected", ids.users.editor1);
    expect(event).toMatchObject({ actorUserId: ids.users.editor1, previousValue: { googleEmail: "eve@gmail.com" }, visibility: "management" });
    // The Google account now falls through to "link by email" / "new person" again.
    expect((await roundTrip({ intent: "signin" }, { sub: "g-eve", email: "eve@gmail.com" })).outcome).toBe("signup_pending");
  });

  it("nothing connected → ok, nothing recorded", async () => {
    const ctx = await contextFor(db, ids.users.editor1);
    await expect(G.disconnectGoogle(db, ctx)).resolves.toEqual({ ok: true, disconnected: false });
    expect(await eventsOf("user.google_disconnected")).toHaveLength(0);
  });

  it("without a password → 422 (it would leave no way in)", async () => {
    await linkFixture(ids.users.editor1, "g-eve", "eve@gmail.com");
    await db.update(schema.users).set({ hasPassword: false }).where(eq(schema.users.id, ids.users.editor1));
    const ctx = await contextFor(db, ids.users.editor1);
    const err = await G.disconnectGoogle(db, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuleViolationError);
    expect((err as Error).message).toBe(G.GOOGLE_NEEDS_PASSWORD_MESSAGE);
    expect((await userRow(ids.users.editor1)).googleSub).toBe("g-eve");
  });

  it("demo studio → 403; a system context → 401", async () => {
    await linkFixture(ids.users.editor1, "g-eve", "eve@gmail.com");
    await db.update(schema.organisations).set({ isDemo: true }).where(eq(schema.organisations.id, ids.organisationId));
    const ctx = await contextFor(db, ids.users.editor1);
    const err = await G.disconnectGoogle(db, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as InstanceType<typeof ForbiddenError>).action).toBe("demo.sign_in_methods");
    expect((await userRow(ids.users.editor1)).googleSub).toBe("g-eve");
    const { systemContext } = await import("@/server/auth/session");
    await expect(G.disconnectGoogle(db, await systemContext(ids.organisationId, { db }))).rejects.toThrow(UnauthorizedError);
  });

  it("org isolation: a context can only clear its own row in its own studio", async () => {
    const other = await seedMinimalOrg(db, { slug: "other", emailDomain: "other.test" });
    await linkFixture(other.users.editor1, "g-other", "other@gmail.com");
    const ctx = await contextFor(db, ids.users.editor1);
    await expect(G.disconnectGoogle(db, { ...ctx, userId: other.users.editor1 })).rejects.toThrow(NotFoundError);
    expect((await userRow(other.users.editor1)).googleSub).toBe("g-other");
  });
});

/* ------------------------------------------------------------------ */
/*  Where results land                                                 */
/* ------------------------------------------------------------------ */

describe("googleResultLocation", () => {
  it("maps each flow to its page; refused from sign-up goes to sign-in", () => {
    expect(G.googleResultLocation(null, "expired")).toBe("/login?google=expired");
    expect(G.googleResultLocation({ intent: "signin", invite: null, next: "/jobs", acct: null }, "failed")).toBe("/login?google=failed&next=%2Fjobs");
    expect(G.googleResultLocation({ intent: "signup", invite: null, next: null, acct: null }, "cancelled")).toBe("/signup?google=cancelled");
    expect(G.googleResultLocation({ intent: "signup", invite: null, next: null, acct: null }, "refused")).toBe("/login?google=refused");
    expect(G.googleResultLocation({ intent: "signup", invite: null, next: null, acct: null }, "use_password")).toBe("/login?google=use_password");
    expect(G.googleResultLocation({ intent: "connect", invite: null, next: null, acct: "/portal/account" }, "connected")).toBe("/portal/account?google=connected#google");
  });
});

/* ------------------------------------------------------------------ */
/*  POST /api/auth/google/connect                                      */
/* ------------------------------------------------------------------ */

describe("POST /api/auth/google/connect (SEC-03)", () => {
  async function postConnect(body: unknown, headers: Record<string, string> = { origin: ORIGIN }) {
    const route = await import("@/app/api/auth/google/connect/route");
    const req = new Request(`${ORIGIN}/api/auth/google/connect`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const res = await route.POST(req, { params: Promise.resolve({}) });
    return { status: res.status, json: (await res.json()) as { data?: { redirectTo?: string }; error?: { code: string; details?: { fieldErrors?: Record<string, string[]> } } } };
  }

  it("the right password starts the round trip (cookie + Google's URL); a wrong one is a field error; cross-site and signed-out are refused", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "shh-secret");
    try {
      expect((await postConnect({ password: TEST_PASSWORD })).status).toBe(401);
      await signInAs(ids.users.editor1);
      const wrong = await postConnect({ password: "not-it" });
      expect(wrong.status).toBe(400);
      expect(wrong.json.error?.details?.fieldErrors?.password).toEqual(["That password isn’t right"]);
      expect(jar.has(GOOGLE_OAUTH_COOKIE)).toBe(false);
      expect((await postConnect({ password: TEST_PASSWORD }, { origin: "https://evil.example" })).status).toBe(403);
      const ok = await postConnect({ password: TEST_PASSWORD });
      expect(ok.status).toBe(200);
      expect(new URL(ok.json.data?.redirectTo ?? "").origin).toBe("https://accounts.google.com");
      expect(await verifyPurposeToken<Record<string, unknown>>(jar.get(GOOGLE_OAUTH_COOKIE), "google_oauth")).toMatchObject({ intent: "connect", uid: ids.users.editor1 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
