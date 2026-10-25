/**
 * Settings → My account (src/server/services/account.ts; docs/ACCOUNTS-PLAN.md §4 "AREA account"): email change
 * (request / send again / cancel / confirm, configured and not), set a first password, sign out of other devices.
 * Covers refusals, rate limits, the demo studio, dead links, the uniqueness race at confirm, org isolation, the
 * audit trail and the session cookie (an in-memory jar stands in for `next/headers`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeedIds, TestDb } from "@/db/test-db";
import type { EmailMessage, SendEmailResult } from "@/server/email";
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
const { contextFor, fakeClock, makeTestDb, seedMinimalOrg, TEST_PASSWORD } = await import("@/db/test-db");
const { limiters, userKey } = await import("@/server/auth/db-rate-limit");
const { DEMO_BLOCKED_MESSAGES } = await import("@/server/auth/demo");
const { verifyPassword } = await import("@/server/auth/password");
const { buildContextFromDb, requireAnyContext, signSessionToken, verifySessionToken } = await import("@/server/auth/session");
const { issueToken, latestLiveToken } = await import("@/server/auth/tokens");
const { ForbiddenError, RateLimitedError, RuleViolationError, UnauthorizedError, ValidationError } = await import("@/server/errors");
const { getAccountSecurity } = await import("@/server/queries/accountSecurity");
const { withTx } = await import("./_shared");
const account = await import("./account");
const { changePassword, changePasswordInDb, preparePasswordChange } = await import("./auth");

const {
  ALREADY_HAS_PASSWORD_MESSAGE,
  EMAIL_CHANGE_INVALID_MESSAGE,
  EMAIL_NOW_TAKEN_MESSAGE,
  EMAIL_TAKEN_MESSAGE,
  NO_PASSWORD_FOR_EMAIL_MESSAGE,
  NO_PENDING_CHANGE_MESSAGE,
  SAME_EMAIL_MESSAGE,
  WRONG_PASSWORD_MESSAGE,
  cancelEmailChange,
  confirmEmailChange,
  requestEmailChange,
  resendEmailChange,
  revokeOtherSessions,
  setPassword,
  signOutOtherDevices,
} = account;

const CONFIGURED = { RESEND_API_KEY: "re_test", EMAIL_FROM: "Proofline <hello@example.com>", NODE_ENV: "test" };
const NOT_CONFIGURED = { NODE_ENV: "test" };
const NEW_EMAIL = "fresh.address@elsewhere.test";
const NEW_PASSWORD = "A brand new phrase 42";

type Send = (m: EmailMessage) => Promise<SendEmailResult>;

let db: TestDb;
let ids: SeedIds;
let sent: EmailMessage[];
let send: ReturnType<typeof vi.fn<Send>>;

/** Email set up (a fake provider that records every message). */
const configured = () => ({ email: { env: CONFIGURED, send } });
/** No email provider (the console provider is replaced so nothing is logged). */
const notConfigured = () => ({ email: { env: NOT_CONFIGURED, send } });

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  setDbOverride(db);
  jar.clear();
  sent = [];
  send = vi.fn<Send>(async (m) => {
    sent.push(m);
    return { ok: true, provider: "resend", id: `msg_${sent.length}` };
  });
});
afterEach(() => {
  setDbOverride(null);
  fakeClock.reset();
});

async function userRow(id: string, onDb: TestDb = db) {
  const [row] = await onDb.select().from(schema.users).where(eq(schema.users.id, id));
  return row;
}

async function eventsOf(type: string, onDb: TestDb = db) {
  return onDb.select().from(schema.activityEvents).where(eq(schema.activityEvents.eventType, type as never));
}

async function tokensOf(userId: string, kind: "email_change" | "email_verify") {
  return db
    .select()
    .from(schema.authTokens)
    .where(and(eq(schema.authTokens.userId, userId), eq(schema.authTokens.kind, kind)));
}

