import { request } from "@playwright/test";
import { BASE_URL, NO_SESSION, uniq } from "./api";
import { expect, test } from "./fixtures";

/**
 * Regression (audit batch A + skeptic re-check): every `/api` response is
 * JSON. Unknown paths are a JSON 404 (never the HTML not-found page), a
 * method a route does not implement is a JSON 405 with an `Allow` header
 * (never Next's empty 405), and anonymous callers get a JSON 401.
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
    ["POST", "/api/dashboard", "GET"],
    ["DELETE", "/api/me/work", "GET"],
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
  for (const path of ["/api", "/api/e2e-reg-does-not-exist"]) {
    const res = await anon.get(path);
    expect(res.status(), `${path} → ${await res.text()}`).toBe(401);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  }
  await anon.dispose();
});

test("reports are also served at the query-string form /api/reports?type=", async ({ api }) => {
  const viaQuery = await api.raw<{ kind: string; range: { preset: string } }>("GET", "/api/reports?type=editors&range=this_month");
  expect(viaQuery.status).toBe(200);
  expect(viaQuery.data.kind).toBe("editors");
  expect(viaQuery.data.range.preset).toBe("this_month");
  expect((await api.raw("GET", "/api/reports?type=nope")).status).toBe(404);
  const csv = await api.raw("GET", "/api/reports?type=production&range=this_week&format=csv");
  expect(csv.status).toBe(200);
  expect(csv.headers["content-type"]).toContain("text/csv");
});
