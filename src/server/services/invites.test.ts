/**
 * Invite links (front door): the default "link" invite stores an unusable password and a hashed token; login is
 * refused until the link is accepted; expiry, single use, revoke, resend (old links die), accept (password +
 * accepted_at + name + session bump), client portal users, org isolation and the temp-password fallback.
 */
import { compareSync } from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import { activityEvents, authTokens, clients, users } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { INVITE_TTL_HOURS } from "@/lib/constants";
import type { AuthContext } from "@/lib/types";
import { verifyPassword } from "@/server/auth/password";
import { hashToken } from "@/server/auth/tokens";
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import { authenticate } from "./auth";
import { INVITE_INVALID_MESSAGE, acceptInvite, createInvite, deliverInvite, lookupInvite, pendingInviteFor, resendInvite, revokeInvite } from "./invites";
import { inviteUser, inviteUserByMethod, inviteUserWithTempPassword, resetPassword, type InviteResult } from "./users";

let db: TestDb;
let ids: SeedIds;

const NEW_PASSWORD = "BrandNewPass42!";

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

async function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => Promise<T> | T): Promise<T> {
  const ctx = await contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}
const userRow = async (id: string) => first(db.select().from(users).where(eq(users.id, id)));
const tokensOf = async (userId: string) => db.select().from(authTokens).where(eq(authTokens.userId, userId)).orderBy(authTokens.createdAt);
const eventsOf = async (type: string) => db.select().from(activityEvents).where(eq(activityEvents.eventType, type)).orderBy(activityEvents.createdAt, activityEvents.rowid);
const invalid = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as Error).message).toBe(INVITE_INVALID_MESSAGE);
  expect((err as ValidationError).status).toBe(400);
};

/** Invites an editor with the default (link) method as the owner. */
async function inviteEditor(email = "sam@studio.test", name = "Sam Whitfield"): Promise<InviteResult & { invite: { token: string; expiresAt: string } }> {
  const res = await run(ids.users.owner, (tx, ctx) => inviteUser(tx, ctx, { email, name, role: "editor" }));
  if (!res.invite) throw new Error("expected a link invite");
  return { ...res, invite: res.invite };
}