/** The plain token inside the "Confirm your new email" message (the only place it ever appears). */
function tokenFrom(message: EmailMessage | undefined): string {
  const m = /\/change-email\?token=([A-Za-z0-9_-]+)/.exec(message?.text ?? "");
  if (!m) throw new Error(`no change-email link in ${message?.subject}`);
  return decodeURIComponent(m[1]);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

function fieldErrorsOf(err: unknown): Record<string, string[]> {
  const details = (err as { details?: { fieldErrors?: Record<string, string[]> } }).details;
  return details?.fieldErrors ?? {};
}

function reasonOf(err: unknown): unknown {
  return (err as { details?: { reason?: unknown } }).details?.reason;
}

/** Owner asks for a change with email set up; returns the plain token from the email. */
async function pendingChange(userId = ids.users.owner, newEmail = NEW_EMAIL): Promise<string> {
  const ctx = await contextFor(db, userId);
  const result = await requestEmailChange(db, ctx, { newEmail, password: TEST_PASSWORD }, configured());
  expect(result.status).toBe("pending");
  return tokenFrom(sent.filter((m) => m.to === newEmail).at(-1));
}

/* ------------------------------------------------------------------ */
/*  requestEmailChange — email set up                                  */
/* ------------------------------------------------------------------ */

describe("requestEmailChange with email set up", () => {
  it("sends a link to the NEW address and a notice to the OLD one; nothing changes yet", async () => {
    const ctx = await contextFor(db, ids.users.owner);
    const before = await userRow(ids.users.owner);
    const result = await requestEmailChange(db, ctx, { newEmail: "  Fresh.Address@Elsewhere.TEST ", password: TEST_PASSWORD, ip: "9.9.9.9" }, configured());

    expect(result).toEqual({ status: "pending", newEmail: NEW_EMAIL, expiresAt: "2026-10-09T00:00:00.000Z", sent: true, reason: null });
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      [NEW_EMAIL, "Confirm your new email address for Proofline"],
      [ids.emails.owner, "Someone asked to change your Proofline email"],
    ]);
    const token = tokenFrom(sent[0]);
    expect(sent[1].text).not.toContain(token);

    // Nothing about the account changed: same address, still confirmed, same versions.
    expect(await userRow(ids.users.owner)).toMatchObject({ email: ids.emails.owner, emailVerifiedAt: before.emailVerifiedAt, version: before.version, sessionVersion: before.sessionVersion });
    const [row] = await tokensOf(ids.users.owner, "email_change");
    expect(row).toMatchObject({ targetEmail: NEW_EMAIL, usedAt: null, createdByUserId: ids.users.owner, organisationId: ids.organisationId });
    expect(row.tokenHash).not.toBe(token);

    const overview = await getAccountSecurity(db, ctx, CONFIGURED);
    expect(overview.pendingEmailChange).toEqual({ newEmail: NEW_EMAIL, expiresAt: "2026-10-09T00:00:00.000Z" });

    const [event] = await eventsOf("user.email_change_requested");
    expect(event).toMatchObject({ action: "requested", actorUserId: ids.users.owner, organisationId: ids.organisationId, visibility: "management" });
    expect(event.previousValue).toEqual({ email: ids.emails.owner });
    expect(event.newValue).toEqual({ pendingEmail: NEW_EMAIL, expiresAt: "2026-10-09T00:00:00.000Z" });
    expect(event.metadata).toMatchObject({ targetUserId: ids.users.owner, superseded: 0, ip: "9.9.9.9" });
    // The plain token is never audited.
    expect(JSON.stringify(event)).not.toContain(token);
  });

  it("asking again supersedes the earlier link", async () => {
    const first = await pendingChange();
    const second = await pendingChange(ids.users.owner, "other.choice@elsewhere.test");
    await expect(confirmEmailChange(db, { token: first })).rejects.toThrow(EMAIL_CHANGE_INVALID_MESSAGE);
    expect((await confirmEmailChange(db, { token: second })).email).toBe("other.choice@elsewhere.test");
    expect((await eventsOf("user.email_change_requested")).map((e) => (e.metadata as { superseded: number }).superseded)).toEqual([0, 1]);
  });

  it("a provider failure keeps the waiting change and hands the link back outside production only", async () => {
    const ctx = await contextFor(db, ids.users.editor1);
    const failing = vi.fn<Send>(async () => ({ ok: false, provider: "resend", error: "boom" }));
    const dev = await requestEmailChange(db, ctx, { newEmail: NEW_EMAIL, password: TEST_PASSWORD }, { email: { env: CONFIGURED, send: failing } });
    expect(dev).toMatchObject({ status: "pending", sent: false, reason: "failed" });
    expect(dev.status === "pending" && dev.devLink).toMatch(/\/change-email\?token=[A-Za-z0-9_-]{43}$/);

    const prod = await requestEmailChange(db, ctx, { newEmail: NEW_EMAIL, password: TEST_PASSWORD }, { email: { env: { ...CONFIGURED, NODE_ENV: "production" }, send: failing } });
    expect(prod).toMatchObject({ status: "pending", sent: false, reason: "failed" });
    expect(prod).not.toHaveProperty("devLink");
  });

  it("works for a client portal user too (self-service, any role)", async () => {
    const ctx = await contextFor(db, ids.users.client);
    const result = await requestEmailChange(db, ctx, { newEmail: "cleo@new-client.test", password: TEST_PASSWORD }, configured());
    expect(result.status).toBe("pending");
    const confirmed = await confirmEmailChange(db, { token: tokenFrom(sent[0]) }, configured());
    expect(confirmed).toMatchObject({ userId: ids.users.client, role: "client", email: "cleo@new-client.test" });
  });
});

/* ------------------------------------------------------------------ */
/*  requestEmailChange — no email provider                             */
/* ------------------------------------------------------------------ */

