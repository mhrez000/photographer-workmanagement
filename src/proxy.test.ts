/**
 * The edge gate (src/proxy.ts): landing-page hints, routing for signed-in / signed-out visitors (docs/ACCOUNTS.md §1:
 * `/`, /login and /signup are never redirected for a signed-in person) and sliding sessions (§5: a verified cookie
 * older than a day is re-issued; a fresh, invalid or purpose token is left alone; never on POSTs, /api/auth/* or
 * `?expired`).
 */
import { SignJWT } from "jose";
import { NextRequest, type NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, SESSION_RENEW_AFTER_HOURS, SESSION_TTL_DAYS } from "@/lib/constants";
import { readSessionClaims, signPurposeToken, signSessionToken } from "@/server/auth/session-token";
import { CLIENT_HOME, EDITOR_HOME, MANGLED_INVITE_PATH, hasValidEncoding, landingFor, mayRenewSession, proxy, sessionHintOf, STAFF_HOME } from "./proxy";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unsigned = (claims: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;

const HOUR = 60 * 60;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const secret = () => new TextEncoder().encode(process.env.SESSION_SECRET ?? "");

/** A real, correctly signed session token issued `ageSeconds` ago (vitest sets SESSION_SECRET). */
async function sessionToken(ageSeconds: number, claims: { sub?: string; sv?: number; k?: "staff" | "client"; r?: string } = {}, key: Uint8Array = secret()): Promise<string> {
  const iat = nowSeconds() - ageSeconds;
  return new SignJWT({ sv: claims.sv ?? 3, k: claims.k ?? "staff", ...(claims.r ? { r: claims.r } : { r: "photographer" }) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.sub ?? "user-1")
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_TTL_DAYS * 24 * HOUR)
    .sign(key);
}

function request(path: string, opts: { token?: string; method?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.token) headers.set("cookie", `${SESSION_COOKIE_NAME}=${opts.token}`);
  return new NextRequest(new URL(path, "http://localhost:3130"), { method: opts.method ?? "GET", headers });
}

const isNext = (res: NextResponse) => res.headers.get("x-middleware-next") === "1";
const locationOf = (res: NextResponse) => {
  const raw = res.headers.get("location");
  return raw ? new URL(raw).pathname + new URL(raw).search : null;
};
const sessionCookieOf = (res: NextResponse) => res.cookies.get(SESSION_COOKIE_NAME);

describe("sessionHintOf / landingFor", () => {
  it("reads kind and role from the claims; missing or unreadable cookies count as a staff photographer", () => {
    expect(sessionHintOf(undefined)).toEqual({ kind: "staff", role: "photographer" });
    expect(sessionHintOf("not-a-jwt")).toEqual({ kind: "staff", role: "photographer" });
    expect(sessionHintOf(unsigned({ sub: "u", k: "client" }))).toEqual({ kind: "client", role: "client" });
    expect(sessionHintOf(unsigned({ sub: "u", k: "staff", r: "editor" }))).toEqual({ kind: "staff", role: "editor" });
    expect(sessionHintOf(unsigned({ sub: "u", k: "staff", r: "photographer" }))).toEqual({ kind: "staff", role: "photographer" });
    expect(sessionHintOf(unsigned({ sub: "u", k: "staff" }))).toEqual({ kind: "staff", role: "photographer" }); // pre-plan cookie without r
  });
  it("clients land on /portal, editors on /my-jobs, photographers on /home", () => {
    expect(landingFor({ kind: "client", role: "client" })).toBe(CLIENT_HOME);
    expect(landingFor({ kind: "staff", role: "editor" })).toBe(EDITOR_HOME);
    expect(landingFor({ kind: "staff", role: "photographer" })).toBe(STAFF_HOME);
    expect([CLIENT_HOME, EDITOR_HOME, STAFF_HOME]).toEqual(["/portal", "/my-jobs", "/home"]);
  });
});

describe("routing", () => {
  it("/ is public for everyone: no redirect for anonymous, staff or client visitors (no portal bounce)", async () => {
    const fresh = await sessionToken(60);
    const client = await sessionToken(60, { k: "client", r: "client" });
    for (const token of [undefined, fresh, client, unsigned({ sub: "u", k: "client" })]) {
      const res = await proxy(request("/", { token }));
      expect(isNext(res), String(token)).toBe(true);
      expect(locationOf(res)).toBeNull();
    }
  });

  it("/login and /signup render for signed-in people too (the pages show the signed-in notice), for every persona", async () => {
    for (const r of ["photographer", "editor"] as const) {
      const token = await sessionToken(60, { r });
      for (const path of ["/login", "/signup", "/login?demo=1", "/login?next=%2Fjobs"]) {
        const res = await proxy(request(path, { token }));
        expect(isNext(res), `${r} ${path}`).toBe(true);
        expect(sessionCookieOf(res), `${r} ${path}`).toBeUndefined();
      }
    }
    const client = await sessionToken(60, { k: "client", r: "client" });
    expect(isNext(await proxy(request("/login", { token: client })))).toBe(true);
  });

  it("?expired=1 on /login or /signup deletes the cookie (and never renews it)", async () => {
    const old = await sessionToken(3 * 24 * HOUR);
    for (const path of ["/login?expired=1", "/signup?expired=1"]) {
      const res = await proxy(request(path, { token: old }));
      expect(isNext(res)).toBe(true);
      const cookie = sessionCookieOf(res);
      expect(cookie?.value, path).toBe("");
    }
    // Without a cookie there is nothing to delete.
    expect(sessionCookieOf(await proxy(request("/login?expired=1")))).toBeUndefined();
  });

  it("signed out: app pages go to /login (with next, except Home), APIs answer a JSON 401, the front door stays public", async () => {
    expect(locationOf(await proxy(request("/jobs?stage=done")))).toBe(`/login?next=${encodeURIComponent("/jobs?stage=done")}`);
    expect(locationOf(await proxy(request("/home")))).toBe("/login");
    const api = await proxy(request("/api/jobs"));
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: { code: "unauthorized", message: "Sign in required" } });
    for (const path of ["/signup", "/forgot-password", "/reset-password?token=x", "/invite/abc", "/verify-email", "/change-email", "/signup/google", "/api/auth/demo"]) {
      expect(isNext(await proxy(request(path))), path).toBe(true);
    }
  });

  it("signed in: clients stay in the portal, staff stay out of it, /workspace/my goes by role", async () => {
    const client = await sessionToken(60, { k: "client", r: "client" });
    const editor = await sessionToken(60, { r: "editor" });
    const owner = await sessionToken(60);
    expect(locationOf(await proxy(request("/home", { token: client })))).toBe("/portal");
    expect(isNext(await proxy(request("/portal/jobs", { token: client })))).toBe(true);
    expect(locationOf(await proxy(request("/portal", { token: editor })))).toBe("/my-jobs");
    expect(locationOf(await proxy(request("/portal", { token: owner })))).toBe("/home");
    expect(locationOf(await proxy(request("/workspace/my", { token: editor })))).toBe("/my-jobs");
    expect(locationOf(await proxy(request("/workspace/my", { token: owner })))).toBe("/jobs");
    expect(isNext(await proxy(request("/api/jobs", { token: owner })))).toBe(true);
  });
});

