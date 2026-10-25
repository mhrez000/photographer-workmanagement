/**
 * "Confirm your email" (AREA verify, docs/ACCOUNTS-PLAN.md §4): issuing + emailing the link (configured, not configured
 * in development / production, demo, provider failure), "Send again" (rate limit, already confirmed, demo, org
 * isolation) and the public confirm button (happy path, re-use, superseded, expired, mangled, another address,
 * deactivated / anonymised accounts, a client without the portal, org isolation, the audit trail — never the token).
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityEvents, authTokens, clients, users } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, systemContextFor, type SeedIds, type TestDb } from "@/db/test-db";
import { clearAllRateLimits } from "@/server/auth/db-rate-limit";
import { clearEmailConfirmation } from "@/server/auth/email-confirmation";
import { hashToken, issueToken } from "@/server/auth/tokens";
import type { EmailMessage, SendEmailResult } from "@/server/email";
import { RateLimitedError, RuleViolationError, UnauthorizedError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import {
  CONFIRM_LINK_INVALID_MESSAGE,
  EMAIL_ALREADY_CONFIRMED_MESSAGE,
  confirmEmail,
  redactLinks,
  resendEmailConfirmation,
  sendEmailConfirmation,
  type ConfirmLinkFailure,
} from "./emailVerification";

const CONFIGURED = { RESEND_API_KEY: "re_test", EMAIL_FROM: "Proofline <hello@example.com>", NODE_ENV: "test" };
const DEV_NOT_CONFIGURED = { NODE_ENV: "development" };
const PRODUCTION_NOT_CONFIGURED = { NODE_ENV: "production" };
const NOW = "2026-10-08T00:00:00.000Z";
const TOKEN_IN_URL = /\/verify-email\?token=([A-Za-z0-9_-]{43})/;

function okSend() {
  return vi.fn<(m: EmailMessage) => Promise<SendEmailResult>>(async () => ({ ok: true, provider: "resend", id: "msg_1" }));
}

/** The plain token inside the one email `send` received (call `index`). */
function tokenFromSend(send: ReturnType<typeof okSend>, index = 0): string {
  const text = send.mock.calls[index]?.[0].text ?? "";
  const match = TOKEN_IN_URL.exec(text);
  if (!match) throw new Error(`no confirm link in the email: ${text}`);
  return match[1];
}

function tokenFromLink(link: string | undefined): string {
  const match = TOKEN_IN_URL.exec(link ?? "");
  if (!match) throw new Error(`not a confirm link: ${link}`);
  return match[1];
}

async function failureOf(promise: Promise<unknown>): Promise<{ message: string; reason: unknown; status: number }> {
  try {
    await promise;
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    return { message: err.message, reason: (err.details as { reason?: unknown } | undefined)?.reason, status: err.status };
  }
  throw new Error("expected the confirm link to be refused");
}

async function expectDeadLink(db: TestDb, token: unknown, reason: ConfirmLinkFailure): Promise<void> {
  const failure = await failureOf(confirmEmail(db, { token }));
  expect(failure).toEqual({ message: CONFIRM_LINK_INVALID_MESSAGE, reason, status: 400 });
}

let db: TestDb;
let ids: SeedIds;

async function userRow(id: string, on: TestDb = db) {
  const [row] = await on.select().from(users).where(eq(users.id, id));
  return row;
}

async function eventsOf(type: string, on: TestDb = db) {
  return on.select().from(activityEvents).where(eq(activityEvents.eventType, type)).orderBy(activityEvents.rowid);
}