describe("inviteUser — method 'link' (default)", () => {
  it("creates a pending user with NO usable password, a hashed 7-day token, invited_at and the user.invite_sent event; the plain token is returned once and never stored", async () => {
    const res = await inviteEditor();
    expect(res.method).toBe("link");
    expect(res.tempPassword).toBeNull();
    expect(res.invite.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(res.invite.expiresAt).toBe(new Date(Date.parse("2026-10-08T00:00:00.000Z") + INVITE_TTL_HOURS * 3_600_000).toISOString());

    const row = await userRow(res.user.id);
    expect(row).toMatchObject({ role: "editor", isActive: true, acceptedAt: null, invitedAt: "2026-10-08T00:00:00.000Z" });
    expect(row?.passwordHash.startsWith("!invite!")).toBe(true);
    expect(compareSync("", row?.passwordHash ?? "")).toBe(false);

    const tokens = await tokensOf(res.user.id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ organisationId: ids.organisationId, kind: "invite", createdByUserId: ids.users.owner, usedAt: null, expiresAt: res.invite.expiresAt, tokenHash: hashToken(res.invite.token) });
    expect(tokens[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(tokens)).not.toContain(res.invite.token);

    const [created] = await eventsOf("user.created");
    expect(created.metadata).toMatchObject({ method: "link", targetUserId: res.user.id });
    const [sent] = await eventsOf("user.invite_sent");
    expect(sent).toMatchObject({ entityId: res.user.id, actorUserId: ids.users.owner, visibility: "management", action: "invited", newValue: { email: "sam@studio.test", role: "editor", expiresAt: res.invite.expiresAt } });
    expect(sent.metadata).toMatchObject({ method: "link", resend: false, superseded: 0 });
    expect(JSON.stringify(await db.select().from(activityEvents))).not.toContain(res.invite.token);
    expect(await pendingInviteFor(db, res.user.id)).toEqual({ expiresAt: res.invite.expiresAt });
  });

  it("login is refused with the generic message until the invite is accepted (audited reason not_accepted)", async () => {
    const res = await inviteEditor();
    for (const password of ["anything", res.invite.token, NEW_PASSWORD]) {
      const err = await authenticate(db, { email: "sam@studio.test", password }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedError);
      expect((err as Error).message).toBe("Incorrect email or password");
    }
    const failures = await eventsOf("auth.login_failed");
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[failures.length - 1].metadata).toMatchObject({ reason: "not_accepted" });
  });

  it("inviteUserByMethod picks the path from the body; 'temp_password' keeps the old behaviour (usable password, accepted at once)", async () => {
    const ctx = await contextFor(db, ids.users.owner);
    const link = await inviteUserByMethod(ctx, { email: "link@studio.test", name: "Link", role: "editor" }, db);
    expect(link.method).toBe("link");
    expect(link.invite).not.toBeNull();

    const temp = await inviteUserByMethod(ctx, { email: "temp@studio.test", name: "Temp", role: "editor", method: "temp_password" }, db);
    expect(temp).toMatchObject({ method: "temp_password", invite: null });
    expect(typeof temp.tempPassword).toBe("string");
    const row = await userRow(temp.user.id);
    expect(row?.acceptedAt).toBe("2026-10-08T00:00:00.000Z");
    expect(compareSync(temp.tempPassword ?? "", row?.passwordHash ?? "")).toBe(true);
    expect(await tokensOf(temp.user.id)).toHaveLength(0);
    await expect(authenticate(db, { email: "temp@studio.test", password: temp.tempPassword ?? "" })).resolves.toMatchObject({ id: temp.user.id });

    const legacy = await inviteUserWithTempPassword(ctx, { email: "legacy@studio.test", name: "Legacy", role: "photographer" }, db);
    expect(legacy.method).toBe("temp_password");
  });
});