describe("sliding sessions", () => {
  const OLD = (SESSION_RENEW_AFTER_HOURS + 1) * HOUR;

  it("re-issues a verified cookie older than a day: same person and version, fresh issue time, 30-day cookie", async () => {
    const old = await sessionToken(OLD, { sub: "user-42", sv: 7, r: "editor" });
    const res = await proxy(request("/my-jobs", { token: old }));
    expect(isNext(res)).toBe(true);
    const cookie = sessionCookieOf(res);
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.value).not.toBe(old);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_DAYS * 24 * HOUR });
    const claims = await readSessionClaims(cookie?.value);
    expect(claims).toMatchObject({ sub: "user-42", sv: 7, k: "staff", r: "editor" });
    expect(Math.abs((claims?.iat ?? 0) - nowSeconds())).toBeLessThan(5);
  });

  it("renews on every response kind: a page, a redirect, an API GET and the public landing page", async () => {
    const oldClient = await sessionToken(OLD, { k: "client", r: "client" });
    const redirect = await proxy(request("/home", { token: oldClient }));
    expect(locationOf(redirect)).toBe("/portal");
    expect(sessionCookieOf(redirect)?.value).toBeTruthy();

    const old = await sessionToken(OLD);
    for (const path of ["/api/jobs", "/", "/login", "/invite/abc"]) {
      expect(sessionCookieOf(await proxy(request(path, { token: old })))?.value, path).toBeTruthy();
    }
    // HEAD counts as a read.
    expect(sessionCookieOf(await proxy(request("/home", { token: old, method: "HEAD" })))?.value).toBeTruthy();
  });

  it("leaves a fresh cookie untouched (renewal happens at most once a day)", async () => {
    for (const age of [0, 60, (SESSION_RENEW_AFTER_HOURS - 1) * HOUR]) {
      const res = await proxy(request("/home", { token: await sessionToken(age) }));
      expect(isNext(res)).toBe(true);
      expect(sessionCookieOf(res), `age ${age}`).toBeUndefined();
    }
    // A token minted right now by the app itself.
    const minted = await signSessionToken({ sub: "user-1", sv: 1, k: "staff", r: "photographer" });
    expect(sessionCookieOf(await proxy(request("/jobs", { token: minted })))).toBeUndefined();
  });

  it("ignores an invalid cookie: wrong signature, garbage, expired, or a purpose token — routing still uses the hint", async () => {
    const forged = await sessionToken(OLD, {}, new TextEncoder().encode("another-secret-another-secret-another-secret"));
    const expired = await sessionToken((SESSION_TTL_DAYS * 24 + 1) * HOUR);
    const purpose = await signPurposeToken({ sub: "user-1", sv: 1 }, "google_oauth", 600);
    for (const token of [forged, "garbage", unsigned({ sub: "u", sv: 1, iat: 1 }), expired, purpose]) {
      const res = await proxy(request("/home", { token }));
      expect(isNext(res)).toBe(true);
      expect(sessionCookieOf(res)).toBeUndefined();
    }
    // An invalid client-looking cookie still routes by its (unverified) hint; nothing is set.
    const bounced = await proxy(request("/home", { token: unsigned({ sub: "u", k: "client" }) }));
    expect(locationOf(bounced)).toBe("/portal");
    expect(sessionCookieOf(bounced)).toBeUndefined();
  });

  it("never renews where a handler sets or clears the cookie itself: POST / PATCH / DELETE, /api/auth/*, ?expired", async () => {
    const old = await sessionToken(OLD);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      // Server actions post to page routes; mutations to the API.
      for (const path of ["/home", "/api/jobs", "/login"]) {
        const res = await proxy(request(path, { token: old, method }));
        expect(sessionCookieOf(res), `${method} ${path}`).toBeUndefined();
      }
    }
    for (const path of ["/api/auth/logout", "/api/auth/me", "/api/auth/google/callback?code=x", "/api/auth/demo"]) {
      expect(sessionCookieOf(await proxy(request(path, { token: old }))), path).toBeUndefined();
    }
    expect(sessionCookieOf(await proxy(request("/login?expired=1", { token: old })))?.value).toBe("");
  });

  it("mayRenewSession: reads only, never auth endpoints or framework paths", () => {
    expect(mayRenewSession(request("/home"))).toBe(true);
    expect(mayRenewSession(request("/api/jobs"))).toBe(true);
    expect(mayRenewSession(request("/home", { method: "POST" }))).toBe(false);
    expect(mayRenewSession(request("/api/auth/login"))).toBe(false);
    expect(mayRenewSession(request("/_next/webpack-hmr"))).toBe(false);
    expect(mayRenewSession(request("/robots.txt"))).toBe(false);
    expect(mayRenewSession(request("/signup?expired=1"))).toBe(false);
  });
});

