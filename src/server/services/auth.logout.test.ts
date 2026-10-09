/**
 * Logout revokes the session server-side: a cookie copied before logout no
 * longer resolves (requireContext → 401), on this device or any other.
 * Drives the real cookie path (`requireContext` / `logout`) with an in-memory
 * cookie jar standing in for `next/headers`.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDbOverride } from "@/db/index";
import { activityEvents, users } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { SESSION_COOKIE_NAME } from "@/lib/constants";
import { requireContext, signSessionToken } from "@/server/auth/session";
import { UnauthorizedError } from "@/server/errors";
import { logout } from "./auth";

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

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
  setDbOverride(db);
  jar.clear();
});
afterEach(() => {
  setDbOverride(null);
  fakeClock.reset();
});

const sessionVersion = (userId: string) => db.select().from(users).where(eq(users.id, userId)).get()?.sessionVersion;

describe("logout", () => {
  it("bumps session_version so the pre-logout token (any copy of it) is rejected", async () => {
    const before = sessionVersion(ids.users.editor1);
    const oldToken = await signSessionToken({ sub: ids.users.editor1, sv: before ?? 1 });
    jar.set(SESSION_COOKIE_NAME, oldToken);
    await expect(requireContext()).resolves.toMatchObject({ userId: ids.users.editor1 });

    await logout(contextFor(db, ids.users.editor1), { ip: null, userAgent: "vitest" });
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(sessionVersion(ids.users.editor1)).toBe((before ?? 1) + 1);

    // replay the copied cookie (another tab/device, or a stolen token)
    jar.set(SESSION_COOKIE_NAME, oldToken);
    await expect(requireContext()).rejects.toThrow(UnauthorizedError);

    const [event] = db.select().from(activityEvents).where(eq(activityEvents.eventType, "auth.logged_out")).all();
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
    const managerToken = await signSessionToken({ sub: ids.users.manager, sv: sessionVersion(ids.users.manager) ?? 1 });
    await logout(contextFor(db, ids.users.editor1));
    jar.set(SESSION_COOKIE_NAME, managerToken);
    await expect(requireContext()).resolves.toMatchObject({ userId: ids.users.manager });
  });

  it("without a session it just clears the cookie", async () => {
    jar.set(SESSION_COOKIE_NAME, "garbage");
    await logout(null);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(db.select().from(activityEvents).where(eq(activityEvents.eventType, "auth.logged_out")).all()).toHaveLength(0);
  });
});