describe("lookupInvite + acceptInvite", () => {
  it("lookup shows studio, inviter, role, email and name for a live link; accept sets password, accepted_at, name, bumps session_version, marks the token used and signs the person in", async () => {
    const res = await inviteEditor();
    const before = await userRow(res.user.id);
    await expect(lookupInvite(db, { token: res.invite.token })).resolves.toEqual({
      valid: true,
      studioName: "Studio Studio",
      inviterName: "Olivia Owner",
      role: "editor",
      persona: "editor",
      personaLabel: "Editor",
      email: "sam@studio.test",
      name: "Sam Whitfield",
      expiresAt: res.invite.expiresAt,
    });

    fakeClock.advanceDays(2);
    const accepted = await acceptInvite(db, { token: res.invite.token, password: NEW_PASSWORD, name: "Samuel Whitfield", ip: "2.2.2.2", userAgent: "vitest" }, { requestId: "req-accept" });
    expect(accepted).toMatchObject({ userId: res.user.id, organisationId: ids.organisationId, name: "Samuel Whitfield", email: "sam@studio.test", role: "editor", sessionVersion: (before?.sessionVersion ?? 1) + 1 });

    const after = await userRow(res.user.id);
    expect(before?.lastLoginAt).toBeNull();
    expect(after).toMatchObject({ name: "Samuel Whitfield", acceptedAt: fakeClock.now(), lastLoginAt: fakeClock.now(), sessionVersion: (before?.sessionVersion ?? 1) + 1, version: (before?.version ?? 1) + 1 });
    expect(await verifyPassword(NEW_PASSWORD, after?.passwordHash ?? "")).toBe(true);
    expect((await tokensOf(res.user.id))[0].usedAt).toBe(fakeClock.now());

    const [event] = await eventsOf("user.accepted_invite");
    expect(event).toMatchObject({ entityId: res.user.id, actorUserId: res.user.id, visibility: "management", action: "accepted", previousValue: { acceptedAt: null, name: "Sam Whitfield" }, newValue: { acceptedAt: fakeClock.now(), name: "Samuel Whitfield" } });
    expect(event.metadata).toMatchObject({ requestId: "req-accept", ip: "2.2.2.2", nameChanged: true });
    expect(JSON.stringify(event)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(event)).not.toContain(res.invite.token);

    await expect(authenticate(db, { email: "sam@studio.test", password: NEW_PASSWORD })).resolves.toMatchObject({ id: res.user.id, role: "editor" });
    expect(await pendingInviteFor(db, res.user.id)).toBeNull();
  });

  it("accept keeps the name when none is given", async () => {
    const res = await inviteEditor();
    await acceptInvite(db, { token: res.invite.token, password: NEW_PASSWORD });
    expect((await userRow(res.user.id))?.name).toBe("Sam Whitfield");
    expect((await eventsOf("user.accepted_invite"))[0].metadata).toMatchObject({ nameChanged: false });
  });

  it("a used link is dead: second accept and lookup both fail generically (single use)", async () => {
    const res = await inviteEditor();
    await acceptInvite(db, { token: res.invite.token, password: NEW_PASSWORD });
    await expect(lookupInvite(db, { token: res.invite.token })).resolves.toEqual({ valid: false });
    await invalid(acceptInvite(db, { token: res.invite.token, password: "AnotherPass123!" }));
    expect(await verifyPassword(NEW_PASSWORD, (await userRow(res.user.id))?.passwordHash ?? "")).toBe(true);
  });

  it("an expired link fails generically; unknown, malformed and empty tokens too", async () => {
    const res = await inviteEditor();
    fakeClock.advanceHours(INVITE_TTL_HOURS);
    fakeClock.advanceMs(1);
    await expect(lookupInvite(db, { token: res.invite.token })).resolves.toEqual({ valid: false });
    await invalid(acceptInvite(db, { token: res.invite.token, password: NEW_PASSWORD }));
    expect((await userRow(res.user.id))?.acceptedAt).toBeNull();

    for (const token of ["unknown-token-that-is-long-enough-0123456789", "short", "", "has spaces in it which is not allowed!!"]) {
      await expect(lookupInvite(db, { token })).resolves.toEqual({ valid: false });
    }
    await expect(lookupInvite(db, null)).resolves.toEqual({ valid: false });
    await expect(acceptInvite(db, { token: "unknown-token-that-is-long-enough-0123456789", password: NEW_PASSWORD })).rejects.toThrow(INVITE_INVALID_MESSAGE);
    // a weak password is still a validation error (not the generic one) — the link is not consumed by it
    const fresh = await inviteEditor("fresh@studio.test", "Fresh");
    await expect(acceptInvite(db, { token: fresh.invite.token, password: "short" })).rejects.toThrow(ValidationError);
    await expect(lookupInvite(db, { token: fresh.invite.token })).resolves.toMatchObject({ valid: true });
  });

  it("a deactivated invitee's link fails generically", async () => {
    const res = await inviteEditor();
    await db.update(users).set({ isActive: false, deactivatedAt: fakeClock.now() }).where(eq(users.id, res.user.id));
    await expect(lookupInvite(db, { token: res.invite.token })).resolves.toEqual({ valid: false });
    await invalid(acceptInvite(db, { token: res.invite.token, password: NEW_PASSWORD }));
  });
});

