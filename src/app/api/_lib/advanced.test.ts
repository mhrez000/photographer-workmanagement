/**
 * Advanced-tools gate on the REST surface (docs/SIMPLIFICATION-PLAN.md §8): while a studio has Advanced
 * tools off, every `/api/*` route of a hidden feature is a 404 JSON; turning the switch on lets the same
 * request through to the feature's own permission checks. Drives the REAL route handlers with an
 * in-memory cookie jar standing in for `next/headers` (same pattern as services/auth.logout.test.ts).
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
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  forbidden: () => {
    throw new Error("NEXT_FORBIDDEN");
  },
}));

// The vitest setup file loaded the session module (through @/db/test-db) before these mocks were
// registered, so load fresh copies of everything the test drives.
vi.resetModules();
const { setDbOverride } = await import("@/db/index");
const { closeTestDbs, contextFor, insertJobFixture, makeTestDb, seedMinimalOrg } = await import("@/db/test-db");
const { signSessionToken } = await import("@/server/auth/session");
const { withTx } = await import("@/server/services/_shared");
const { setAdvancedTools } = await import("@/server/services/simple");
const { NotFoundError } = await import("@/server/errors");
const { advancedFeatureForApiPath, gateAdvancedApi } = await import("./advanced");
const { advancedFeatureForApi } = await import("@/config/nav");
const { ADVANCED_FEATURE_META, ADVANCED_FEATURES, ADVANCED_JOB_SUBPATHS } = await import("@/lib/constants");

const meTimer = await import("@/app/api/me/timer/route");
const workloads = await import("@/app/api/workloads/route");
const kanban = await import("@/app/api/kanban/route");
const bulkReassign = await import("@/app/api/jobs/bulk/reassign/route");
const dryRun = await import("@/app/api/automations/[id]/dry-run/route");
const jobSessions = await import("@/app/api/jobs/[id]/sessions/route");
const jobsSimple = await import("@/app/api/jobs/simple/route");
const settingsAdvanced = await import("@/app/api/settings/advanced/route");
const jobSimplePage = await import("@/app/api/jobs/[id]/simple/route");

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  setDbOverride(db);
  jar.clear();
});
afterEach(async () => {
  setDbOverride(null);
  await closeTestDbs();
});

const ORIGIN = "http://studio.test";

async function signInAs(userId: string): Promise<void> {
  jar.set(SESSION_COOKIE_NAME, await signSessionToken({ sub: userId, sv: 1 }));
}

function req(path: string, init: { method?: string; body?: unknown } = {}): Request {
  const method = init.method ?? "GET";
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      host: "studio.test",
      ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const params = <P extends Record<string, string>>(p: P) => ({ params: Promise.resolve(p) });

async function turnAdvancedOn(): Promise<void> {
  const owner = await contextFor(db, ids.users.owner);
  await withTx((tx) => setAdvancedTools(tx, owner, { enabled: true }), { db });
}

async function errorOf(res: Response): Promise<{ status: number; code?: string; message?: string }> {
  const body = (await res.json()) as { error?: { code: string; message: string } };
  return { status: res.status, code: body.error?.code, message: body.error?.message };
}

describe("advancedFeatureForApiPath", () => {
  it("agrees with the nav config on every apiPrefix and matches sub-paths under it", () => {
    for (const key of ADVANCED_FEATURES) {
      for (const prefix of ADVANCED_FEATURE_META[key].apiPrefixes) {
        expect(advancedFeatureForApiPath(prefix)).toBe(key);
        expect(advancedFeatureForApiPath(`${prefix}/abc/def`)).toBe(key);
        expect(advancedFeatureForApi(prefix)).toBe(key);
        // a sibling route sharing the text but not the segment is NOT gated (/api/kanbanx, /api/dashboard)
        expect(advancedFeatureForApiPath(`${prefix}x`)).toBeNull();
      }
    }
    expect(advancedFeatureForApiPath("/api/dashboard")).toBeNull();
    expect(advancedFeatureForApiPath("/api/me/work")).toBeNull();
    expect(advancedFeatureForApiPath("/api/settings")).toBeNull();
    expect(advancedFeatureForApiPath("/api/settings/advanced")).toBeNull();
  });

  it("gates the per-job advanced sub-paths and nothing else under /api/jobs", () => {
    for (const [sub, feature] of Object.entries(ADVANCED_JOB_SUBPATHS)) {
      expect(advancedFeatureForApiPath(`/api/jobs/abc123/${sub}`)).toBe(feature);
      expect(advancedFeatureForApiPath(`/api/jobs/abc123/${sub}/`)).toBe(feature);
    }
    expect(advancedFeatureForApiPath("/api/jobs/abc123")).toBeNull();
    expect(advancedFeatureForApiPath("/api/jobs/abc123/simple/approve")).toBeNull();
    expect(advancedFeatureForApiPath("/api/jobs/abc123/transitions")).toBeNull();
    expect(advancedFeatureForApiPath("/api/jobs/abc123/links")).toBeNull();
    expect(advancedFeatureForApiPath("/api/jobs/simple")).toBeNull();
    expect(advancedFeatureForApiPath("/api/jobs/simple/calendar")).toBeNull();
    expect(advancedFeatureForApiPath("/api/jobs/by-number/PJ-0001")).toBeNull();
    // /api/jobs/bulk/* is gated by its prefix (bulk_ui), not by the sub-path table
    expect(advancedFeatureForApiPath("/api/jobs/bulk/reassign")).toBe("bulk_ui");
  });
});

describe("gateAdvancedApi (fixture)", () => {
  it("throws NotFoundError (404) for a gated path while Advanced is off, passes once on, ignores other paths", async () => {
    const off = await contextFor(db, ids.users.owner);
    expect(() => gateAdvancedApi(off, "/api/jobs/simple")).not.toThrow();
    let caught: unknown;
    try {
      gateAdvancedApi(off, "/api/kanban");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    const err = caught as InstanceType<typeof NotFoundError>;
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/Advanced tool/);

    await turnAdvancedOn();
    const on = await contextFor(db, ids.users.owner);
    expect(() => gateAdvancedApi(on, "/api/kanban")).not.toThrow();
    expect(() => gateAdvancedApi(on, `/api/jobs/x/timer`)).not.toThrow();
  });
});

describe("route handlers", () => {
  it("factory routes under a gated prefix: 404 JSON while off, through once on", async () => {
    await signInAs(ids.users.owner);
    expect(await errorOf(await meTimer.GET(req("/api/me/timer"), params({})))).toMatchObject({ status: 404, code: "not_found" });
    expect(await errorOf(await workloads.GET(req("/api/workloads"), params({})))).toMatchObject({ status: 404, code: "not_found" });
    expect((await kanban.GET(req("/api/kanban"), params({}))).status).toBe(404);

    await turnAdvancedOn();
    expect((await meTimer.GET(req("/api/me/timer"), params({}))).status).toBe(200);
    expect((await workloads.GET(req("/api/workloads"), params({}))).status).toBe(200);
    expect((await kanban.GET(req("/api/kanban"), params({}))).status).toBe(200);
  });

  it("raw-handle routes (bulk, dry-run) are gated too; their own validation runs only once the switch is on", async () => {
    await signInAs(ids.users.owner);
    const body = { jobIds: [], userId: null };
    expect((await bulkReassign.POST(req("/api/jobs/bulk/reassign", { method: "POST", body }), params({}))).status).toBe(404);
    expect((await dryRun.POST(req("/api/automations/nope/dry-run", { method: "POST", body: {} }), params({ id: "nope" }))).status).toBe(404);

    await turnAdvancedOn();
    // past the gate: the bulk service's own schema rejects the empty list (400), not a 404
    expect((await bulkReassign.POST(req("/api/jobs/bulk/reassign", { method: "POST", body }), params({}))).status).toBe(400);
    // past the gate: the dry-run service's own validation / lookup answers, never the Advanced-tools 404
    const dry = await errorOf(await dryRun.POST(req("/api/automations/nope/dry-run", { method: "POST", body: {} }), params({ id: "nope" })));
    expect([400, 404]).toContain(dry.status);
    expect(dry.message ?? "").not.toMatch(/Advanced tool/);
  });

  it("a wrong method on a gated path is still a 404 while off (never a 405 that reveals the route), 405 once on", async () => {
    await signInAs(ids.users.owner);
    expect(await errorOf(await meTimer.DELETE(req("/api/me/timer", { method: "DELETE" }), params({})))).toMatchObject({ status: 404, code: "not_found" });
    expect(await errorOf(await kanban.POST(req("/api/kanban", { method: "POST", body: {} }), params({})))).toMatchObject({ status: 404, code: "not_found" });
    // an ungated route keeps its plain 405
    expect(await errorOf(await jobsSimple.DELETE(req("/api/jobs/simple", { method: "DELETE" }), params({})))).toMatchObject({ status: 405, code: "method_not_allowed" });

    await turnAdvancedOn();
    const res = await meTimer.DELETE(req("/api/me/timer", { method: "DELETE" }), params({}));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("per-job advanced sub-paths 404 while off; the plain job routes stay available", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    await signInAs(ids.users.owner);
    expect(await errorOf(await jobSessions.GET(req(`/api/jobs/${job.id}/sessions`), params({ id: job.id })))).toMatchObject({ status: 404, code: "not_found" });
    expect((await jobSimplePage.GET(req(`/api/jobs/${job.id}/simple`), params({ id: job.id }))).status).toBe(200);

    await turnAdvancedOn();
    expect((await jobSessions.GET(req(`/api/jobs/${job.id}/sessions`), params({ id: job.id }))).status).toBe(200);
  });

  it("the simplified routes are never gated, and the gate runs after auth (401 without a session)", async () => {
    expect((await jobsSimple.GET(req("/api/jobs/simple"), params({}))).status).toBe(401);
    expect((await kanban.GET(req("/api/kanban"), params({}))).status).toBe(401);

    await signInAs(ids.users.owner);
    const list = await jobsSimple.GET(req("/api/jobs/simple?stage=all_active"), params({}));
    expect(list.status).toBe(200);
    const payload = (await list.json()) as { data: { rows: unknown[]; counts: { allActive: number } } };
    expect(Array.isArray(payload.data.rows)).toBe(true);
    expect(payload.data.counts.allActive).toBeTypeOf("number");

    // the switch itself is read and flipped through /api/settings/advanced
    const before = (await (await settingsAdvanced.GET(req("/api/settings/advanced"), params({}))).json()) as { data: { enabled: boolean; effective: boolean } };
    expect(before.data).toMatchObject({ enabled: false, effective: false });
    const patched = await settingsAdvanced.PATCH(req("/api/settings/advanced", { method: "PATCH", body: { enabled: true } }), params({}));
    expect(patched.status).toBe(200);
    const after = (await (await settingsAdvanced.GET(req("/api/settings/advanced"), params({}))).json()) as { data: { enabled: boolean } };
    expect(after.data.enabled).toBe(true);
    expect((await kanban.GET(req("/api/kanban"), params({}))).status).toBe(200);
  });

  it("an editor sees the same 404 (the gate is per organisation, before the feature's own permission)", async () => {
    await signInAs(ids.users.editor1);
    expect((await workloads.GET(req("/api/workloads"), params({}))).status).toBe(404);
    await turnAdvancedOn();
    // own-row workloads are allowed for an editor once the switch is on
    expect((await workloads.GET(req("/api/workloads"), params({}))).status).toBe(200);
  });
});