describe("requestEmailChange without email set up", () => {
  it("changes the address at once, marks it unconfirmed and closes old links", async () => {
    const ctx = await contextFor(db, ids.users.editor1);
    const before = await userRow(ids.users.editor1);
    await withTx(
      (tx) => issueToken(tx, { organisationId: ids.organisationId, userId: ids.users.editor1, kind: "email_verify", createdByUserId: null, now: ctx.now(), targetEmail: ids.emails.editor1 }),
      { db },
    );

    const result = await requestEmailChange(db, ctx, { newEmail: NEW_EMAIL, password: TEST_PASSWORD }, notConfigured());
    expect(result).toEqual({ status: "changed", email: NEW_EMAIL });

    const after = await userRow(ids.users.editor1);
    expect(after).toMatchObject({ email: NEW_EMAIL, emailVerifiedAt: null, version: before.version + 1, sessionVersion: before.sessionVersion });
    expect(await latestLiveToken(db, ids.users.editor1, "email_verify", ctx.now())).toBeNull();
    expect(await tokensOf(ids.users.editor1, "email_change")).toHaveLength(0);

    const [event] = await eventsOf("user.email_changed");
    expect(event).toMatchObject({ action: "updated", actorUserId: ids.users.editor1, visibility: "management" });
    expect(event.previousValue).toEqual({ email: ids.emails.editor1 });
    expect(event.newValue).toMatchObject({ email: NEW_EMAIL });
    expect(event.metadata).toMatchObject({ targetUserId: ids.users.editor1, via: "direct" });
    expect(send).not.toHaveBeenCalled();

    // The session survives (only users.version moved) and the person is now known by the new address.
    expect(await buildContextFromDb(db, ids.users.editor1, { sessionVersion: before.sessionVersion })).not.toBeNull();
  });

  it("two people claiming the same address at once: exactly one gets it", async () => {
    const a = await contextFor(db, ids.users.editor1);
    const b = await contextFor(db, ids.users.editor2);
    const results = await Promise.allSettled([
      requestEmailChange(db, a, { newEmail: NEW_EMAIL, password: TEST_PASSWORD }, notConfigured()),
      requestEmailChange(db, b, { newEmail: NEW_EMAIL, password: TEST_PASSWORD }, notConfigured()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected");
    expect(fieldErrorsOf(refused?.reason).newEmail).toEqual([EMAIL_TAKEN_MESSAGE]);
    const owners = await db.select().from(schema.users).where(eq(schema.users.email, NEW_EMAIL));
    expect(owners).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  requestEmailChange — refusals                                      */
/* ------------------------------------------------------------------ */

describe("requestEmailChange refusals", () => {
  it("wrong password → 400 on the password field, counted by the shared passwordCheck limiter", async () => {
    const ctx = await contextFor(db, ids.users.owner);
    const err = await rejection(requestEmailChange(db, ctx, { newEmail: NEW_EMAIL, password: "not my password" }, configured()));
    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldErrorsOf(err).password).toEqual([WRONG_PASSWORD_MESSAGE]);
    expect(await limiters.passwordCheck.hits(db, userKey(ids.users.owner), Date.parse(fakeClock.now()))).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
    expect(await tokensOf(ids.users.owner, "email_change")).toHaveLength(0);
    expect(await eventsOf("user.email_change_requested")).toHaveLength(0);
  });

  it("the same address, or one any account already uses (any studio, pending invitees too) → 400 on newEmail", async () => {
    const ctx = await contextFor(db, ids.users.owner);
    const same = await rejection(requestEmailChange(db, ctx, { newEmail: ids.emails.owner.toUpperCase(), password: TEST_PASSWORD }, configured()));
    expect(fieldErrorsOf(same).newEmail).toEqual([SAME_EMAIL_MESSAGE]);

    const teammate = await rejection(requestEmailChange(db, ctx, { newEmail: ids.emails.editor1, password: TEST_PASSWORD }, configured()));
    expect(fieldErrorsOf(teammate).newEmail).toEqual([EMAIL_TAKEN_MESSAGE]);

    const other = await seedMinimalOrg(db, { slug: "other" });
    const elsewhere = await rejection(requestEmailChange(db, ctx, { newEmail: other.emails.client, password: TEST_PASSWORD }, configured()));
    expect(fieldErrorsOf(elsewhere).newEmail).toEqual([EMAIL_TAKEN_MESSAGE]);

    const bad = await rejection(requestEmailChange(db, ctx, { newEmail: "not-an-email", password: TEST_PASSWORD }, configured()));
    expect(fieldErrorsOf(bad).newEmail?.[0]).toMatch(/valid email/);
    expect(send).not.toHaveBeenCalled();
  });

  it("an account without a password (Google-only) is told to set one first (422)", async () => {
    await db.update(schema.users).set({ hasPassword: false }).where(eq(schema.users.id, ids.users.editor1));
    const ctx = await contextFor(db, ids.users.editor1);
    const err = await rejection(requestEmailChange(db, ctx, { newEmail: NEW_EMAIL, password: "anything at all" }, configured()));
    expect(err).toBeInstanceOf(RuleViolationError);
    expect((err as Error).message).toBe(NO_PASSWORD_FOR_EMAIL_MESSAGE);
  });

  it("5 requests an hour per person, whatever the outcome; then 429", async () => {
    const ctx = await contextFor(db, ids.users.owner);
    for (let i = 0; i < 5; i += 1) {
      await rejection(requestEmailChange(db, ctx, { newEmail: NEW_EMAIL, password: `wrong password ${i}` }, configured()));
    }
    const err = await rejection(requestEmailChange(db, ctx, { newEmail: NEW_EMAIL, password: TEST_PASSWORD }, configured()));
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as InstanceType<typeof RateLimitedError>).retryAfterSeconds).toBeGreaterThan(0);
    expect((err as Error).message).toBe("Too many email changes asked for. Try again in 60 minutes.");
    expect(await tokensOf(ids.users.owner, "email_change")).toHaveLength(0);
    // The window drains with time (the services' clock).
    fakeClock.advanceMinutes(61);
    expect((await requestEmailChange(db, ctx, { newEmail: NEW_EMAIL, password: TEST_PASSWORD }, configured())).status).toBe("pending");
    // Someone else's bucket is untouched.
    const other = await contextFor(db, ids.users.editor1);
    expect((await requestEmailChange(db, other, { newEmail: NEW_EMAIL, password: TEST_PASSWORD }, configured())).status).toBe("pending");
  });

  it("too many wrong current passwords (shared with Change password) → 429 before the password is even checked", async () => {
    for (let i = 0; i < 10; i += 1) await limiters.passwordCheck.hit(db, userKey(ids.users.owner), Date.parse(fakeClock.now()));
    const ctx = await contextFor(db, ids.users.owner);
    const err = await rejection(requestEmailChange(db, ctx, { newEmail: NEW_EMAIL, password: TEST_PASSWORD }, configured()));
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as Error).message).toMatch(/^Too many wrong passwords\. Try again in \d+ minutes\.$/);
    expect(send).not.toHaveBeenCalled();
  });

  it("the demo studio refuses with the plain 403 copy and writes nothing", async () => {
    const demoDb = await makeTestDb();
    const demo = await seedMinimalOrg(demoDb, { isDemo: true });
    const ctx = await contextFor(demoDb, demo.users.owner);
    const err = await rejection(requestEmailChange(demoDb, ctx, { newEmail: NEW_EMAIL, password: TEST_PASSWORD }, configured()));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as InstanceType<typeof ForbiddenError>).action).toBe("demo.email");
    expect((err as Error).message).toBe(DEMO_BLOCKED_MESSAGES.email);
    expect(await resendEmailChange(demoDb, ctx, configured()).catch((e: unknown) => e)).toBeInstanceOf(ForbiddenError);
    expect(await cancelEmailChange(demoDb, ctx).catch((e: unknown) => e)).toBeInstanceOf(ForbiddenError);
    expect((await userRow(demo.users.owner, demoDb)).email).toBe(demo.emails.owner);
    expect(await demoDb.select().from(schema.authTokens)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("org isolation: a context pointing at another studio cannot reach the person, and tokens carry the person's own studio", async () => {
    const other = await seedMinimalOrg(db, { slug: "other" });
    const mine = await contextFor(db, ids.users.owner);
    const forged = { ...mine, organisationId: other.organisationId };
    await expect(requestEmailChange(db, forged, { newEmail: NEW_EMAIL, password: TEST_PASSWORD }, configured())).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(cancelEmailChange(db, forged)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(setPassword(db, forged, { password: NEW_PASSWORD })).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(withTx((tx) => revokeOtherSessions(tx, forged), { db })).rejects.toBeInstanceOf(UnauthorizedError);

    const theirs = await contextFor(db, other.users.owner);
    await requestEmailChange(db, theirs, { newEmail: NEW_EMAIL, password: TEST_PASSWORD }, configured());
    const [row] = await tokensOf(other.users.owner, "email_change");
    expect(row.organisationId).toBe(other.organisationId);
    const [event] = await eventsOf("user.email_change_requested");
    expect(event.organisationId).toBe(other.organisationId);
    // My account in the first studio sees no waiting change.
    expect((await getAccountSecurity(db, mine, CONFIGURED)).pendingEmailChange).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  resend + cancel                                                    */
/* ------------------------------------------------------------------ */

describe("resendEmailChange / cancelEmailChange", () => {
  it("Send again issues a fresh link to the same address (the old one dies) without asking for the password", async () => {
    const firstToken = await pendingChange();
    const ctx = await contextFor(db, ids.users.owner);
    fakeClock.advanceHours(2);
    const again = await resendEmailChange(db, ctx, configured());
    expect(again).toEqual({ status: "pending", newEmail: NEW_EMAIL, expiresAt: "2026-10-09T02:00:00.000Z", sent: true, reason: null });
    const latest = sent.at(-1);
    expect(latest).toMatchObject({ to: NEW_EMAIL, subject: "Confirm your new email address for Proofline" });
    // No second "someone asked" notice to the old address.
    expect(sent.filter((m) => m.to === ids.emails.owner)).toHaveLength(1);
    await expect(confirmEmailChange(db, { token: firstToken })).rejects.toThrow(EMAIL_CHANGE_INVALID_MESSAGE);
    expect((await confirmEmailChange(db, { token: tokenFrom(latest) })).email).toBe(NEW_EMAIL);
    const events = await eventsOf("user.email_change_requested");
    expect(events.map((e) => (e.metadata as { resend?: boolean }).resend ?? false)).toEqual([false, true]);
  });

  it("Send again with nothing waiting → 422; it shares the 5-an-hour limit", async () => {
    const ctx = await contextFor(db, ids.users.owner);
    const none = await rejection(resendEmailChange(db, ctx, configured()));
    expect(none).toBeInstanceOf(RuleViolationError);
    expect((none as Error).message).toBe(NO_PENDING_CHANGE_MESSAGE);

    await pendingChange();
    for (let i = 0; i < 4; i += 1) await resendEmailChange(db, ctx, configured());
    await expect(resendEmailChange(db, ctx, configured())).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("Send again when the address was taken meanwhile closes the change and says so", async () => {
    await pendingChange();
    await db.update(schema.users).set({ email: NEW_EMAIL }).where(eq(schema.users.id, ids.users.editor2));
    const ctx = await contextFor(db, ids.users.owner);
    const err = await rejection(resendEmailChange(db, ctx, configured()));
    expect((err as Error).message).toBe(EMAIL_NOW_TAKEN_MESSAGE);
    expect(reasonOf(err)).toBe("email_taken");
    expect(await latestLiveToken(db, ids.users.owner, "email_change", ctx.now())).toBeNull();
    const [cancelled] = await eventsOf("user.email_change_cancelled");
    expect(cancelled.metadata).toMatchObject({ reason: "taken", cancelled: 1 });
  });

  it("Cancel closes the waiting change (its link stops working) and is audited once", async () => {
    const token = await pendingChange();
    const ctx = await contextFor(db, ids.users.owner);
    expect(await cancelEmailChange(db, ctx)).toEqual({ cancelled: 1 });
    expect(await cancelEmailChange(db, ctx)).toEqual({ cancelled: 0 });
    await expect(confirmEmailChange(db, { token })).rejects.toThrow(EMAIL_CHANGE_INVALID_MESSAGE);
    expect((await getAccountSecurity(db, ctx, CONFIGURED)).pendingEmailChange).toBeNull();
    const events = await eventsOf("user.email_change_cancelled");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "revoked", actorUserId: ids.users.owner, visibility: "management" });
    expect(events[0].newValue).toEqual({ pendingEmail: NEW_EMAIL });
    expect(events[0].metadata).toMatchObject({ targetUserId: ids.users.owner, cancelled: 1 });
  });
});

/* ------------------------------------------------------------------ */
/*  confirmEmailChange                                                 */
/* ------------------------------------------------------------------ */

describe("confirmEmailChange", () => {
  it("changes the address (confirmed), closes other links, audits both events and tells the OLD address", async () => {
    const token = await pendingChange();
    const before = await userRow(ids.users.owner);
    fakeClock.advanceHours(3);
    await withTx(
      (tx) => issueToken(tx, { organisationId: ids.organisationId, userId: ids.users.owner, kind: "email_verify", createdByUserId: null, now: fakeClock.now(), targetEmail: ids.emails.owner }),
      { db },
    );
    sent.length = 0;

    const result = await confirmEmailChange(db, { token, ip: "8.8.8.8" }, configured());
    expect(result).toEqual({ userId: ids.users.owner, organisationId: ids.organisationId, role: "photographer", email: NEW_EMAIL, previousEmail: ids.emails.owner });

    const after = await userRow(ids.users.owner);
    expect(after).toMatchObject({ email: NEW_EMAIL, emailVerifiedAt: "2026-10-08T03:00:00.000Z", version: before.version + 1, sessionVersion: before.sessionVersion });
    expect(await latestLiveToken(db, ids.users.owner, "email_verify", fakeClock.now())).toBeNull();
    const [used] = await tokensOf(ids.users.owner, "email_change");
    expect(used.usedAt).toBe("2026-10-08T03:00:00.000Z");

    const [changed] = await eventsOf("user.email_changed");
    expect(changed).toMatchObject({ action: "updated", actorUserId: ids.users.owner, organisationId: ids.organisationId, visibility: "management" });
    expect(changed.previousValue).toEqual({ email: ids.emails.owner });
    expect(changed.newValue).toMatchObject({ email: NEW_EMAIL });
    expect(changed.metadata).toMatchObject({ targetUserId: ids.users.owner, via: "link", ip: "8.8.8.8" });
    expect(JSON.stringify(changed)).not.toContain(token);
    const [confirmed] = await eventsOf("user.email_confirmed");
    expect(confirmed.metadata).toMatchObject({ targetUserId: ids.users.owner, via: "email_change" });
    expect(confirmed.newValue).toMatchObject({ email: NEW_EMAIL });

    expect(sent.map((m) => [m.to, m.subject])).toEqual([[ids.emails.owner, "Your Proofline email was changed"]]);
    // The session is untouched: the person stays signed in everywhere.
    expect(await buildContextFromDb(db, ids.users.owner, { sessionVersion: before.sessionVersion })).not.toBeNull();
  });

  it("a used, expired, cancelled or unknown link is the one plain 400 (and a mangled one never reaches the DB)", async () => {
    const token = await pendingChange();
    await confirmEmailChange(db, { token });
    const used = await rejection(confirmEmailChange(db, { token }));
    expect(used).toBeInstanceOf(ValidationError);
    expect((used as Error).message).toBe(EMAIL_CHANGE_INVALID_MESSAGE);
    expect(reasonOf(used)).toBe("invalid_link");
    expect(fieldErrorsOf(used)).toEqual({});

    const expiring = await pendingChange(ids.users.editor1, "eve.later@elsewhere.test");
    fakeClock.advanceHours(24);
    await expect(confirmEmailChange(db, { token: expiring })).rejects.toThrow(EMAIL_CHANGE_INVALID_MESSAGE);
    expect((await userRow(ids.users.editor1)).email).toBe(ids.emails.editor1);

    await expect(confirmEmailChange(db, { token: "A".repeat(43) })).rejects.toThrow(EMAIL_CHANGE_INVALID_MESSAGE);
    const mangled = await rejection(confirmEmailChange(db, { token: "<script>" }));
    expect(mangled).toBeInstanceOf(ValidationError);
    expect(await eventsOf("user.email_changed")).toHaveLength(1);
  });

  it("an email_verify link cannot be used as an email change link", async () => {
    const ctx = await contextFor(db, ids.users.owner);
    const verify = await withTx(
      (tx) => issueToken(tx, { organisationId: ids.organisationId, userId: ids.users.owner, kind: "email_verify", createdByUserId: null, now: ctx.now(), targetEmail: ids.emails.owner }),
      { db },
    );
    await expect(confirmEmailChange(db, { token: verify.token })).rejects.toThrow(EMAIL_CHANGE_INVALID_MESSAGE);
  });

  it("a deactivated person's link is dead", async () => {
    const token = await pendingChange(ids.users.editor1);
    await db.update(schema.users).set({ isActive: false, deactivatedAt: fakeClock.now() }).where(eq(schema.users.id, ids.users.editor1));
    await expect(confirmEmailChange(db, { token })).rejects.toThrow(EMAIL_CHANGE_INVALID_MESSAGE);
    expect((await userRow(ids.users.editor1)).email).toBe(ids.emails.editor1);
  });

  it("the address taken by another account since the request → 400, the change is closed, nothing else moves", async () => {
    const token = await pendingChange();
    // Another studio's owner takes the address meanwhile (an admin email change, say).
    const other = await seedMinimalOrg(db, { slug: "other" });
    await db.update(schema.users).set({ email: NEW_EMAIL }).where(eq(schema.users.id, other.users.editor1));

    const err = await rejection(confirmEmailChange(db, { token }, configured()));
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe(EMAIL_NOW_TAKEN_MESSAGE);
    expect(reasonOf(err)).toBe("email_taken");
    expect((await userRow(ids.users.owner)).email).toBe(ids.emails.owner);
    expect(await latestLiveToken(db, ids.users.owner, "email_change", fakeClock.now())).toBeNull();
    const [cancelled] = await eventsOf("user.email_change_cancelled");
    expect(cancelled).toMatchObject({ organisationId: ids.organisationId });
    expect(cancelled.metadata).toMatchObject({ reason: "taken" });
    expect(await eventsOf("user.email_changed")).toHaveLength(0);
    // A retry is the dead link now.
    await expect(confirmEmailChange(db, { token })).rejects.toThrow(EMAIL_CHANGE_INVALID_MESSAGE);
  });

  it("uniqueness race: two people confirming the same new address at once — exactly one wins", async () => {
    const a = await pendingChange(ids.users.editor1, NEW_EMAIL);
    const b = await pendingChange(ids.users.editor2, NEW_EMAIL);
    const results = await Promise.allSettled([confirmEmailChange(db, { token: a }), confirmEmailChange(db, { token: b })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect((lost?.reason as Error).message).toBe(EMAIL_NOW_TAKEN_MESSAGE);
    expect(await db.select().from(schema.users).where(eq(schema.users.email, NEW_EMAIL))).toHaveLength(1);
  });

  it("changing the password cancels a waiting change (\"change your password now: that cancels the change\")", async () => {
    const token = await pendingChange();
    const ctx = await contextFor(db, ids.users.owner);
    const prepared = await preparePasswordChange(db, ctx, { current: TEST_PASSWORD, next: NEW_PASSWORD });
    await withTx((tx) => changePasswordInDb(tx, ctx, prepared), { db });
    await expect(confirmEmailChange(db, { token })).rejects.toThrow(EMAIL_CHANGE_INVALID_MESSAGE);
  });

  it("works when the person's context is gone (a client whose portal was closed): recorded by the system, in their studio", async () => {
    const token = await pendingChange(ids.users.client, "cleo@new-client.test");
    await db.update(schema.clients).set({ portalEnabled: false }).where(eq(schema.clients.id, ids.clientId));
    const result = await confirmEmailChange(db, { token });
    expect(result.email).toBe("cleo@new-client.test");
    const [changed] = await eventsOf("user.email_changed");
    expect(changed).toMatchObject({ actorUserId: null, organisationId: ids.organisationId });
  });
});

/* ------------------------------------------------------------------ */
/*  setPassword                                                        */
/* ------------------------------------------------------------------ */

describe("setPassword", () => {
  async function makeGoogleOnly(userId: string) {
    await db.update(schema.users).set({ hasPassword: false, googleSub: `g-${userId}`, googleEmail: "someone@gmail.test" }).where(eq(schema.users.id, userId));
  }

  /** A context whose browser signed in `minutesAgo` minutes ago (the session cookie's `at`). */
  async function signedInCtx(userId: string, minutesAgo = 1, dbx = db) {
    const ctx = await contextFor(dbx, userId);
    return { ...ctx, signedInAt: Math.floor(Date.parse(ctx.now()) / 1000) - minutesAgo * 60 };
  }

  it("adds a first password: has_password on, version + 1, sessions kept, audited as via set, notice sent", async () => {
    await makeGoogleOnly(ids.users.editor1);
    const before = await userRow(ids.users.editor1);
    const ctx = await signedInCtx(ids.users.editor1);
    expect(await setPassword(db, ctx, { password: NEW_PASSWORD, ip: "7.7.7.7" }, configured())).toEqual({ ok: true });

    const after = await userRow(ids.users.editor1);
    expect(after).toMatchObject({ hasPassword: true, version: before.version + 1, sessionVersion: before.sessionVersion });
    expect(await verifyPassword(NEW_PASSWORD, after.passwordHash)).toBe(true);
    const [event] = await eventsOf("user.password_changed");
    expect(event).toMatchObject({ action: "updated", actorUserId: ids.users.editor1, visibility: "management" });
    expect(event.metadata).toMatchObject({ targetUserId: ids.users.editor1, self: true, via: "set", ip: "7.7.7.7" });
    expect(JSON.stringify(event)).not.toContain(NEW_PASSWORD);
    expect(sent.map((m) => [m.to, m.subject])).toEqual([[ids.emails.editor1, "A password was added to your Proofline account"]]);
    // Now they can change their email (it needs the password).
    expect((await requestEmailChange(db, ctx, { newEmail: NEW_EMAIL, password: NEW_PASSWORD }, configured())).status).toBe("pending");
  });

  it("an account that already has a password → 422 (use Change password); a short one → 400", async () => {
    const ctx = await contextFor(db, ids.users.owner);
    const err = await rejection(setPassword(db, ctx, { password: NEW_PASSWORD }, configured()));
    expect(err).toBeInstanceOf(RuleViolationError);
    expect((err as Error).message).toBe(ALREADY_HAS_PASSWORD_MESSAGE);
    expect(await verifyPassword(TEST_PASSWORD, (await userRow(ids.users.owner)).passwordHash)).toBe(true);

    await makeGoogleOnly(ids.users.editor1);
    const short = await rejection(setPassword(db, await signedInCtx(ids.users.editor1), { password: "short" }, configured()));
    expect(fieldErrorsOf(short).password?.[0]).toMatch(/at least 10/);
    expect(await eventsOf("user.password_changed")).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("SEC-03: no current password to ask for, so it needs a RECENT sign-in (15 minutes) — an old or unknown one is refused", async () => {
    await makeGoogleOnly(ids.users.editor1);
    for (const ctx of [await signedInCtx(ids.users.editor1, 16), await contextFor(db, ids.users.editor1)]) {
      const err = await rejection(setPassword(db, ctx, { password: NEW_PASSWORD }, configured()));
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as InstanceType<typeof ForbiddenError>).action).toBe("account.recent_sign_in");
      expect((err as Error).message).toMatch(/sign in again/i);
    }
    expect((await userRow(ids.users.editor1)).hasPassword).toBe(false);
    expect(await eventsOf("user.password_changed")).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    // Signed in 14 minutes ago: fine.
    await expect(setPassword(db, await signedInCtx(ids.users.editor1, 14), { password: NEW_PASSWORD }, configured())).resolves.toEqual({ ok: true });
  });

  it("the demo studio refuses (403, plain copy)", async () => {
    const demoDb = await makeTestDb();
    const demo = await seedMinimalOrg(demoDb, { isDemo: true });
    await demoDb.update(schema.users).set({ hasPassword: false }).where(eq(schema.users.id, demo.users.editor1));
    const err = await rejection(setPassword(demoDb, await signedInCtx(demo.users.editor1, 1, demoDb), { password: NEW_PASSWORD }, configured()));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as Error).message).toBe(DEMO_BLOCKED_MESSAGES.password);
    expect((await userRow(demo.users.editor1, demoDb)).hasPassword).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Change password keeps sending its notice                           */
/* ------------------------------------------------------------------ */

describe("change password (services/auth.ts) on My account", () => {
  it("sends \"Your Proofline password was changed\" after the change", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const ctx = await contextFor(db, ids.users.owner);
      await changePassword(ctx, { current: TEST_PASSWORD, next: NEW_PASSWORD }, db);
      // No provider in tests: the console provider names the recipient and subject (never the body).
      expect(info.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(new RegExp(`"Your Proofline password was changed" to ${ids.emails.owner.replace(/\./g, "\\.")}`));
    } finally {
      info.mockRestore();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  signOutOtherDevices                                                */
/* ------------------------------------------------------------------ */

describe("signOutOtherDevices", () => {
  it("bumps session_version: an old cookie dies, THIS browser's cookie is re-issued and keeps working", async () => {
    const before = await userRow(ids.users.editor1);
    const otherDevice = await signSessionToken({ sub: ids.users.editor1, sv: before.sessionVersion, k: "staff", r: "editor" });
    jar.set(SESSION_COOKIE_NAME, otherDevice);
    const ctx = await requireAnyContext();

    expect(await signOutOtherDevices(db, ctx, { ip: "6.6.6.6", userAgent: "vitest" })).toEqual({ ok: true });
    const after = await userRow(ids.users.editor1);
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    expect(after.version).toBe(before.version);

    const mine = jar.get(SESSION_COOKIE_NAME);
    expect(mine).not.toBe(otherDevice);
    expect(await verifySessionToken(mine)).toEqual({ sub: ids.users.editor1, sv: before.sessionVersion + 1, k: "staff", r: "editor" });
    await expect(requireAnyContext()).resolves.toMatchObject({ userId: ids.users.editor1 });

    // Any other browser still holding the old cookie is signed out.
    jar.set(SESSION_COOKIE_NAME, otherDevice);
    await expect(requireAnyContext()).rejects.toBeInstanceOf(UnauthorizedError);

    const [event] = await eventsOf("auth.other_sessions_revoked");
    expect(event).toMatchObject({ action: "revoked", entityType: "auth", actorUserId: ids.users.editor1, visibility: "management" });
    expect(event.previousValue).toEqual({ sessionVersion: before.sessionVersion });
    expect(event.newValue).toEqual({ sessionVersion: before.sessionVersion + 1 });
    expect(event.metadata).toMatchObject({ targetUserId: ids.users.editor1, ip: "6.6.6.6", userAgent: "vitest" });
  });

  it("a client gets a CLIENT cookie back", async () => {
    const ctx = await contextFor(db, ids.users.client);
    await signOutOtherDevices(db, ctx);
    const claims = await verifySessionToken(jar.get(SESSION_COOKIE_NAME));
    expect(claims).toMatchObject({ sub: ids.users.client, k: "client", r: "client" });
  });

  it("the demo studio refuses (403) and nobody is signed out", async () => {
    const demoDb = await makeTestDb();
    const demo = await seedMinimalOrg(demoDb, { isDemo: true });
    const ctx = await contextFor(demoDb, demo.users.owner);
    const before = await userRow(demo.users.owner, demoDb);
    const err = await rejection(signOutOtherDevices(demoDb, ctx));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as Error).message).toBe(DEMO_BLOCKED_MESSAGES.sessions);
    expect((await userRow(demo.users.owner, demoDb)).sessionVersion).toBe(before.sessionVersion);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(await eventsOf("auth.other_sessions_revoked", demoDb)).toHaveLength(0);
  });

  it("system contexts have no device to keep (401)", async () => {
    const ctx = await contextFor(db, ids.users.owner);
    await expect(signOutOtherDevices(db, { ...ctx, userId: null, isSystem: true })).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
