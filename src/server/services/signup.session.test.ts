/**
 * The front door's "…AndSignIn" wrappers set the session cookie: sign-up (staff, photographer), invite acceptance
 * (kind by role: client → client cookie) and password reset. Drives the real cookie path with an in-memory
 * cookie jar standing in for `next/headers`.
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

// The vitest setup file already loaded the session module (through @/db/test-db) before this file's mock was
// registered, so that copy holds the real `cookies()`. Load fresh copies of every module the test drives.
vi.resetModules();
const { setDbOverride } = await import("@/db/index");
const { closeTestDbs, contextFor, fakeClock, makeTestDb, seedMinimalOrg } = await import("@/db/test-db");
const { requireAnyContext, requireContext, requirePortalContext, verifySessionToken } = await import("@/server/auth/session");
const { ValidationError } = await import("@/server/errors");
const { withTx } = await import("./_shared");
const { acceptInviteAndSignIn } = await import("./invites");
const { signUpAndSignIn } = await import("./organisations");
const { requestPasswordReset, resetPasswordAndSignIn } = await import("./passwordReset");
const { inviteUser } = await import("./users");

let db: TestDb;
let ids: SeedIds;

const GOOD = { ownerName: "Mo Carter", email: "mo@northlight.test", password: "CorrectHorse9!", studioName: "Northlight Studio", ip: "1.1.1.1" };
const NEW_PASSWORD = "BrandNewPass42!";

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  setDbOverride(db);
  jar.clear();
});
afterEach(async () => {
  setDbOverride(null);
  fakeClock.reset();
  await closeTestDbs();
});

describe("signUpAndSignIn", () => {
  it("creates the studio AND sets a staff cookie the owner's requests resolve with", async () => {
    const result = await signUpAndSignIn(GOOD, { db, requestId: "req-cookie" });
    const token = jar.get(SESSION_COOKIE_NAME);
    expect(token).toBeTruthy();
    expect(await verifySessionToken(token)).toEqual({ sub: result.userId, sv: 1, k: "staff", r: "photographer", at: expect.any(Number) });
    await expect(requireContext()).resolves.toMatchObject({ userId: result.userId, organisationId: result.organisationId, isAdmin: true, isPrimaryOwner: true });
  });

  it("sets no cookie when the sign-up fails", async () => {
    await expect(signUpAndSignIn({ ...GOOD, email: ids.emails.owner }, { db })).rejects.toThrow(ValidationError);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });
});

describe("acceptInviteAndSignIn", () => {
  it("an editor's accepted invite yields a staff cookie at the bumped session version", async () => {
    const ownerCtx = await contextFor(db, ids.users.owner);
    const invited = await withTx((tx) => inviteUser(tx, ownerCtx, { email: "sam@studio.test", name: "Sam", role: "editor" }), { db });
    const result = await acceptInviteAndSignIn({ token: invited.invite?.token, password: NEW_PASSWORD }, { db });
    expect(await verifySessionToken(jar.get(SESSION_COOKIE_NAME))).toEqual({ sub: result.userId, sv: 2, k: "staff", r: "editor", at: expect.any(Number) });
    await expect(requireContext()).resolves.toMatchObject({ userId: result.userId, role: "editor" });
  });

  it("a client's accepted invite yields a CLIENT cookie (portal, not the staff shell)", async () => {
    const ownerCtx = await contextFor(db, ids.users.owner);
    const invited = await withTx((tx) => inviteUser(tx, ownerCtx, { email: "harbour@client.test", name: "Harriet", role: "client", clientId: ids.clientId }), { db });
    const result = await acceptInviteAndSignIn({ token: invited.invite?.token, password: NEW_PASSWORD }, { db });
    expect(await verifySessionToken(jar.get(SESSION_COOKIE_NAME))).toEqual({ sub: result.userId, sv: 2, k: "client", r: "client", at: expect.any(Number) });
    await expect(requirePortalContext()).resolves.toMatchObject({ userId: result.userId, role: "client" });
    await expect(requireContext()).rejects.toThrow();
  });

  it("an invalid link sets no cookie", async () => {
    await expect(acceptInviteAndSignIn({ token: "unknown-token-that-is-long-enough-0123456789", password: NEW_PASSWORD }, { db })).rejects.toThrow(ValidationError);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });
});

describe("resetPasswordAndSignIn", () => {
  it("signs this browser in at the new session version while an older cookie no longer resolves", async () => {
    const request = await requestPasswordReset(db, { email: ids.emails.editor1, ip: "3.3.3.3" });
    const token = new URL(request.resetUrl ?? "").searchParams.get("token") ?? "";

    const result = await resetPasswordAndSignIn({ token, password: NEW_PASSWORD }, { db });
    expect(result.sessionVersion).toBe(2); // fixture users start at session_version 1
    expect(await verifySessionToken(jar.get(SESSION_COOKIE_NAME))).toEqual({ sub: ids.users.editor1, sv: result.sessionVersion, k: "staff", r: "editor", at: expect.any(Number) });
    await expect(requireAnyContext()).resolves.toMatchObject({ userId: ids.users.editor1 });
  });
});
