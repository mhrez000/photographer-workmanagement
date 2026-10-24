/**
 * The accounts review fixes (docs/ACCOUNTS-PLAN.md §8 "Review fixes"), one regression test per finding that is not
 * already covered next to its service:
 *
 *   SEC-05  opening an invite link confirms the address only when a confirmed inviter's invite could be emailed
 *   SEC-06  a browser that signed in before is never locked out by the per-email backstop (known-device cookie)
 *   SEC-09  a sign-in for an account without a usable password costs a full bcrypt (no timing oracle)
 *   SEC-07 / DEMO-01  the demo's Client persona: its client's portal can't be switched off or the client archived
 *   SEC-10  demo sign-in is never one shared bucket when the client IP is unknown
 *   DEMO-02 DEMO_SIGN_IN=off closes the demo studio to its public password too
 *   DATA-02 anonymising closes every link and scrubs the addresses they carried
 *   DATA-04 `has_password` written by older code over an unusable hash never blocks "Set a password"
 *   DATA-05 a demo studio's invites can't be accepted
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeedIds, TestDb } from "@/db/test-db";
import { KNOWN_DEVICE_COOKIE, RATE_LIMITS, SESSION_COOKIE_NAME } from "@/lib/constants";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => {
      if (value) jar.set(name, value);
      else jar.delete(name);
    },
  }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));

vi.resetModules();
const { and, eq } = await import("drizzle-orm");
const { first, setDbOverride } = await import("@/db/index");
const schema = await import("@/db/schema");
const { TEST_PASSWORD, closeTestDbs, contextFor, fakeClock, makeTestDb, seedMinimalOrg } = await import("@/db/test-db");
const { hashPassword, isUsablePasswordHash, verifyAgainstDummy, verifyPassword } = await import("@/server/auth/password");
const { knownDeviceIdFor, knownDeviceToken, readKnownDevice, currentKnownDevice } = await import("@/server/auth/known-device");
const { ForbiddenError, RateLimitedError, UnauthorizedError, ValidationError } = await import("@/server/errors");
const { withTx } = await import("./_shared");
const { authenticate, login } = await import("./auth");
const { acceptInvite, acceptInviteAndSignIn, inviteVouchesForAddress } = await import("./invites");
const { inviteUser, anonymiseUser, deactivateUser } = await import("./users");
const { setPassword } = await import("./account");
const { setClientPortal } = await import("./sharing");
const { archiveClient } = await import("./clients");
const { demoSignIn } = await import("./demo");

let db: TestDb;
let ids: SeedIds;

const MAIL_ON = { RESEND_API_KEY: "re_test", EMAIL_FROM: "Proofline <hello@mail.test>" };

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  setDbOverride(db);
  jar.clear();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  setDbOverride(null);
  fakeClock.reset();
  await closeTestDbs();
});

const userRow = async (id: string) => first(db.select().from(schema.users).where(eq(schema.users.id, id)));

async function invite(email: string, by: keyof SeedIds["users"] = "owner") {
  const ctx = await contextFor(db, ids.users[by]);
  const res = await withTx((tx) => inviteUser(tx, ctx, { email, name: "Sam New", role: "editor" }), { db });
  if (!res.invite) throw new Error("expected a link invite");
  return { userId: res.user.id, token: res.invite.token };
}

/* ------------------------------------------------------------------ */