describe("resendInvite / revokeInvite / createInvite", () => {
  it("resend issues a new token and the old one stops working (superseded, audited resend: true)", async () => {
    const res = await inviteEditor();
    fakeClock.advanceHours(1);
    const again = await run(ids.users.owner, (tx, ctx) => resendInvite(tx, ctx, { userId: res.user.id }));
    expect(again.token).not.toBe(res.invite.token);
    expect(again.expiresAt).toBe(new Date(Date.parse(fakeClock.now()) + INVITE_TTL_HOURS * 3_600_000).toISOString());

    const tokens = await tokensOf(res.user.id);
    expect(tokens).toHaveLength(2);
    expect(tokens[0].usedAt).toBe(fakeClock.now());
    expect(tokens[1]).toMatchObject({ usedAt: null, tokenHash: hashToken(again.token) });
    expect((await userRow(res.user.id))?.invitedAt).toBe(fakeClock.now());

    await expect(lookupInvite(db, { token: res.invite.token })).resolves.toEqual({ valid: false });
    await invalid(acceptInvite(db, { token: res.invite.token, password: NEW_PASSWORD }));
    await expect(lookupInvite(db, { token: again.token })).resolves.toMatchObject({ valid: true });

    const sent = await eventsOf("user.invite_sent");
    expect(sent).toHaveLength(2);
    expect(sent[1].metadata).toMatchObject({ resend: true, superseded: 1, method: "link" });
    expect(JSON.stringify(sent)).not.toContain(again.token);

    await expect(acceptInvite(db, { token: again.token, password: NEW_PASSWORD })).resolves.toMatchObject({ userId: res.user.id });
  });

  it("revoke consumes every live token (0 when none) and is audited; the account stays, with no way in", async () => {
    const res = await inviteEditor();
    const revoked = await run(ids.users.coAdmin, (tx, ctx) => revokeInvite(tx, ctx, { userId: res.user.id }));
    expect(revoked).toEqual({ userId: res.user.id, revoked: 1 });
    expect((await tokensOf(res.user.id))[0].usedAt).toBe(fakeClock.now());
    await expect(lookupInvite(db, { token: res.invite.token })).resolves.toEqual({ valid: false });
    await invalid(acceptInvite(db, { token: res.invite.token, password: NEW_PASSWORD }));
    expect(await userRow(res.user.id)).toMatchObject({ isActive: true, acceptedAt: null });

    const [event] = await eventsOf("user.invite_revoked");
    expect(event).toMatchObject({ entityId: res.user.id, actorUserId: ids.users.coAdmin, action: "revoked", visibility: "management" });
    expect(event.metadata).toMatchObject({ revoked: 1 });

    // nothing left to revoke: still a success
    await expect(run(ids.users.owner, (tx, ctx) => revokeInvite(tx, ctx, { userId: res.user.id }))).resolves.toEqual({ userId: res.user.id, revoked: 0 });
    // a new link after a revoke works again
    const again = await run(ids.users.owner, (tx, ctx) => createInvite(tx, ctx, { userId: res.user.id }));
    await expect(acceptInvite(db, { token: again.token, password: NEW_PASSWORD })).resolves.toMatchObject({ userId: res.user.id });
  });

  it("only admins may invite / resend / revoke; an accepted person cannot be re-invited; another org's admin gets 404", async () => {
    const res = await inviteEditor();
    await expect(run(ids.users.editor1, (tx, ctx) => resendInvite(tx, ctx, { userId: res.user.id }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.lead, (tx, ctx) => revokeInvite(tx, ctx, { userId: res.user.id }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.photographer1, (tx, ctx) => createInvite(tx, ctx, { userId: res.user.id }))).rejects.toThrow(ForbiddenError);

    const other = await seedMinimalOrg(db, { slug: "other", emailDomain: "other.test" });
    await expect(run(other.users.owner, (tx, ctx) => resendInvite(tx, ctx, { userId: res.user.id }))).rejects.toThrow(NotFoundError);
    await expect(run(other.users.owner, (tx, ctx) => revokeInvite(tx, ctx, { userId: res.user.id }))).rejects.toThrow(NotFoundError);

    // already joined
    await expect(run(ids.users.owner, (tx, ctx) => resendInvite(tx, ctx, { userId: ids.users.editor1 }))).rejects.toThrow(/already joined/);
    await acceptInvite(db, { token: res.invite.token, password: NEW_PASSWORD });
    const err = await run(ids.users.owner, (tx, ctx) => resendInvite(tx, ctx, { userId: res.user.id })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).status).toBe(422);
    // deactivated
    await db.update(users).set({ isActive: false, deactivatedAt: fakeClock.now(), acceptedAt: null }).where(eq(users.id, res.user.id));
    await expect(run(ids.users.owner, (tx, ctx) => resendInvite(tx, ctx, { userId: res.user.id }))).rejects.toThrow(/deactivated/);
    // bad input
    await expect(run(ids.users.owner, (tx, ctx) => resendInvite(tx, ctx, { userId: "" }))).rejects.toThrow(ValidationError);
    await expect(run(ids.users.owner, (tx, ctx) => resendInvite(tx, ctx, { userId: "nope" }))).rejects.toThrow(NotFoundError);
  });

  it("the owner-side temp-password reset on a pending invitee makes them accepted and kills their live link", async () => {
    const res = await inviteEditor();
    const reset = await run(ids.users.owner, (tx, ctx) => resetPassword(tx, ctx, { userId: res.user.id }));
    expect(typeof reset.tempPassword).toBe("string");
    const row = await userRow(res.user.id);
    expect(row?.acceptedAt).toBe(fakeClock.now());
    expect(compareSync(reset.tempPassword, row?.passwordHash ?? "")).toBe(true);
    expect((await tokensOf(res.user.id))[0].usedAt).toBe(fakeClock.now());
    await expect(lookupInvite(db, { token: res.invite.token })).resolves.toEqual({ valid: false });
    await expect(authenticate(db, { email: "sam@studio.test", password: reset.tempPassword })).resolves.toMatchObject({ id: res.user.id });
    const changed = await eventsOf("user.password_changed");
    expect(changed[changed.length - 1].metadata).toMatchObject({ acceptedVia: "temp_password", invitesSuperseded: 1 });
  });
});

describe("client portal users", () => {
  it("a client user is invited through the same link flow and lands in the portal; a closed portal makes the link fail generically", async () => {
    const res = await run(ids.users.owner, (tx, ctx) => inviteUser(tx, ctx, { email: "harbour@client.test", name: "Harriet Harbour", role: "client", clientId: ids.clientId }));
    expect(res.method).toBe("link");
    if (!res.invite) throw new Error("expected a link invite");
    await expect(lookupInvite(db, { token: res.invite.token })).resolves.toMatchObject({ valid: true, role: "client", persona: "client", email: "harbour@client.test" });

    // portal off → the person has no context → generic failure, nothing consumed
    await db.update(clients).set({ portalEnabled: false }).where(eq(clients.id, ids.clientId));
    await expect(lookupInvite(db, { token: res.invite.token })).resolves.toMatchObject({ valid: true });
    await invalid(acceptInvite(db, { token: res.invite.token, password: NEW_PASSWORD }));
    expect((await tokensOf(res.user.id))[0].usedAt).toBeNull();

    await db.update(clients).set({ portalEnabled: true }).where(eq(clients.id, ids.clientId));
    const accepted = await acceptInvite(db, { token: res.invite.token, password: NEW_PASSWORD });
    expect(accepted).toMatchObject({ role: "client", userId: res.user.id });
    await expect(authenticate(db, { email: "harbour@client.test", password: NEW_PASSWORD })).resolves.toMatchObject({ id: res.user.id, role: "client" });
  });
});

describe("deliverInvite", () => {
  it("builds the link from the token and reports emailed: false under the console provider (never throws)", async () => {
    const res = await inviteEditor();
    const delivery = await deliverInvite(db, { token: res.invite.token, expiresAt: res.invite.expiresAt, userId: res.user.id, inviterUserId: ids.users.owner, req: new Request("https://studio.example.com/api/users", { method: "POST" }) });
    expect(delivery.emailed).toBe(false);
    expect(delivery.expiresAt).toBe(res.invite.expiresAt);
    expect(delivery.inviteUrl.endsWith(`/invite/${res.invite.token}`)).toBe(true);
    expect(() => new URL(delivery.inviteUrl)).not.toThrow();
    // unknown user → still a usable link, nothing emailed
    await expect(deliverInvite(db, { token: res.invite.token, expiresAt: res.invite.expiresAt, userId: "missing", inviterUserId: null })).resolves.toMatchObject({ emailed: false });
  });
});
