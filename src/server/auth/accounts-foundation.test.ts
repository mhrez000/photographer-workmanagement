/**
 * Accounts foundation (docs/ACCOUNTS-PLAN.md §3): sliding-session renewal, purpose tokens, the shared sign-in
 * helpers, email-confirmation state, the demo helpers, target-email tokens, the shared invite-acceptance core,
 * gated invite delivery and the account-security reads. Drives the real cookie path with an in-memory jar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeedIds, TestDb } from "@/db/test-db";
import { SESSION_COOKIE_NAME } from "@/lib/constants";

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

// The setup file loaded the session module before this mock was registered: load fresh copies.
vi.resetModules();
const { and, eq } = await import("drizzle-orm");
const { setDbOverride } = await import("@/db/index");
const schema = await import("@/db/schema");
const { closeTestDbs, contextFor, dbRejection, fakeClock, makeTestDb, seedMinimalOrg } = await import("@/db/test-db");
const { readSessionClaims, renewSessionToken, signPurposeToken, signSessionToken, verifyPurposeToken, verifySessionToken } = await import("./session-token");
const { buildContextFromDb, systemContext } = await import("./session");
const { SIGN_IN_REFUSED_MESSAGE, startSession } = await import("./sign-in");
const { clearEmailConfirmation, markEmailConfirmed } = await import("./email-confirmation");
const { DEMO_BLOCKED_MESSAGES, assertNotDemo, demoSignInAvailable, demoSignInEnabled, findDemoPersonaUser, isDemoOrganisation, isDemoPersonaEmail } = await import("./demo");
const { googleAuthConfig, googleRedirectUri } = await import("./google-config");
const { issueToken, latestLiveToken } = await import("./tokens");
const { safeNextPath } = await import("./redirect");
const { ForbiddenError, UnauthorizedError } = await import("@/server/errors");
const { withTx } = await import("@/server/services/_shared");
const { completeInviteAcceptance, deliverInvite, findLiveInvite } = await import("@/server/services/invites");
const { inviteUser, updateUser } = await import("@/server/services/users");
const { accountBannerState, getAccountSecurity } = await import("@/server/queries/accountSecurity");

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  setDbOverride(db);
  jar.clear();
});
afterEach(async () => {
  vi.useRealTimers();
  setDbOverride(null);
  fakeClock.reset();
  await closeTestDbs();
});

async function userRow(id: string) {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  return row;
}

async function eventsOf(type: string) {
  return db.select().from(schema.activityEvents).where(eq(schema.activityEvents.eventType, type as never));
}

describe("session tokens: sliding renewal + purpose tokens", () => {
  it("renews a valid token only once it is older than a day, keeping its claims", async () => {
    const fresh = await signSessionToken({ sub: "u1", sv: 3, k: "staff", r: "editor" });
    expect(await renewSessionToken(fresh)).toBeNull();

    vi.useFakeTimers({ now: Date.now() - 25 * 60 * 60 * 1000, toFake: ["Date"] });
    const old = await signSessionToken({ sub: "u1", sv: 3, k: "staff", r: "editor" });
    vi.useRealTimers();
    const renewed = await renewSessionToken(old);
    expect(renewed).toBeTruthy();
    expect(await verifySessionToken(renewed)).toEqual({ sub: "u1", sv: 3, k: "staff", r: "editor" });
    expect((await readSessionClaims(renewed))!.iat).toBeGreaterThan((await readSessionClaims(old))!.iat);

    expect(await renewSessionToken("not-a-token")).toBeNull();
    expect(await renewSessionToken(undefined)).toBeNull();
  });

  it("purpose tokens are bound to their purpose and are never sessions (nor sessions purpose tokens)", async () => {
    const state = await signPurposeToken({ state: "s1", nonce: "n1", sub: "u1", sv: 1 }, "google_oauth", 600);
    expect(await verifyPurposeToken(state, "google_oauth")).toEqual({ state: "s1", nonce: "n1", sub: "u1", sv: 1 });
    expect(await verifyPurposeToken(state, "google_signup")).toBeNull();
    expect(await verifySessionToken(state)).toBeNull();
    const session = await signSessionToken({ sub: "u1", sv: 1 });
    expect(await verifyPurposeToken(session, "google_oauth")).toBeNull();
    expect(await verifyPurposeToken("garbage", "google_oauth")).toBeNull();
  });

  it("safeNextPath keeps same-site paths only", () => {
    expect(safeNextPath("/jobs?x=1")).toBe("/jobs?x=1");
    for (const bad of ["//evil.test", "/\\evil.test", "https://evil.test", "/login?next=/x", 42, null, undefined]) expect(safeNextPath(bad)).toBeNull();
  });
});

describe("startSession", () => {
  it("signs an existing account in: cookie, last_login_at and auth.logged_in with the method", async () => {
    const started = await startSession(db, { userId: ids.users.editor1, method: "demo", ip: "1.2.3.4", userAgent: "vitest" });
    expect(started).toMatchObject({ userId: ids.users.editor1, role: "editor" });
    // `at` = when this browser really signed in (the services' clock), for "recent sign-in" checks (SEC-03).
    expect(await verifySessionToken(jar.get(SESSION_COOKIE_NAME))).toEqual({ sub: ids.users.editor1, sv: started.sessionVersion, k: "staff", r: "editor", at: Date.parse("2026-10-08T00:00:00.000Z") / 1000 });
    expect((await userRow(ids.users.editor1))?.lastLoginAt).toBe("2026-10-08T00:00:00.000Z");
    const [event] = await eventsOf("auth.logged_in");
    expect(event.metadata).toMatchObject({ method: "demo", ip: "1.2.3.4", userAgent: "vitest", cause: "user" });
    expect(event.actorUserId).toBe(ids.users.editor1);
  });

  it("refuses inactive, pending and unknown accounts with the one generic message, setting no cookie", async () => {
    await expect(startSession(db, { userId: ids.users.inactiveEditor, method: "google" })).rejects.toThrow(SIGN_IN_REFUSED_MESSAGE);
    await expect(startSession(db, { userId: "nobody", method: "google" })).rejects.toBeInstanceOf(UnauthorizedError);
    const owner = await contextFor(db, ids.users.owner);
    const invited = await withTx((tx) => inviteUser(tx, owner, { email: "new@studio.test", name: "New Editor", role: "editor" }), { db });
    await expect(startSession(db, { userId: invited.user.id, method: "google" })).rejects.toThrow(SIGN_IN_REFUSED_MESSAGE);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });
});

describe("email confirmation state", () => {
  it("markEmailConfirmed stamps the time once, closes verify links and audits user.email_confirmed", async () => {
    const fresh = await makeTestDb();
    const f = await seedMinimalOrg(fresh, { emailVerified: false });
    const ctx = await contextFor(fresh, f.users.editor1);
    await withTx(
      (tx) => issueToken(tx, { organisationId: f.organisationId, userId: f.users.editor1, kind: "email_verify", createdByUserId: null, now: ctx.now(), targetEmail: f.emails.editor1 }),
      { db: fresh },
    );
    expect(await withTx((tx) => markEmailConfirmed(tx, ctx, { userId: f.users.editor1, via: "link" }), { db: fresh })).toBe(true);
    expect(await withTx((tx) => markEmailConfirmed(tx, ctx, { userId: f.users.editor1, via: "link" }), { db: fresh })).toBe(false);
    const [row] = await fresh.select().from(schema.users).where(eq(schema.users.id, f.users.editor1));
    expect(row?.emailVerifiedAt).toBe("2026-10-08T00:00:00.000Z");
    expect(await latestLiveToken(fresh, f.users.editor1, "email_verify", ctx.now())).toBeNull();
    const events = await fresh.select().from(schema.activityEvents).where(eq(schema.activityEvents.eventType, "user.email_confirmed"));
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ via: "link", targetUserId: f.users.editor1 });
    expect(events[0].visibility).toBe("management");
  });

  it("an admin email change makes the address unconfirmed and closes its links", async () => {
    const owner = await contextFor(db, ids.users.owner);
    await withTx(
      (tx) => issueToken(tx, { organisationId: ids.organisationId, userId: ids.users.editor1, kind: "email_change", createdByUserId: null, now: owner.now(), targetEmail: "x@new.test" }),
      { db },
    );
    const before = await userRow(ids.users.editor1);
    await withTx((tx) => updateUser(tx, owner, { userId: ids.users.editor1, email: "sam@new.test", expectedVersion: before!.version }), { db });
    const after = await userRow(ids.users.editor1);
    expect(after).toMatchObject({ email: "sam@new.test", emailVerifiedAt: null });
    expect(await latestLiveToken(db, ids.users.editor1, "email_change", owner.now())).toBeNull();
    await withTx((tx) => clearEmailConfirmation(tx, { userId: ids.users.owner, now: owner.now() }), { db });
    expect((await userRow(ids.users.owner))?.emailVerifiedAt).toBeNull();
  });

  it("target_email is required for verify / change links and refused for the others (code + CHECK)", async () => {
    const now = "2026-10-08T00:00:00.000Z";
    await expect(
      withTx((tx) => issueToken(tx, { organisationId: ids.organisationId, userId: ids.users.owner, kind: "email_verify", createdByUserId: null, now }), { db }),
    ).rejects.toThrow(/required/);
    await expect(
      withTx((tx) => issueToken(tx, { organisationId: ids.organisationId, userId: ids.users.owner, kind: "invite", createdByUserId: null, now, targetEmail: "a@b.test" }), { db }),
    ).rejects.toThrow(/not allowed/);
    const base = { organisationId: ids.organisationId, userId: ids.users.owner, createdByUserId: null, expiresAt: now, createdAt: now };
    expect(await dbRejection(db.insert(schema.authTokens).values({ ...base, kind: "email_change", tokenHash: "a".repeat(64) }))).toMatch(/auth_tokens_target_email_ck/);
    expect(await dbRejection(db.insert(schema.authTokens).values({ ...base, kind: "bogus" as never, tokenHash: "b".repeat(64) }))).toMatch(/auth_tokens_kind_ck/);
    // fill-once: target_email is immutable
    const issued = await withTx(
      (tx) => issueToken(tx, { organisationId: ids.organisationId, userId: ids.users.owner, kind: "email_verify", createdByUserId: null, now, targetEmail: ids.emails.owner }),
      { db },
    );
    expect(await dbRejection(db.update(schema.authTokens).set({ targetEmail: "evil@x.test" }).where(eq(schema.authTokens.id, issued.tokenId)))).toMatch(/immutable/);
    expect(await dbRejection(db.update(schema.users).set({ googleSub: "g-1" }).where(eq(schema.users.id, ids.users.owner)))).toMatch(/users_google_pair_ck/);
  });
});

describe("demo helpers", () => {
  it("assertNotDemo throws a 403 with plain copy only in a demo studio", () => {
    expect(() => assertNotDemo({ isDemo: false }, "invite")).not.toThrow();
    expect(() => assertNotDemo({}, "invite")).not.toThrow();
    const err = (() => {
      try {
        assertNotDemo({ isDemo: true }, "invite");
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as InstanceType<typeof ForbiddenError>).message).toBe(DEMO_BLOCKED_MESSAGES.invite);
    expect((err as InstanceType<typeof ForbiddenError>).action).toBe("demo.invite");
  });

  it("contexts carry isDemo; persona users are found only inside a demo studio", async () => {
    expect((await contextFor(db, ids.users.owner)).isDemo).toBe(false);
    expect(await findDemoPersonaUser(db, "owner")).toBeNull();
    expect(await demoSignInAvailable(db)).toBe(false);

    const demoDb = await makeTestDb();
    const demo = await seedMinimalOrg(demoDb, { isDemo: true });
    expect((await contextFor(demoDb, demo.users.owner)).isDemo).toBe(true);
    expect((await systemContext(demo.organisationId, { db: demoDb })).isDemo).toBe(true);
    expect(await isDemoOrganisation(demoDb, demo.organisationId)).toBe(true);
    expect((await findDemoPersonaUser(demoDb, "owner"))?.id).toBe(demo.users.owner);
    expect((await findDemoPersonaUser(demoDb, "editor"))?.id).toBe(demo.users.editor1);
    expect((await findDemoPersonaUser(demoDb, "client"))?.id).toBe(demo.users.client);
    expect(await demoSignInAvailable(demoDb, {})).toBe(true);
    expect(await demoSignInAvailable(demoDb, { DEMO_SIGN_IN: "off" })).toBe(false);
    expect(demoSignInEnabled({ DEMO_SIGN_IN: " OFF " })).toBe(false);
    expect(demoSignInEnabled({})).toBe(true);
    expect(isDemoPersonaEmail(" Owner@Studio.test ")).toBe(true);
    expect(isDemoPersonaEmail("owner@other.test")).toBe(false);
  });
});

describe("invites: shared acceptance core and gated delivery", () => {
  it("completeInviteAcceptance (Google path) accepts without a password and confirms only when asked", async () => {
    const owner = await contextFor(db, ids.users.owner);
    const invited = await withTx((tx) => inviteUser(tx, owner, { email: "g@studio.test", name: "Gee", role: "editor" }), { db });
    expect((await userRow(invited.user.id))?.hasPassword).toBe(false);
    const now = "2026-10-08T00:05:00.000Z";
    const result = await withTx(async (tx) => {
      const live = await findLiveInvite(tx, invited.invite!.token, now);
      expect(live?.user.id).toBe(invited.user.id);
      return completeInviteAcceptance(tx, { user: live!.user, tokenId: null, now, via: "google", passwordHash: null, emailConfirmed: false });
    }, { db });
    expect(result).toMatchObject({ userId: invited.user.id, role: "editor", sessionVersion: 2 });
    const row = await userRow(invited.user.id);
    expect(row).toMatchObject({ acceptedAt: now, hasPassword: false, emailVerifiedAt: null });
    expect(await findLiveInvite(db, invited.invite!.token, now)).toBeNull();
    const [event] = await eventsOf("user.accepted_invite");
    expect(event.metadata).toMatchObject({ via: "google" });
    expect(await buildContextFromDb(db, invited.user.id)).not.toBeNull();
  });

  it("deliverInvite says why nothing was emailed", async () => {
    const owner = await contextFor(db, ids.users.owner);
    const invited = await withTx((tx) => inviteUser(tx, owner, { email: "d@studio.test", name: "Dee", role: "editor" }), { db });
    const delivery = await deliverInvite(db, { token: invited.invite!.token, expiresAt: invited.invite!.expiresAt, userId: invited.user.id, inviterUserId: ids.users.owner });
    expect(delivery).toMatchObject({ emailed: false, notSentReason: "not_configured" });
    expect(delivery.inviteUrl).toMatch(/\/invite\//);
  });
});

describe("account reads", () => {
  it("getAccountSecurity describes the signed-in person; accountBannerState decides the banners", async () => {
    const editor = await contextFor(db, ids.users.editor1);
    const overview = await getAccountSecurity(db, editor, {});
    expect(overview).toMatchObject({
      userId: ids.users.editor1,
      email: ids.emails.editor1,
      emailVerifiedAt: "2026-10-08T00:00:00.000Z",
      emailConfigured: false,
      isDemo: false,
      hasPassword: true,
      google: { configured: false, connected: false, email: null },
      pendingEmailChange: null,
      surface: "staff",
      accountPath: "/settings/account",
    });
    await withTx(
      (tx) => issueToken(tx, { organisationId: ids.organisationId, userId: ids.users.editor1, kind: "email_change", createdByUserId: null, now: editor.now(), targetEmail: "Sam@New.test" }),
      { db },
    );
    const configured = { RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.test", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" };
    const again = await getAccountSecurity(db, editor, configured);
    expect(again.pendingEmailChange).toMatchObject({ newEmail: "sam@new.test" });
    expect(again).toMatchObject({ emailConfigured: true, google: { configured: true } });
    const client = await getAccountSecurity(db, await contextFor(db, ids.users.client), {});
    expect(client).toMatchObject({ surface: "portal", accountPath: "/portal/account" });

    const viewer = { role: "editor" as const, email: "sam@x.test", isDemo: false, emailVerifiedAt: null };
    expect(accountBannerState(viewer, {})).toEqual({ demo: false, unconfirmedEmail: null, accountHref: "/settings/account#email", surface: "staff" });
    expect(accountBannerState(viewer, configured).unconfirmedEmail).toBe("sam@x.test");
    expect(accountBannerState({ ...viewer, isDemo: true }, configured)).toMatchObject({ demo: true, unconfirmedEmail: null });
    expect(accountBannerState({ ...viewer, role: "client" }, configured).accountHref).toBe("/portal/account#email");
  });

  it("Google config needs both env vars; the redirect URI follows the app origin", () => {
    expect(googleAuthConfig({})).toBeNull();
    expect(googleAuthConfig({ GOOGLE_CLIENT_ID: "x" })).toBeNull();
    expect(googleAuthConfig({ GOOGLE_CLIENT_ID: " id ", GOOGLE_CLIENT_SECRET: " s " })).toEqual({ clientId: "id", clientSecret: "s" });
    expect(googleRedirectUri(null, { NODE_ENV: "production", APP_URL: "https://photographer-workmanagement.vercel.app" })).toBe(
      "https://photographer-workmanagement.vercel.app/api/auth/google/callback",
    );
    expect(googleRedirectUri(new Request("http://localhost:3130/login"), { NODE_ENV: "development" })).toBe("http://localhost:3130/api/auth/google/callback");
  });

  it("SafeUser never carries the Google id or address", async () => {
    await db.update(schema.users).set({ googleSub: "g-123", googleEmail: "sam@gmail.test" }).where(and(eq(schema.users.id, ids.users.editor1)));
    const owner = await contextFor(db, ids.users.owner);
    const row = await userRow(ids.users.editor1);
    const updated = await withTx((tx) => updateUser(tx, owner, { userId: ids.users.editor1, name: "Sam W", expectedVersion: row!.version }), { db });
    expect(updated).not.toHaveProperty("googleSub");
    expect(updated).not.toHaveProperty("googleEmail");
    expect(JSON.stringify(updated)).not.toContain("g-123");
  });
});
