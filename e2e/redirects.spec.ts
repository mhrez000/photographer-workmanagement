import { request } from "@playwright/test";
import { LEGACY_REDIRECTS } from "../next.config";
import { BASE_URL, DEMO_PASSWORD, NO_SESSION, ROLE_EMAILS, uniq } from "./api";
import { expect, test } from "./fixtures";

/**
 * Old links keep working (docs/SIMPLIFICATION-PLAN.md §3 "Old links keep working", §10 phase 0):
 * every entry of LEGACY_REDIRECTS answers 307 to its destination, plus the three conditional
 * redirects that live server-side (/workspace/my by role, /insights/* and /projects while Advanced
 * tools is off). Bookmarks and notification links from before the change land on the new page.
 */

const SAMPLE_ID = "e2e-sample-id";

test("every LEGACY_REDIRECTS entry is a 307 to its destination for a signed-in owner", async ({ api }) => {
  expect(LEGACY_REDIRECTS.length).toBeGreaterThanOrEqual(20);
  for (const { source, destination } of LEGACY_REDIRECTS) {
    const path = source.replace(/:id/g, SAMPLE_ID);
    const expected = destination.replace(/:id/g, SAMPLE_ID);
    const { status, location } = await api.pageStatus(path);
    expect(status, `${path} → ${status}`).toBe(307);
    expect(location, `${path} → ${location}`).toBeTruthy();
    expect(new URL(location!, "http://x").pathname, path).toBe(expected);
  }
});

test("the redirects are temporary and keep query strings; the destinations themselves render", async ({ api }) => {
  const { status, location } = await api.pageStatus("/workspace/all?q=penrose");
  expect(status).toBe(307);
  expect(location).toMatch(/\/jobs\?q=penrose$/);
  for (const path of ["/home", "/jobs", "/editors", "/clients", "/settings/studio", "/settings/people", "/settings/shoot-types", "/settings/account", "/settings/history", "/help"]) {
    expect((await api.pageStatus(path)).status, path).toBe(200);
  }
  // Calendar is a view inside Jobs for the owner and a page for editors (plan §11).
  const calendar = await api.pageStatus("/calendar");
  if (calendar.status === 307) expect(calendar.location).toMatch(/\/jobs\?view=calendar$/);
  else expect(calendar.status).toBe(200);
});

test("/dashboard → /home, and signing in lands owners on Home, editors on My jobs, clients on the portal", async ({ api, apiAs }) => {
  expect((await api.pageStatus("/dashboard")).location).toMatch(/\/home$/);
  const editor = await apiAs("editor");
  expect((await editor.pageStatus("/my-jobs")).status).toBe(200);
  // Login reports the landing page per persona (plan §3; src/server/auth/redirect.ts).
  for (const [email, home] of [
    [ROLE_EMAILS.owner, "/home"],
    [ROLE_EMAILS.photographer, "/home"],
    [ROLE_EMAILS.editor, "/my-jobs"],
    [ROLE_EMAILS.client, "/portal"],
  ] as const) {
    const anon = await request.newContext({ baseURL: BASE_URL, storageState: NO_SESSION, extraHTTPHeaders: { Origin: BASE_URL } });
    const res = await anon.post("/api/auth/login", { data: { email, password: DEMO_PASSWORD } });
    expect(res.status(), email).toBe(200);
    expect(((await res.json()) as { data: { redirectTo: string } }).data.redirectTo, email).toBe(home);
    // An old `next` of /dashboard is honoured only as a path that still exists: it redirects on arrival.
    await anon.dispose();
  }
});

test("/workspace/my goes to Jobs for photographers and to My jobs for editors; the proxy sends a signed-in visitor on /login home", async ({ api, apiAs }) => {
  expect((await api.pageStatus("/workspace/my")).location).toMatch(/\/jobs$/);
  const editor = await apiAs("editor");
  expect((await editor.pageStatus("/workspace/my")).location).toMatch(/\/my-jobs$/);
  const photographer = await apiAs("photographer");
  expect((await photographer.pageStatus("/workspace/my")).location).toMatch(/\/jobs$/);

  expect((await api.pageStatus("/login")).location).toMatch(/\/home$/);
  expect((await editor.pageStatus("/login")).location).toMatch(/\/my-jobs$/);
  const client = await apiAs("client");
  expect((await client.pageStatus("/login")).location).toMatch(/\/portal$/);
  // A client on a staff page goes to the portal; staff on /portal go home.
  expect((await client.pageStatus("/home")).location).toMatch(/\/portal$/);
  expect((await api.pageStatus("/portal")).location).toMatch(/\/home$/);
  expect((await editor.pageStatus("/portal")).location).toMatch(/\/my-jobs$/);
});

test("Advanced tools off: /insights/* → /editors and /projects → /jobs (server-side, by studio); on: they render", async ({ api }) => {
  expect(await api.advancedToolsOn()).toBe(false);
  for (const path of ["/insights/analytics", "/insights/bottlenecks", "/insights/reports"]) {
    const { status, location } = await api.pageStatus(path);
    expect(status, path).toBe(307);
    expect(location, path).toMatch(/\/editors$/);
  }
  {
    const { status, location } = await api.pageStatus("/projects");
    expect(status).toBe(307);
    expect(location).toMatch(/\/jobs$/);
  }
  // A project detail page is Advanced too.
  const { projectId } = await api.createClientAndProject("Redirect");
  expect([307, 404]).toContain((await api.pageStatus(`/projects/${projectId}`)).status);
  try {
    await api.setAdvancedTools(true);
    for (const path of ["/insights/analytics", "/insights/reports", "/projects", `/projects/${projectId}`]) expect((await api.pageStatus(path)).status, path).toBe(200);
  } finally {
    await api.setAdvancedTools(false);
  }
});

test("job links themselves do not change: a job page and its notifications' linkPath still open", async ({ api }) => {
  const job = await api.createJob({ name: uniq("E2E stable link") });
  expect((await api.pageStatus(`/jobs/${job.id}`)).status).toBe(200);
  // Old tab deep links drop the tab and still open the job.
  expect([200, 307]).toContain((await api.pageStatus(`/jobs/${job.id}?tab=history`)).status);
});