async function verifyTokensOf(userId: string, on: TestDb = db) {
  return on
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.userId, userId), eq(authTokens.kind, "email_verify")))
    .orderBy(authTokens.createdAt);
}

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { emailVerified: false });
  await clearAllRateLimits(db);
});
afterEach(() => {
  fakeClock.reset();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  sendEmailConfirmation                                              */
/* ------------------------------------------------------------------ */

describe("sendEmailConfirmation", () => {
  it("configured: issues a 24-hour link for the current address, audits it (never the token) and emails it after commit", async () => {
    const send = okSend();
    const result = await sendEmailConfirmation(db, { userId: ids.users.owner, reason: "signup", requestId: "req-signup" }, { env: CONFIGURED, send });
    expect(result).toEqual({ sent: true, reason: null, expiresAt: "2026-10-09T00:00:00.000Z" });

    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0];
    expect(message.to).toBe(ids.emails.owner);
    expect(message.subject).toBe("Confirm your email for Proofline");
    expect(message.text).toContain("Hi Olivia Owner");
    const token = tokenFromSend(send);

    const [row] = await verifyTokensOf(ids.users.owner);
    expect(row).toMatchObject({ organisationId: ids.organisationId, targetEmail: ids.emails.owner, tokenHash: hashToken(token), usedAt: null, createdByUserId: null });
    expect(row.expiresAt).toBe("2026-10-09T00:00:00.000Z");

    const [event] = await eventsOf("user.email_confirmation_sent");
    expect(event).toMatchObject({
      organisationId: ids.organisationId,
      actorUserId: ids.users.owner,
      entityType: "user",
      entityId: ids.users.owner,
      action: "requested",
      visibility: "management",
    });
    expect(event.metadata).toMatchObject({ targetUserId: ids.users.owner, reason: "signup", superseded: 0, sent: true, requestId: "req-signup" });
    expect(event.newValue).toMatchObject({ email: ids.emails.owner, expiresAt: "2026-10-09T00:00:00.000Z" });
    expect(event.summary).toContain("was sent an email confirmation link");
    expect(JSON.stringify(event)).not.toContain(token);
    expect(JSON.stringify(event)).not.toContain(hashToken(token));
  });

  it("a second link supersedes the first (only the newest works)", async () => {
    const send = okSend();
    await sendEmailConfirmation(db, { userId: ids.users.editor1, reason: "signup" }, { env: CONFIGURED, send });
    fakeClock.advanceMinutes(5);
    await sendEmailConfirmation(db, { userId: ids.users.editor1, reason: "resend" }, { env: CONFIGURED, send });
    const rows = await verifyTokensOf(ids.users.editor1);
    expect(rows).toHaveLength(2);
    expect(rows[0].usedAt).toBe("2026-10-08T00:05:00.000Z");
    expect(rows[1].usedAt).toBeNull();
    const events = await eventsOf("user.email_confirmation_sent");
    expect(events.map((e) => e.metadata)).toMatchObject([{ superseded: 0 }, { superseded: 1, reason: "resend" }]);
    expect(rows[1].createdByUserId).toBe(ids.users.editor1);

    await expectDeadLink(db, tokenFromSend(send, 0), "used");
    await expect(confirmEmail(db, { token: tokenFromSend(send, 1) })).resolves.toMatchObject({ userId: ids.users.editor1 });
  });

  it("an already confirmed address gets nothing (no link, no event, no email)", async () => {
    const confirmed = await makeTestDb();
    const c = await seedMinimalOrg(confirmed);
    const send = okSend();
    expect(await sendEmailConfirmation(confirmed, { userId: c.users.owner, reason: "resend" }, { env: CONFIGURED, send })).toEqual({
      sent: false,
      reason: "already_confirmed",
    });
    expect(send).not.toHaveBeenCalled();
    expect(await verifyTokensOf(c.users.owner, confirmed)).toEqual([]);
    expect(await eventsOf("user.email_confirmation_sent", confirmed)).toEqual([]);
  });

  it("demo studio: never issues or sends, configured or not", async () => {
    const demoDb = await makeTestDb();
    const demo = await seedMinimalOrg(demoDb, { isDemo: true, emailVerified: false });
    const send = okSend();
    for (const env of [CONFIGURED, DEV_NOT_CONFIGURED, PRODUCTION_NOT_CONFIGURED]) {
      expect(await sendEmailConfirmation(demoDb, { userId: demo.users.owner, reason: "signup" }, { env, send })).toEqual({ sent: false, reason: "demo" });
    }
    expect(send).not.toHaveBeenCalled();
    expect(await verifyTokensOf(demo.users.owner, demoDb)).toEqual([]);
    expect(await eventsOf("user.email_confirmation_sent", demoDb)).toEqual([]);
  });

  it("production without a mail provider: the feature is invisible (nothing issued, no link back)", async () => {
    const send = okSend();
    expect(await sendEmailConfirmation(db, { userId: ids.users.owner, reason: "signup" }, { env: PRODUCTION_NOT_CONFIGURED, send })).toEqual({
      sent: false,
      reason: "not_configured",
    });
    expect(send).not.toHaveBeenCalled();
    expect(await verifyTokensOf(ids.users.owner)).toEqual([]);
    expect(await eventsOf("user.email_confirmation_sent")).toEqual([]);
  });

  it("development without a mail provider: issues the link and hands it back as the dev-only link", async () => {
    const send = vi.fn<(m: EmailMessage) => Promise<SendEmailResult>>(async () => ({ ok: false, provider: "console", error: "email_not_configured" }));
    const result = await sendEmailConfirmation(db, { userId: ids.users.owner, reason: "signup" }, { env: DEV_NOT_CONFIGURED, send });
    expect(result).toMatchObject({ sent: false, reason: "not_configured", expiresAt: "2026-10-09T00:00:00.000Z" });
    expect(result.devLink).toMatch(/^http:\/\/localhost:\d+\/verify-email\?token=[A-Za-z0-9_-]{43}$/);
    // The console provider only logs the recipient + subject.
    expect(send).toHaveBeenCalledTimes(1);
    const [event] = await eventsOf("user.email_confirmation_sent");
    expect(event.metadata).toMatchObject({ sent: false, reason: "signup" });
    await expect(confirmEmail(db, { token: tokenFromLink(result.devLink) })).resolves.toMatchObject({ email: ids.emails.owner });
  });

  it("uses the request's origin for the link outside production", async () => {
    const req = new Request("http://studio.localhost:4000/api/auth/signup", { method: "POST" });
    const send = okSend();
    await sendEmailConfirmation(db, { userId: ids.users.owner, reason: "signup", req }, { env: CONFIGURED, send });
    expect(send.mock.calls[0][0].text).toContain("http://studio.localhost:4000/verify-email?token=");
  });

  it("a provider failure is reported (the link stays valid), with the dev-only link outside production only", async () => {
    const failing = vi.fn<(m: EmailMessage) => Promise<SendEmailResult>>(async () => ({ ok: false, provider: "resend", error: "boom" }));
    const dev = await sendEmailConfirmation(db, { userId: ids.users.owner, reason: "resend" }, { env: CONFIGURED, send: failing });
    expect(dev).toMatchObject({ sent: false, reason: "failed" });
    expect(dev.devLink).toMatch(TOKEN_IN_URL);
    const prod = await sendEmailConfirmation(db, { userId: ids.users.editor1, reason: "resend" }, { env: { ...CONFIGURED, NODE_ENV: "production" }, send: failing });
    expect(prod).toEqual({ sent: false, reason: "failed", expiresAt: "2026-10-09T00:00:00.000Z" });
    expect(await verifyTokensOf(ids.users.editor1)).toHaveLength(1);
  });

  it("sign-up never fails on a confirmation problem; a resend lets it surface", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A transport that echoes the message (link included) in its error.
    const throwing = vi.fn<(m: EmailMessage) => Promise<SendEmailResult>>(async (m) => {
      throw new Error(`socket closed while sending: ${m.text}`);
    });
    expect(await sendEmailConfirmation(db, { userId: ids.users.owner, reason: "signup" }, { env: CONFIGURED, send: throwing })).toEqual({ sent: false, reason: "failed" });
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]);
    expect(logged).toContain("socket closed");
    expect(logged).toContain("token=[redacted]");
    expect(logged).not.toMatch(/token=[A-Za-z0-9_-]{43}/);
    await expect(sendEmailConfirmation(db, { userId: ids.users.owner, reason: "resend" }, { env: CONFIGURED, send: throwing })).rejects.toThrow("socket closed");
  });

  it("nobody to confirm: missing, deactivated or anonymised accounts get nothing", async () => {
    const send = okSend();
    await db.update(users).set({ isActive: false, deactivatedAt: NOW }).where(eq(users.id, ids.users.editor2));
    for (const userId of ["no-such-user", ids.users.inactiveEditor, ids.users.editor2]) {
      expect(await sendEmailConfirmation(db, { userId, reason: "resend" }, { env: CONFIGURED, send })).toEqual({ sent: false, reason: "failed" });
    }
    expect(send).not.toHaveBeenCalled();
  });
});

