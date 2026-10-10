/**
 * Logout revokes the session server-side: a cookie copied before logout no
 * longer resolves (requireContext → 401), on this device or any other.
 * Drives the real cookie path (`requireContext` / `logout`) with an in-memory
 * cookie jar standing in for `next/headers`.
 */
import { eq } from "drizzle-orm";
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

// The vitest setup file (src/db/test-setup.ts) already loaded the session module — through
// @/db/test-db — before this file's mock was registered, so that copy holds the real
// `cookies()`. Load fresh copies of every module the test drives so they see the mock.
vi.resetModules();
const { first, setDbOverride } = await import("@/db/index");
const { activityEvents, users } = await import("@/db/schema");
const { closeTestDbs, contextFor, fakeClock, makeTestDb, seedMinimalOrg } = await import("@/db/test-db");
const { requireContext, signSessionToken } = await import("@/server/auth/session");
const { UnauthorizedError } = await import("@/server/errors");
const { logout } = await import("./auth");

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
  setDbOverride(null);
  fakeClock.reset();
  // These databases belong to the fresh @/db/test-db copy, which the setup file's cleanup does not see.
  await closeTestDbs();
});

const sessionVersion = async (userId: string) => (await first(db.select().from(users).where(eq(users.id, userId))))?.sessionVersion;

describe("logout", () => {
  it("bumps session_version so the pre-logout token (any copy of it) is rejected", async () => {
    const before = await sessionVersion(ids.users.editor1);
    const oldToken = await signSessionToken({ sub: ids.users.editor1, sv: before ?? 1 });
    jar.set(SESSION_COOKIE_NAME, oldToken);
    await expect(requireContext()).resolves.toMatchObject({ userId: ids.users.editor1 });

    await logout(await contextFor(db, ids.users.editor1), { ip: null, userAgent: "vitest" });
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(await sessionVersion(ids.users.editor1)).toBe((before ?? 1) + 1);

    // replay the copied cookie (another tab/device, or a stolen token)
    jar.set(SESSION_COOKIE_NAME, oldToken);
    await expect(requireContext()).rejects.toThrow(UnauthorizedError);

    const [event] = await db.select().from(activityEvents).where(eq(activityEvents.eventType, "auth.logged_out"));
    expect(event).toMatchObject({
      actorUserId: ids.users.editor1,
      entityId: ids.users.editor1,
      visibility: "management",
      previousValue: { sessionVersion: before },
      newValue: { sessionVersion: (before ?? 1) + 1 },
    });
    expect(event.metadata).toMatchObject({ allSessionsRevoked: true, userAgent: "vitest" });
  });

  it("only revokes the signed-out user's sessions", async () => {
    const coAdminToken = await signSessionToken({ sub: ids.users.coAdmin, sv: (await sessionVersion(ids.users.coAdmin)) ?? 1 });
    await logout(await contextFor(db, ids.users.editor1));
    jar.set(SESSION_COOKIE_NAME, coAdminToken);
    await expect(requireContext()).resolves.toMatchObject({ userId: ids.users.coAdmin });
  });

  it("without a session it just clears the cookie", async () => {
    jar.set(SESSION_COOKIE_NAME, "garbage");
    await logout(null);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(await db.select().from(activityEvents).where(eq(activityEvents.eventType, "auth.logged_out"))).toHaveLength(0);
  });
});