describe("SEC-05: opening an invite link proves the address only when a confirmed inviter's invite could be emailed", () => {
  it("an unconfirmed owner can't mint 'confirmed' accounts by opening their own links", async () => {
    await db.update(schema.users).set({ emailVerifiedAt: null }).where(eq(schema.users.id, ids.users.owner));
    const ghost = await invite("ghost@anything.example");
    await acceptInvite(db, { token: ghost.token, password: "GhostPassword9!" }, { env: MAIL_ON });
    expect((await userRow(ghost.userId))?.emailVerifiedAt).toBeNull();
  });

  it("without email set up the inviter handed the link over themselves: nothing is proven", async () => {
    const sam = await invite("sam.new@studio.test");
    await acceptInvite(db, { token: sam.token, password: "SamPassword99!" }, { env: {} });
    expect((await userRow(sam.userId))?.emailVerifiedAt).toBeNull();
  });

  it("a confirmed inviter with email set up vouches for the address (no second link for the invitee)", async () => {
    const sam = await invite("sam.ok@studio.test");
    const [token] = await db.select().from(schema.authTokens).where(and(eq(schema.authTokens.userId, sam.userId), eq(schema.authTokens.kind, "invite")));
    expect(await inviteVouchesForAddress(db, token.id, MAIL_ON)).toBe(true);
    expect(await inviteVouchesForAddress(db, token.id, {})).toBe(false);
    await acceptInvite(db, { token: sam.token, password: "SamPassword99!" }, { env: MAIL_ON });
    expect((await userRow(sam.userId))?.emailVerifiedAt).toBe(fakeClock.now());
  });

  it("an invitee left unconfirmed is sent 'Confirm your email' right after joining (dev: a link is issued)", async () => {
    const sam = await invite("sam.join@studio.test");
    await acceptInviteAndSignIn({ token: sam.token, password: "SamPassword99!" }, { db });
    const verify = await db.select().from(schema.authTokens).where(and(eq(schema.authTokens.userId, sam.userId), eq(schema.authTokens.kind, "email_verify")));
    expect(verify).toHaveLength(1);
    expect(verify[0]).toMatchObject({ targetEmail: "sam.join@studio.test", usedAt: null });
    // …and this browser is remembered for the address it just joined with (SEC-06).
    expect(knownDeviceIdFor(await currentKnownDevice(), "sam.join@studio.test")).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("SEC-06: strangers can't lock the owner out of a browser they already use", () => {
  it("known-device cookies: bound to one address, signed, unreadable as anything else", async () => {
    const token = await knownDeviceToken("Owner@Studio.test", "device-abc-123");
    const device = await readKnownDevice(token);
    expect(device?.id).toBe("device-abc-123");
    expect(knownDeviceIdFor(device, " owner@studio.test ")).toBe("device-abc-123");
    expect(knownDeviceIdFor(device, "someone@studio.test")).toBeNull();
    expect(token).not.toContain("owner");
    expect(await readKnownDevice(`${token.slice(0, -2)}xx`)).toBeNull();
    expect(await readKnownDevice("garbage")).toBeNull();
  });

  it("20 guesses from 20 networks lock the address for unknown browsers — never for the owner's own", async () => {
    // The owner signs in once on this browser: it is remembered.
    await login({ email: ids.emails.owner, password: TEST_PASSWORD, ip: "198.51.100.1" }, db);
    expect(jar.has(KNOWN_DEVICE_COOKIE)).toBe(true);
    jar.delete(SESSION_COOKIE_NAME);
    for (let i = 0; i < RATE_LIMITS.loginEmail.attempts; i += 1) {
      await authenticate(db, { email: ids.emails.owner, password: `guess-${i}`, ip: `10.9.${i}.1` }).catch(() => undefined);
    }
    // A stranger's browser (no cookie), even with the right password: locked.
    const stranger = await authenticate(db, { email: ids.emails.owner, password: TEST_PASSWORD, ip: "203.0.113.5" }).catch((e: unknown) => e);
    expect(stranger).toBeInstanceOf(RateLimitedError);
    // The owner's own browser: straight in.
    await expect(login({ email: ids.emails.owner, password: TEST_PASSWORD, ip: "198.51.100.1" }, db)).resolves.toMatchObject({ id: ids.users.owner });
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(true);
  });

  it("the shared demo personas never mark a browser as known", async () => {
    const demoDb = await makeTestDb();
    await seedMinimalOrg(demoDb, { isDemo: true });
    await demoSignIn(demoDb, { persona: "owner", ip: "1.2.3.4" }, { env: {} });
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(true);
    expect(jar.has(KNOWN_DEVICE_COOKIE)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("SEC-09: no timing oracle for accounts without a usable password", () => {
  it("classifies hashes and still burns a full bcrypt on an unusable one", async () => {
    const real = await hashPassword("Something12!", 4);
    expect(isUsablePasswordHash(real)).toBe(true);
    for (const hash of ["!invite!abc", "!anonymised!xyz", "", "$2b$12$short"]) expect(isUsablePasswordHash(hash)).toBe(false);
    await verifyAgainstDummy("warm-up");
    const t0 = performance.now();
    expect(await verifyPassword("anything", "!invite!abc")).toBe(false);
    const unusable = performance.now() - t0;
    const t1 = performance.now();
    await verifyAgainstDummy("anything");
    const dummy = performance.now() - t1;
    // Same order of work (bcrypt cost 12), not the instant "false" of a malformed hash.
    expect(unusable).toBeGreaterThan(dummy * 0.4);
  });
});

/* ------------------------------------------------------------------ */

describe("SEC-07 / DEMO-01: the demo's Client persona can't be locked out by a visitor", () => {
  it("its client's portal can't be switched off, nor the client archived; other clients and real studios are unaffected", async () => {
    await db.update(schema.organisations).set({ isDemo: true }).where(eq(schema.organisations.id, ids.organisationId));
    const owner = await contextFor(db, ids.users.owner);
    const client = await first(db.select().from(schema.clients).where(eq(schema.clients.id, ids.clientId)));
    const off = await withTx((tx) => setClientPortal(tx, owner, { clientId: ids.clientId, portalEnabled: false, expectedVersion: client?.version }), { db }).catch((e: unknown) => e);
    expect(off).toBeInstanceOf(ForbiddenError);
    expect((off as Error).message).toBe("The demo accounts can't be changed. Create your own studio to try this.");
    const archived = await withTx((tx) => archiveClient(tx, owner, { clientId: ids.clientId, expectedVersion: client?.version }), { db }).catch((e: unknown) => e);
    expect(archived).toBeInstanceOf(ForbiddenError);
    expect((await first(db.select().from(schema.clients).where(eq(schema.clients.id, ids.clientId))))).toMatchObject({ portalEnabled: true, archivedAt: null });
    // Feedback can still be switched (it never locks anyone out), and so can another client's portal.
    await expect(withTx((tx) => setClientPortal(tx, owner, { clientId: ids.clientId, feedbackEnabled: false, expectedVersion: client?.version }), { db })).resolves.toBeTruthy();
    const other = await first(db.select().from(schema.clients).where(eq(schema.clients.id, ids.clientId2)));
    await expect(withTx((tx) => setClientPortal(tx, owner, { clientId: ids.clientId2, portalEnabled: false, expectedVersion: other?.version }), { db })).resolves.toBeTruthy();
  });

  it("outside a demo studio the same client can be switched off as usual", async () => {
    const owner = await contextFor(db, ids.users.owner);
    const client = await first(db.select().from(schema.clients).where(eq(schema.clients.id, ids.clientId)));
    await expect(withTx((tx) => setClientPortal(tx, owner, { clientId: ids.clientId, portalEnabled: false, expectedVersion: client?.version }), { db })).resolves.toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */

describe("SEC-10: no site-wide demo bucket when the client IP is unknown", () => {
  it("without a known IP the per-network demo limit is skipped (nobody can lock the demo for everyone)", async () => {
    await db.update(schema.organisations).set({ isDemo: true }).where(eq(schema.organisations.id, ids.organisationId));
    for (let i = 0; i < RATE_LIMITS.demoSignIn.attempts + 5; i += 1) {
      jar.clear();
      await expect(demoSignIn(db, { persona: "editor", ip: null }, { env: {} })).resolves.toMatchObject({ redirectTo: "/my-jobs" });
    }
    expect(await db.select().from(schema.authRateLimits).where(eq(schema.authRateLimits.limiter, "demoSignIn"))).toHaveLength(0);
    // With a known IP it still counts per network.
    for (let i = 0; i < RATE_LIMITS.demoSignIn.attempts; i += 1) await demoSignIn(db, { persona: "editor", ip: "5.5.5.5" }, { env: {} });
    await expect(demoSignIn(db, { persona: "editor", ip: "5.5.5.5" }, { env: {} })).rejects.toThrow(RateLimitedError);
    await expect(demoSignIn(db, { persona: "editor", ip: "5.5.5.6" }, { env: {} })).resolves.toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */

describe("DEMO-02: DEMO_SIGN_IN=off closes the demo studio", () => {
  it("its people can't sign in with the public seeded password either; real studios are unaffected", async () => {
    await db.update(schema.organisations).set({ isDemo: true }).where(eq(schema.organisations.id, ids.organisationId));
    const real = await seedMinimalOrg(db, { slug: "real", emailDomain: "real.test" });
    const off = { DEMO_SIGN_IN: "off" };
    const refused = await authenticate(db, { email: ids.emails.owner, password: TEST_PASSWORD }, { env: off }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(UnauthorizedError);
    expect((refused as Error).message).toBe("Incorrect email or password");
    const [event] = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.eventType, "auth.login_failed"));
    expect(event.metadata).toMatchObject({ reason: "demo_closed" });
    await expect(authenticate(db, { email: real.emails.owner, password: TEST_PASSWORD }, { env: off })).resolves.toMatchObject({ id: real.users.owner });
    // Demo sign-in on: the seeded password still works (e2e and local scripts use it).
    await expect(authenticate(db, { email: ids.emails.owner, password: TEST_PASSWORD }, { env: {} })).resolves.toMatchObject({ id: ids.users.owner });
  });
});

/* ------------------------------------------------------------------ */

describe("DATA-02: anonymising closes every link and scrubs the addresses they carried", () => {
  it("live invite / reset / confirm / email-change links stop working and no private address is left in the ledger", async () => {
    const owner = await contextFor(db, ids.users.owner);
    const now = fakeClock.now();
    const { issueToken } = await import("@/server/auth/tokens");
    await withTx(async (tx) => {
      await issueToken(tx, { organisationId: ids.organisationId, userId: ids.users.editor1, kind: "email_change", createdByUserId: ids.users.editor1, now, targetEmail: "eve.private@personal.example" });
      await issueToken(tx, { organisationId: ids.organisationId, userId: ids.users.editor1, kind: "email_verify", createdByUserId: null, now, targetEmail: ids.emails.editor1 });
      await issueToken(tx, { organisationId: ids.organisationId, userId: ids.users.editor1, kind: "password_reset", createdByUserId: null, now });
    }, { db });
    const editor = await userRow(ids.users.editor1);
    await withTx((tx) => deactivateUser(tx, owner, { userId: ids.users.editor1, expectedVersion: editor?.version }), { db });
    const deactivated = await userRow(ids.users.editor1);
    await withTx((tx) => anonymiseUser(tx, owner, { userId: ids.users.editor1, expectedVersion: deactivated?.version }), { db });

    const tokens = await db.select().from(schema.authTokens).where(eq(schema.authTokens.userId, ids.users.editor1));
    expect(tokens.length).toBeGreaterThanOrEqual(3);
    expect(tokens.every((t) => t.usedAt !== null)).toBe(true);
    expect(tokens.every((t) => t.targetEmail === null)).toBe(true);
    expect(JSON.stringify(tokens)).not.toContain("eve.private@personal.example");
    const [event] = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.eventType, "user.anonymised"));
    expect(event.metadata).toMatchObject({ linksClosed: 3 });
  });
});

/* ------------------------------------------------------------------ */

describe("DATA-04: the stored hash decides whether a password exists", () => {
  it("a has_password flag left true over an unusable hash (older code) still allows 'Set a password'", async () => {
    await db.update(schema.users).set({ hasPassword: true, passwordHash: "!invite!drifted" }).where(eq(schema.users.id, ids.users.editor2));
    const ctx = { ...(await contextFor(db, ids.users.editor2)), signedInAt: Math.floor(Date.parse(fakeClock.now()) / 1000) };
    await expect(setPassword(db, ctx, { password: "BrandNewPass42!" })).resolves.toEqual({ ok: true });
    const row = await userRow(ids.users.editor2);
    expect(row?.hasPassword).toBe(true);
    expect(await verifyPassword("BrandNewPass42!", row?.passwordHash ?? "")).toBe(true);
  });

  it("the flag never lets an unusable hash sign in", async () => {
    await db.update(schema.users).set({ hasPassword: true, passwordHash: "!invite!drifted" }).where(eq(schema.users.id, ids.users.editor2));
    await expect(authenticate(db, { email: ids.emails.editor2, password: "!invite!drifted" })).rejects.toThrow(UnauthorizedError);
  });
});

/* ------------------------------------------------------------------ */

describe("UX-06: reopening your own used invite link says you've already joined", () => {
  it("answers only for the signed-in person's OWN, used link", async () => {
    const { joinedWithInvite } = await import("./invites");
    const sam = await invite("sam.joined@studio.test");
    // Not used yet: nothing to say (the page shows the invite itself).
    expect(await joinedWithInvite(db, { token: sam.token }, sam.userId)).toBeNull();
    await acceptInvite(db, { token: sam.token, password: "SamPassword99!" });
    expect(await joinedWithInvite(db, { token: sam.token }, sam.userId)).toEqual({ studioName: "Studio Studio" });
    // Somebody else signed in with that link in hand learns nothing; garbage tokens neither.
    expect(await joinedWithInvite(db, { token: sam.token }, ids.users.owner)).toBeNull();
    expect(await joinedWithInvite(db, { token: "not-a-token" }, sam.userId)).toBeNull();
  });
});

describe("DATA-05: a demo studio's invites can't be accepted", () => {
  it("a link made before the studio became the demo opens nothing", async () => {
    const pending = await invite("visitor-invite@gmail.example");
    await db.update(schema.organisations).set({ isDemo: true }).where(eq(schema.organisations.id, ids.organisationId));
    const err = await acceptInvite(db, { token: pending.token, password: "StrangerPass99!" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe("This invite link is no longer valid");
    expect((await userRow(pending.userId))?.acceptedAt).toBeNull();
  });
});