describe("the sign-in time (SEC-03)", () => {
  it("a renewal keeps when this browser really signed in (it is not a new sign-in)", async () => {
    const signedInAt = nowSeconds() - 3 * 24 * HOUR;
    const token = await signSessionToken({ sub: "user-at", sv: 2, k: "staff", r: "photographer", at: signedInAt });
    const claims = await readSessionClaims(token);
    expect(claims?.at).toBe(signedInAt);
    // An old token (issued 2 days ago) with that sign-in time: renewed, `at` carried over.
    const old = await new SignJWT({ sv: 2, k: "staff", r: "photographer", at: signedInAt })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject("user-at")
      .setIssuedAt(nowSeconds() - 2 * 24 * HOUR)
      .setExpirationTime(nowSeconds() + 28 * 24 * HOUR)
      .sign(secret());
    const res = await proxy(request("/home", { token: old }));
    const renewed = sessionCookieOf(res)?.value;
    expect(renewed).toBeTruthy();
    expect((await readSessionClaims(renewed))?.at).toBe(signedInAt);
  });
});

describe("security headers (DEMO-06)", () => {
  it("every kind of response says: never framed by another site, no MIME sniffing, origin-only Referer elsewhere", async () => {
    const token = await sessionToken(60);
    const responses = [
      await proxy(request("/login")),
      await proxy(request("/settings/account", { token })),
      await proxy(request("/jobs")), // signed out → redirect
      await proxy(request("/api/jobs")), // signed out → JSON 401
      await proxy(request("/invite/abc")),
      await proxy(request("/", { token })),
    ];
    for (const res of responses) {
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    }
  });
});

describe("mangled addresses (DEMO-08)", () => {
  it("broken percent-encoding never reaches a route: the API answers a plain 400, an invite page the dead-link card", async () => {
    expect(hasValidEncoding("/invite/%E0%A4%A")).toBe(false);
    expect(hasValidEncoding("/invite/abc%20")).toBe(true);
    const page = await proxy(request("/invite/%E0%A4%A"));
    expect(locationOf(page)).toBe(MANGLED_INVITE_PATH);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    for (const path of ["/api/auth/invite/%E0%A4%A", "/api/auth/invite/%E0%A4%A/accept"]) {
      const api = await proxy(request(path, { method: path.endsWith("accept") ? "POST" : "GET" }));
      expect(api.status, path).toBe(400);
      expect(await api.json()).toEqual({ error: { code: "validation", message: "This address is not valid" } });
    }
    // A well-formed invite address is routed as usual (public).
    expect(isNext(await proxy(request("/invite/abc123")))).toBe(true);
  });
});
