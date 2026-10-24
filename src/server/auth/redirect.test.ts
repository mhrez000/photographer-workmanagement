/**
 * Post-login landing (docs/SIMPLIFICATION-PLAN.md §3): owners / photographers → /home, editors → /my-jobs,
 * clients → /portal; never /dashboard; `next` only when it is a safe same-site path for that persona.
 */
import { describe, expect, it } from "vitest";
import { loginRedirectTarget, safeNextPath } from "./redirect";

/** Where a browser would really go if it followed `location` from a page on https://app.example. */
function browserTarget(location: string): string {
  return new URL(location, "https://app.example/login").origin;
}

describe("safeNextPath (SEC-02: no open redirect through characters browsers drop or rewrite)", () => {
  it("refuses a TAB / CR / LF / NUL / DEL or a backslash anywhere — browsers turn '/\\t/evil' into '//evil'", () => {
    for (const bad of [
      "/\t/evil.example/phish",
      "/\n/evil.example",
      "/\r/evil.example",
      "/\r\n/evil.example",
      "/\u0000/evil.example",
      "/\u007f/evil.example",
      "/\\evil.example",
      "/\\/evil.example",
      "/jobs\\..\\..\\evil",
      "/jobs/\t",
      "\t//evil.example",
      " //evil.example",
      // Dot segments that normalise into a protocol-relative "//evil.example" (final-verifier finding).
      "/.//evil.example/phish",
      "/a/..//evil.example",
      "/..//evil.example",
      "/%2e//evil.example",
      "/%2E%2E//evil.example",
      "/jobs/.././/evil.example?x=1",
    ]) {
      expect(safeNextPath(bad), JSON.stringify(bad)).toBeNull();
      expect(loginRedirectTarget("photographer", bad), JSON.stringify(bad)).toBe("/home");
    }
  });

  it("every accepted value stays on this site when a browser resolves it", () => {
    const inputs = ["/jobs?x=1", "/jobs/abc#history", "/./jobs", "/a/../jobs", "/%09/evil.example", "/jobs?next=//evil.example", "/ünicode"];
    for (const input of inputs) {
      const safe = safeNextPath(input);
      expect(safe, input).not.toBeNull();
      expect(browserTarget(safe ?? ""), input).toBe("https://app.example");
    }
    expect(safeNextPath("/a/../jobs")).toBe("/jobs");
  });

  it("never the sign-in page, however it is spelled", () => {
    for (const bad of ["/login", "/login?next=/x", "/./login", "/jobs/../login?x=1"]) expect(safeNextPath(bad), bad).toBeNull();
  });

  it("rejects absurdly long values and non-strings", () => {
    expect(safeNextPath(`/${"a".repeat(3000)}`)).toBeNull();
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath(["/jobs"])).toBeNull();
  });
});

describe("loginRedirectTarget", () => {
  it("lands each role on its home page", () => {
    expect(loginRedirectTarget("photographer", undefined)).toBe("/home");
    expect(loginRedirectTarget("editor", undefined)).toBe("/my-jobs");
    expect(loginRedirectTarget("client", undefined)).toBe("/portal");
  });

  it("never answers /dashboard (the old home) and never an open redirect", () => {
    expect(loginRedirectTarget("photographer", "/dashboard")).toBe("/home");
    expect(loginRedirectTarget("editor", "/dashboard")).toBe("/my-jobs");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "/login?x=1", 42, null]) {
      expect(loginRedirectTarget("photographer", bad)).toBe("/home");
    }
  });

  it("honours a safe `next` for staff, and only portal paths for clients", () => {
    expect(loginRedirectTarget("photographer", "/jobs/abc?tab=history")).toBe("/jobs/abc?tab=history");
    expect(loginRedirectTarget("editor", "/calendar")).toBe("/calendar");
    expect(loginRedirectTarget("editor", "/portal/notifications")).toBe("/my-jobs");
    expect(loginRedirectTarget("client", "/portal/notifications")).toBe("/portal/notifications");
    expect(loginRedirectTarget("client", "/jobs")).toBe("/portal");
  });
});
