/**
 * "Look around the demo" (docs/ACCOUNTS.md §7): `demoSignIn` / POST /api/auth/demo sign a browser into the demo studio
 * as one persona through the shared `startSession` (cookie, last_login_at, `auth.logged_in` method "demo"); refusals
 * (turned off, no demo studio, a real studio's look-alike addresses, closed portal, bad input); org isolation; and
 * signing out of the demo (logout / the banner's sign-out action) never signs the other visitors out.
 * Drives the real cookie path with an in-memory jar standing in for `next/headers`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeedIds, TestDb } from "@/db/test-db";
import { DEMO_PERSONAS, SESSION_COOKIE_NAME, type DemoPersona } from "@/lib/constants";

const jar = vi.hoisted(() => new Map<string, string>());
const redirects = vi.hoisted(() => [] as string[]);
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
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    redirects.push(to);
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
// The route file shares `_lib/route` (→ the Advanced-tools gate → src/server/page.ts, which is `server-only`).
vi.mock("server-only", () => ({}));

vi.resetModules();
const { and, eq } = await import("drizzle-orm");
const { first, setDbOverride } = await import("@/db/index");
const { activityEvents, authRateLimits, clients, organisations, users } = await import("@/db/schema");
const { closeTestDbs, contextFor, fakeClock, makeTestDb, seedMinimalOrg } = await import("@/db/test-db");
const { requireAnyContext, verifySessionToken } = await import("@/server/auth/session");
const { NotFoundError, UnauthorizedError, ValidationError } = await import("@/server/errors");
const { DEMO_OFF_MESSAGE, demoSignIn } = await import("./demo");
const { logout } = await import("./auth");
const { signOutAction } = await import("@/server/actions/auth");
const demoRoute = await import("@/app/api/auth/demo/route");

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { isDemo: true });
  setDbOverride(db);
  jar.clear();
  redirects.length = 0;
});
afterEach(async () => {
  setDbOverride(null);
  fakeClock.reset();
  await closeTestDbs();
});

const META = { ip: "1.2.3.4", userAgent: "vitest" };
const EXPECTED: Record<DemoPersona, { key: keyof SeedIds["users"]; role: string; kind: "staff" | "client"; home: string }> = {
  owner: { key: "owner", role: "photographer", kind: "staff", home: "/home" },
  photographer: { key: "photographer1", role: "photographer", kind: "staff", home: "/home" },
  editor: { key: "editor1", role: "editor", kind: "staff", home: "/my-jobs" },
  client: { key: "client", role: "client", kind: "client", home: "/portal" },
};
const signInEvents = async () => db.select().from(activityEvents).where(eq(activityEvents.eventType, "auth.logged_in")).orderBy(activityEvents.createdAt, activityEvents.rowid);
const sessionVersion = async (userId: string) => (await first(db.select({ sv: users.sessionVersion }).from(users).where(eq(users.id, userId))))?.sv;

describe("demoSignIn — each persona", () => {
  it.each(DEMO_PERSONAS)("%s: signs this browser in as the seeded persona and lands on their home", async (persona) => {
    const want = EXPECTED[persona];
    const userId = ids.users[want.key];
    const result = await demoSignIn(db, { persona, ...META }, { requestId: `req-demo-${persona}`, env: {} });
    expect(result).toMatchObject({ redirectTo: want.home, user: { id: userId, role: want.role } });

    // The cookie is a normal session for that user (kind + role hint), and resolves to a demo context.
    const claims = await verifySessionToken(jar.get(SESSION_COOKIE_NAME));
    expect(claims).toMatchObject({ sub: userId, sv: 1, k: want.kind, r: want.role });
    const ctx = await requireAnyContext();
    expect(ctx).toMatchObject({ userId, organisationId: ids.organisationId, isDemo: true });

    // One sign-in, recorded like any other: method "demo", the persona, the request id; last_login_at stamped.
    const [event] = await signInEvents();
    expect(event).toMatchObject({ actorUserId: userId, entityId: userId, visibility: "management" });
    expect(event.metadata).toMatchObject({ method: "demo", persona, ip: "1.2.3.4", userAgent: "vitest", requestId: `req-demo-${persona}` });
    expect((await first(db.select().from(users).where(eq(users.id, userId))))?.lastLoginAt).toBe("2026-10-08T00:00:00.000Z");
  });

  it("a second visitor as the same persona shares the account without signing the first one out", async () => {
    await demoSignIn(db, { persona: "owner", ...META }, { env: {} });
    const first1 = jar.get(SESSION_COOKIE_NAME);
    jar.clear();
    await demoSignIn(db, { persona: "owner", ip: "5.6.7.8" }, { env: {} });
    jar.set(SESSION_COOKIE_NAME, first1 ?? "");
    await expect(requireAnyContext()).resolves.toMatchObject({ userId: ids.users.owner });
  });
});

describe("demoSignIn — refusals", () => {
  it("DEMO_SIGN_IN=off → 404 'The demo studio is turned off' (before reading the body), no cookie, nothing counted", async () => {
    for (const value of ["off", "false", "0", "no", " OFF "]) {
      const err = await demoSignIn(db, { persona: "owner", ...META }, { env: { DEMO_SIGN_IN: value } }).catch((e: unknown) => e);
      expect(err, value).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toBe(DEMO_OFF_MESSAGE);
    }
    await expect(demoSignIn(db, { persona: "nobody" }, { env: { DEMO_SIGN_IN: "off" } })).rejects.toThrow(NotFoundError);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(await db.select().from(authRateLimits)).toHaveLength(0);
    expect(await signInEvents()).toHaveLength(0);
  });

  it("no demo studio on this deployment → 404: a REAL studio's people with the same addresses are never signed in", async () => {
    await db.update(organisations).set({ isDemo: false }).where(eq(organisations.id, ids.organisationId));
    for (const persona of DEMO_PERSONAS) {
      const err = await demoSignIn(db, { persona, ...META }, { env: {} }).catch((e: unknown) => e);
      expect(err, persona).toBeInstanceOf(NotFoundError);
    }
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(await signInEvents()).toHaveLength(0);
  });

  it("an unknown persona or extra fields → 400; nothing signed in", async () => {
    for (const raw of [{ persona: "admin" }, { persona: "owner", email: "owner@studio.test" }, {}, null]) {
      await expect(demoSignIn(db, raw, { env: {} })).rejects.toThrow(ValidationError);
    }
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  it("a persona account that is deactivated → 404; the demo client whose portal was closed → the generic 401", async () => {
    await db.update(users).set({ isActive: false }).where(eq(users.id, ids.users.editor1));
    await expect(demoSignIn(db, { persona: "editor", ...META }, { env: {} })).rejects.toThrow(NotFoundError);

    await db.update(clients).set({ portalEnabled: false }).where(eq(clients.id, ids.clientId));
    const err = await demoSignIn(db, { persona: "client", ...META }, { env: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as Error).message).toBe("Incorrect email or password");
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });
});

describe("org isolation", () => {
  it("with a real studio beside the demo one, the buttons only ever open the demo studio", async () => {
    const real = await seedMinimalOrg(db, { slug: "real", emailDomain: "real.test" });
    for (const persona of DEMO_PERSONAS) {
      jar.clear();
      const result = await demoSignIn(db, { persona, ...META }, { env: {} });
      const ctx = await requireAnyContext();
      expect(ctx.organisationId, persona).toBe(ids.organisationId);
      expect(ctx.organisationId).not.toBe(real.organisationId);
      expect(result.user.id).toBe(ids.users[EXPECTED[persona].key]);
    }
    // Nobody in the real studio signed in.
    const realSignIns = (await signInEvents()).filter((e) => e.organisationId === real.organisationId);
    expect(realSignIns).toHaveLength(0);
  });
});

describe("signing out of the demo", () => {
  it("logout clears THIS browser only: the persona's session_version stays, other visitors stay signed in, the event says so", async () => {
    await demoSignIn(db, { persona: "owner", ...META }, { env: {} });
    const otherVisitor = jar.get(SESSION_COOKIE_NAME) ?? "";
    jar.clear();
    await demoSignIn(db, { persona: "owner", ip: "9.9.9.9" }, { env: {} });
    const before = await sessionVersion(ids.users.owner);

    await logout(await requireAnyContext(), { ip: "9.9.9.9", userAgent: "vitest" }, db);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(await sessionVersion(ids.users.owner)).toBe(before);

    jar.set(SESSION_COOKIE_NAME, otherVisitor);
    await expect(requireAnyContext()).resolves.toMatchObject({ userId: ids.users.owner, isDemo: true });

    const [event] = await db.select().from(activityEvents).where(and(eq(activityEvents.eventType, "auth.logged_out"), eq(activityEvents.entityId, ids.users.owner)));
    expect(event).toMatchObject({ actorUserId: ids.users.owner, visibility: "management", previousValue: null, newValue: null });
    expect(event.metadata).toMatchObject({ allSessionsRevoked: false, demo: true, ip: "9.9.9.9" });
  });

  it("outside the demo, logout still revokes every session of the account", async () => {
    const real = await seedMinimalOrg(db, { slug: "real", emailDomain: "real.test" });
    const before = await sessionVersion(real.users.editor1);
    await logout(await contextFor(db, real.users.editor1), {}, db);
    expect(await sessionVersion(real.users.editor1)).toBe((before ?? 1) + 1);
  });

  it("the banner's 'Create your own studio' (signOutAction → /signup) signs this browser out and lands on sign-up", async () => {
    await demoSignIn(db, { persona: "editor", ...META }, { env: {} });
    const otherVisitor = jar.get(SESSION_COOKIE_NAME) ?? "";
    const form = new FormData();
    form.set("next", "/signup");
    await expect(signOutAction(form)).rejects.toThrow(/NEXT_REDIRECT \/signup/);
    expect(redirects).toEqual(["/signup"]);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    // The same persona's other browsers are untouched.
    jar.set(SESSION_COOKIE_NAME, otherVisitor);
    await expect(requireAnyContext()).resolves.toMatchObject({ userId: ids.users.editor1 });
  });

  it("the sign-out action never lands anywhere but the allowlist", async () => {
    for (const [next, landing] of [
      ["https://evil.example/", "/login"],
      ["//evil.example", "/login"],
      ["/home", "/login"],
      ["/login?demo=1", "/login?demo=1"],
      ["/invite/abcDEF_123-x", "/invite/abcDEF_123-x"],
    ] as const) {
      redirects.length = 0;
      const form = new FormData();
      form.set("next", next);
      await expect(signOutAction(form)).rejects.toThrow(/NEXT_REDIRECT/);
      expect(redirects, next).toEqual([landing]);
    }
  });
});

describe("POST /api/auth/demo", () => {
  const call = async (body: unknown, method = "POST") => {
    const init: RequestInit = { method, headers: { origin: "http://localhost:3130", "content-type": "application/json" } };
    if (method === "POST") init.body = JSON.stringify(body);
    const handler = method === "POST" ? demoRoute.POST : demoRoute.GET;
    const res = await handler(new Request("http://localhost:3130/api/auth/demo", init), { params: Promise.resolve({}) } as never);
    return { status: res.status, json: (await res.json()) as { data?: { redirectTo: string; user: { role: string } }; error?: { code: string; message: string } } };
  };

  it("signs in and answers the landing page; other methods are a JSON 405", async () => {
    const res = await call({ persona: "client" });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ redirectTo: "/portal", user: { role: "client" } });
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(true);
    expect((await call(null, "GET")).status).toBe(405);
  });

  it("answers 404 when demo sign-in is turned off", async () => {
    vi.stubEnv("DEMO_SIGN_IN", "off");
    try {
      const res = await call({ persona: "owner" });
      expect(res.status).toBe(404);
      expect(res.json.error).toMatchObject({ code: "not_found", message: DEMO_OFF_MESSAGE });
      expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a cross-site POST (CSRF)", async () => {
    const res = await demoRoute.POST(
      new Request("http://localhost:3130/api/auth/demo", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ persona: "owner" }) }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(403);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });
});
