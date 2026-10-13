/**
 * Advanced-tools page gates (docs/SIMPLIFICATION-PLAN.md §8): hidden pages are blocked on the server, not
 * only removed from the menu. `next/navigation` is mocked so the 404 / redirect calls can be observed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contextFor, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { NotFoundError } from "@/server/errors";

vi.mock("server-only", () => ({}));
const nav = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
  forbidden: vi.fn(() => {
    throw new Error("NEXT_FORBIDDEN");
  }),
}));
vi.mock("next/navigation", () => nav);

import { advancedEnabled, EDITOR_HOME_PATH, homePathFor, PORTAL_HOME_PATH, redirectUnlessAdvanced, requireAdvanced, requireAdvancedApi, STAFF_HOME_PATH } from "./page";
import { setAdvancedTools } from "./services/simple";
import { withTx } from "./services/_shared";

let db: TestDb;
let ids: SeedIds;
beforeEach(async () => {
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  nav.notFound.mockClear();
  nav.redirect.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("homePathFor", () => {
  it("clients land on /portal, editors on /my-jobs, photographers on /home", () => {
    expect(homePathFor({ role: "client" })).toBe(PORTAL_HOME_PATH);
    expect(homePathFor({ role: "editor" })).toBe(EDITOR_HOME_PATH);
    expect(homePathFor({ role: "photographer" })).toBe(STAFF_HOME_PATH);
    expect([PORTAL_HOME_PATH, EDITOR_HOME_PATH, STAFF_HOME_PATH]).toEqual(["/portal", "/my-jobs", "/home"]);
  });
});

describe("requireAdvanced / redirectUnlessAdvanced / requireAdvancedApi", () => {
  it("404 / redirect / NotFoundError while the studio has Advanced tools off", async () => {
    const owner = await contextFor(db, ids.users.owner);
    expect(advancedEnabled(owner)).toBe(false);
    expect(() => requireAdvanced(owner, "analytics")).toThrow("NEXT_NOT_FOUND");
    expect(nav.notFound).toHaveBeenCalledTimes(1);
    expect(() => redirectUnlessAdvanced(owner, "projects", "/jobs")).toThrow("NEXT_REDIRECT:/jobs");
    expect(nav.redirect).toHaveBeenCalledWith("/jobs");
    let caught: unknown;
    try {
      requireAdvancedApi(owner, "automations");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect((caught as NotFoundError).status).toBe(404);
    expect((caught as NotFoundError).message).toMatch(/Advanced tool/);
  });

  it("passes once the owner turns the switch on; the gate is per organisation, so a member sees it too", async () => {
    const ownerBefore = await contextFor(db, ids.users.owner);
    await withTx((tx) => setAdvancedTools(tx, ownerBefore, { enabled: true }), { db });
    const owner = await contextFor(db, ids.users.owner);
    const member = await contextFor(db, ids.users.photographer1);
    expect(advancedEnabled(owner)).toBe(true);
    expect(() => requireAdvanced(owner, "analytics")).not.toThrow();
    expect(() => redirectUnlessAdvanced(owner, "projects", "/jobs")).not.toThrow();
    expect(() => requireAdvancedApi(owner, "automations")).not.toThrow();
    expect(() => requireAdvancedApi(member, "kanban")).not.toThrow();
    expect(nav.notFound).not.toHaveBeenCalled();
    expect(nav.redirect).not.toHaveBeenCalled();
    // a client never sees staff advanced pages even when the switch is on
    const client = await contextFor(db, ids.users.client);
    expect(() => requireAdvanced(client, "analytics")).toThrow("NEXT_NOT_FOUND");
  });
});
