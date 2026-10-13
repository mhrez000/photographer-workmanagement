import { request } from "@playwright/test";
import { BASE_URL, NO_SESSION, uniq } from "./api";
import { expect, test } from "./fixtures";

/**
 * Every `/api` response is JSON. Unknown paths are a JSON 404 (never the HTML not-found page), a
 * method a route does not implement is a JSON 405 with an `Allow` header (never Next's empty 405),
 * anonymous callers get a JSON 401, and the strict schemas of the simplified actions reject unknown
 * keys with a 400 (plan: no screen can smuggle a status id, a priority or a sharing flag through them).
 */

test("unknown /api paths (including bare /api) return a JSON 404 for signed-in callers", async ({ api }) => {
  for (const [method, path] of [
    ["GET", "/api"],
    ["POST", "/api"],
    ["GET", "/api/e2e-reg-does-not-exist"],
    ["GET", "/api/jobs/e2e-reg/not-a-sub-route/deeper"],
    ["POST", "/api/e2e-reg-does-not-exist"],
    ["PATCH", "/api/e2e-reg-does-not-exist/x"],
  ] as const) {
    const res = await api.raw(method, path, method === "GET" ? undefined : {});
    expect(res.status, `${method} ${path}`).toBe(404);
    expect(res.headers["content-type"], `${method} ${path}`).toContain("application/json");
    expect(res.error?.code, `${method} ${path}`).toBe("not_found");
    expect(res.error?.message).toEqual(expect.any(String));
  }
});

test("a method a route does not implement is a JSON 405 naming the allowed methods", async ({ api }) => {
  const job = await api.createJob({ name: uniq("Reg 405") });
  for (const [method, path, allow] of [
    ["DELETE", `/api/jobs/${job.id}`, "GET, PATCH"],
    ["PUT", `/api/jobs/${job.id}`, "GET, PATCH"],
    ["DELETE", "/api/activity", "GET"],
    ["POST", "/api/activity", "GET"],
    ["PATCH", "/api/jobs", "GET, POST"],
    ["DELETE", "/api/notifications", "GET"],
    ["GET", "/api/auth/login", "POST"],
  ] as const) {
    const res = await api.raw(method, path, method === "GET" ? undefined : {});
    expect(res.status, `${method} ${path}`).toBe(405);
    expect(res.headers["content-type"], `${method} ${path}`).toContain("application/json");
    expect(res.headers.allow, `${method} ${path}`).toBe(allow);
    expect(res.error?.code, `${method} ${path}`).toBe("method_not_allowed");
  }
  // Nothing was deleted.
  expect((await api.job(job.id)).job.id).toBe(job.id);
});

test("unknown /api paths are a JSON 401 without a session", async () => {
  const anon = await request.newContext({ baseURL: BASE_URL, storageState: NO_SESSION });
  for (const path of ["/api", "/api/e2e-reg-does-not-exist", "/api/jobs", "/api/settings"]) {
    const res = await anon.get(path);
    expect(res.status(), `${path} → ${await res.text()}`).toBe(401);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  }
  await anon.dispose();
});

test("non-GET requests without a matching Origin are refused (CSRF), with a JSON 403", async () => {
  const ctx = await request.newContext({ baseURL: BASE_URL, storageState: NO_SESSION });
  const login = await ctx.post("/api/auth/login", { data: { email: "owner@studio.test", password: "Password123!" }, headers: { Origin: "https://evil.example" } });
  expect([403, 401]).toContain(login.status());
  expect(login.headers()["content-type"]).toContain("application/json");
  await ctx.dispose();
});

test("strict inputs: the simplified job actions reject unknown keys and sharing flags with a 400", async ({ api }) => {
  const job = await api.createJob({ name: uniq("Reg strict") });
  const v = await api.version(job.id);
  // Sharing columns are written only by the share routes; every generic schema rejects them.
  for (const [url, body] of [
    [`/api/jobs/${job.id}`, { expectedVersion: v, sharedWithClient: true }],
    ["/api/jobs", { name: uniq("Reg smuggle"), autoProject: { clientId: job.client?.id, address: "1 Smuggle St" }, jobTypeId: await api.jobTypeId(), sharedWithClient: true }],
    [`/api/jobs/${job.id}`, { expectedVersion: v, statusId: "abc" }],
  ] as const) {
    const res = await api.raw(url === "/api/jobs" ? "POST" : "PATCH", url, body);
    expect(res.status, `${url} ${JSON.stringify(body)}`).toBe(400);
    expect(res.error?.code, url).toBe("validation");
  }
  expect((await api.job(job.id)).job.version).toBe(v);
});