it("redactLinks keeps tokens and their hashes out of log lines", () => {
  const token = "A".repeat(43);
  expect(redactLinks(`failed http://x/verify-email?token=${token} params: ${hashToken(token)}`)).toBe("failed http://x/verify-email?token=[redacted] params: [redacted]");
});

/* ------------------------------------------------------------------ */
/*  resendEmailConfirmation                                            */
/* ------------------------------------------------------------------ */

describe("resendEmailConfirmation", () => {
  it("sends a fresh link for the signed-in person's own address, audited as them", async () => {
    const ctx = await contextFor(db, ids.users.client);
    const send = okSend();
    const result = await resendEmailConfirmation(db, ctx, {}, { env: CONFIGURED, send });
    expect(result).toMatchObject({ sent: true, reason: null });
    expect(send.mock.calls[0][0].to).toBe(ids.emails.client);
    const [event] = await eventsOf("user.email_confirmation_sent");
    expect(event).toMatchObject({ actorUserId: ids.users.client, entityId: ids.users.client });
    expect(event.metadata).toMatchObject({ reason: "resend" });
    expect(event.summary).toContain("asked for a new email confirmation link");
  });

  it("already confirmed → 422 in plain words, nothing issued and nothing counted", async () => {
    const confirmed = await makeTestDb();
    const c = await seedMinimalOrg(confirmed);
    const ctx = await contextFor(confirmed, c.users.editor1);
    const send = okSend();
    const err = await resendEmailConfirmation(confirmed, ctx, {}, { env: CONFIGURED, send }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuleViolationError);
    expect((err as RuleViolationError).status).toBe(422);
    expect((err as RuleViolationError).message).toBe(EMAIL_ALREADY_CONFIRMED_MESSAGE);
    expect(send).not.toHaveBeenCalled();
  });

  it("demo studio → reason demo, nothing issued", async () => {
    const demoDb = await makeTestDb();
    const demo = await seedMinimalOrg(demoDb, { isDemo: true, emailVerified: false });
    const ctx = await contextFor(demoDb, demo.users.owner);
    const send = okSend();
    expect(await resendEmailConfirmation(demoDb, ctx, {}, { env: CONFIGURED, send })).toEqual({ sent: false, reason: "demo" });
    expect(send).not.toHaveBeenCalled();
    expect(await verifyTokensOf(demo.users.owner, demoDb)).toEqual([]);
  });

  it("5 an hour per person: the 6th is a 429 with the wait; an hour later it works again; other people are not affected", async () => {
    const ctx = await contextFor(db, ids.users.editor1);
    const send = okSend();
    for (let i = 0; i < 5; i += 1) {
      await resendEmailConfirmation(db, ctx, {}, { env: CONFIGURED, send });
      fakeClock.advanceMinutes(1);
    }
    const err = await resendEmailConfirmation(db, ctx, {}, { env: CONFIGURED, send }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    // The first of the five leaves the hour 55 minutes from now.
    expect((err as RateLimitedError).retryAfterSeconds).toBe(55 * 60);
    expect(send).toHaveBeenCalledTimes(5);

    // Someone else in the same studio still can.
    await expect(resendEmailConfirmation(db, await contextFor(db, ids.users.editor2), {}, { env: CONFIGURED, send })).resolves.toMatchObject({ sent: true });

    fakeClock.advanceMinutes(56);
    await expect(resendEmailConfirmation(db, await contextFor(db, ids.users.editor1), {}, { env: CONFIGURED, send })).resolves.toMatchObject({ sent: true });
  });

  it("only ever for the context's own account in its own studio", async () => {
    const send = okSend();
    await seedMinimalOrg(db, { slug: "other", emailVerified: false });
    const system = await systemContextFor(db, ids.organisationId);
    await expect(resendEmailConfirmation(db, system, {}, { env: CONFIGURED, send })).rejects.toThrow(UnauthorizedError);
    // A context claiming another studio's user id resolves nobody.
    const forged = { ...(await contextFor(db, ids.users.owner)), userId: "other-owner" };
    await expect(resendEmailConfirmation(db, forged, {}, { env: CONFIGURED, send })).rejects.toThrow(UnauthorizedError);
    expect(send).not.toHaveBeenCalled();
    expect(await verifyTokensOf("other-owner")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  confirmEmail                                                       */
/* ------------------------------------------------------------------ */

async function issueLink(userId: string, on: TestDb = db, env: Record<string, string> = CONFIGURED): Promise<string> {
  const send = okSend();
  await sendEmailConfirmation(on, { userId, reason: "resend" }, { env, send });
  return tokenFromSend(send);
}

describe("confirmEmail", () => {
  it("confirms the address on the button press, uses the link up and audits it as the person", async () => {
    const token = await issueLink(ids.users.editor1);
    fakeClock.advanceMinutes(10);
    const result = await confirmEmail(db, { token, ip: null, userAgent: "vitest" }, { requestId: "req-confirm" });
    expect(result).toEqual({ email: ids.emails.editor1, userId: ids.users.editor1, alreadyConfirmed: false });

    expect((await userRow(ids.users.editor1)).emailVerifiedAt).toBe("2026-10-08T00:10:00.000Z");
    const [row] = await verifyTokensOf(ids.users.editor1);
    expect(row.usedAt).toBe("2026-10-08T00:10:00.000Z");
    const [event] = await eventsOf("user.email_confirmed");
    expect(event).toMatchObject({ organisationId: ids.organisationId, actorUserId: ids.users.editor1, entityId: ids.users.editor1, visibility: "management" });
    expect(event.metadata).toMatchObject({ targetUserId: ids.users.editor1, via: "link", requestId: "req-confirm" });
    expect(JSON.stringify(event)).not.toContain(token);
    // Nobody else changed.
    expect((await userRow(ids.users.editor2)).emailVerifiedAt).toBeNull();
  });

  it("the same link again → already used, and the address stays confirmed", async () => {
    const token = await issueLink(ids.users.owner);
    await confirmEmail(db, { token });
    await expectDeadLink(db, token, "already_confirmed");
    expect(await eventsOf("user.email_confirmed")).toHaveLength(1);
  });

  it("expires after 24 hours", async () => {
    const token = await issueLink(ids.users.owner);
    fakeClock.advanceHours(24);
    fakeClock.advanceMs(1);
    await expectDeadLink(db, token, "expired");
    expect((await userRow(ids.users.owner)).emailVerifiedAt).toBeNull();
  });

  it("an expired link for an address that got confirmed another way says so", async () => {
    const token = await issueLink(ids.users.owner);
    fakeClock.advanceHours(25);
    await db.update(users).set({ emailVerifiedAt: fakeClock.now() }).where(eq(users.id, ids.users.owner));
    await expectDeadLink(db, token, "already_confirmed");
  });

  it("unknown, mangled, missing or wrong-kind links are dead links", async () => {
    await expectDeadLink(db, "x".repeat(43), "invalid");
    await expectDeadLink(db, "short", "invalid");
    await expectDeadLink(db, undefined, "invalid");
    await expectDeadLink(db, 12345, "invalid");
    await expect(failureOf(confirmEmail(db, null))).resolves.toMatchObject({ reason: "invalid" });
    await expect(failureOf(confirmEmail(db, { token: "x".repeat(43), extra: true }))).resolves.toMatchObject({ reason: "invalid" });
    // A password-reset token is not a confirm link.
    const reset = await withTx(
      (tx) => issueToken(tx, { organisationId: ids.organisationId, userId: ids.users.owner, kind: "password_reset", createdByUserId: null, now: NOW }),
      { db },
    );
    await expectDeadLink(db, reset.token, "invalid");
    expect((await userRow(ids.users.owner)).emailVerifiedAt).toBeNull();
  });

  it("a link only confirms the address it was sent to: after an email change it is dead", async () => {
    const token = await issueLink(ids.users.editor1);
    // The address changed without the link being closed (defence in depth: target_email no longer matches).
    await db.update(users).set({ email: "eve.new@studio.test" }).where(eq(users.id, ids.users.editor1));
    await expectDeadLink(db, token, "invalid");

    // The normal path: an email change closes the live links too.
    const token2 = await issueLink(ids.users.editor2);
    await withTx(async (tx) => {
      await tx.update(users).set({ email: "ed.new@studio.test" }).where(eq(users.id, ids.users.editor2));
      await clearEmailConfirmation(tx, { userId: ids.users.editor2, now: fakeClock.now() });
    }, { db });
    await expectDeadLink(db, token2, "invalid");
    expect((await userRow(ids.users.editor1)).emailVerifiedAt).toBeNull();
    expect((await userRow(ids.users.editor2)).emailVerifiedAt).toBeNull();
  });

  it("deactivated or anonymised accounts cannot be confirmed", async () => {
    const token = await issueLink(ids.users.editor2);
    await db.update(users).set({ isActive: false, deactivatedAt: NOW }).where(eq(users.id, ids.users.editor2));
    await expectDeadLink(db, token, "invalid");

    const token2 = await issueLink(ids.users.photographer2);
    await db.update(users).set({ anonymisedAt: NOW }).where(eq(users.id, ids.users.photographer2));
    await expectDeadLink(db, token2, "invalid");
  });

  it("a client whose online access is off can still confirm (recorded as the system)", async () => {
    const token = await issueLink(ids.users.client);
    await db.update(clients).set({ portalEnabled: false }).where(eq(clients.id, ids.clientId));
    await expect(confirmEmail(db, { token })).resolves.toMatchObject({ userId: ids.users.client });
    const [event] = await eventsOf("user.email_confirmed");
    expect(event).toMatchObject({ actorUserId: null, organisationId: ids.organisationId, entityId: ids.users.client });
  });

  it("org isolation: a link confirms its own studio's person and touches nothing in another studio", async () => {
    const other = await seedMinimalOrg(db, { slug: "other", emailVerified: false });
    const token = await issueLink(other.users.owner);
    await confirmEmail(db, { token });
    expect((await userRow(other.users.owner)).emailVerifiedAt).toBe(NOW);
    expect((await userRow(ids.users.owner)).emailVerifiedAt).toBeNull();
    const events = await eventsOf("user.email_confirmed");
    expect(events).toHaveLength(1);
    expect(events[0].organisationId).toBe(other.organisationId);
  });

  it("works in development without a mail provider (the dev-only link) — the e2e path", async () => {
    const token = await issueLink(ids.users.owner, db, DEV_NOT_CONFIGURED);
    await expect(confirmEmail(db, { token })).resolves.toMatchObject({ alreadyConfirmed: false });
  });
});
