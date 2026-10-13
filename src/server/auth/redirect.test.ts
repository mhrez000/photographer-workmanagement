/**
 * Post-login landing (docs/SIMPLIFICATION-PLAN.md §3): owners / photographers → /home, editors → /my-jobs,
 * clients → /portal; never /dashboard; `next` only when it is a safe same-site path for that persona.
 */
import { describe, expect, it } from "vitest";
import { loginRedirectTarget } from "./redirect";

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
