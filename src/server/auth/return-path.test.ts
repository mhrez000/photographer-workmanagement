/** Where "Sign out" from a public page may land (src/server/auth/return-path.ts): an allowlist, no open redirects. */
import { describe, expect, it } from "vitest";
import { SIGN_OUT_FALLBACK, signOutReturnPath } from "./return-path";

describe("signOutReturnPath", () => {
  it("keeps the front-door pages it is meant for", () => {
    expect(signOutReturnPath("/login")).toBe("/login");
    expect(signOutReturnPath("/login?demo=1")).toBe("/login?demo=1");
    expect(signOutReturnPath("/signup")).toBe("/signup");
    expect(signOutReturnPath("/invite/abc_DEF-123")).toBe("/invite/abc_DEF-123");
    expect(signOutReturnPath("/invite/abc%20")).toBe("/invite/abc%20");
  });

  it("drops anything else on the page path (extra query, other params)", () => {
    expect(signOutReturnPath("/login?next=https://evil.example")).toBe("/login");
    expect(signOutReturnPath("/login?demo=yes")).toBe("/login");
    expect(signOutReturnPath("/signup?website=x")).toBe("/signup");
    expect(signOutReturnPath("/invite/abc?x=1")).toBe("/invite/abc");
    // Odd characters stay percent-encoded on the same site (the invite page then shows its dead-link card).
    expect(signOutReturnPath("/invite/<script>")).toBe("/invite/%3Cscript%3E");
  });

  it("everything else goes to /login: other pages, other sites, tricks, non-strings", () => {
    for (const next of [
      "/home",
      "/settings/account",
      "/invite/",
      "/invite/a/b",
      "https://evil.example/login",
      "//evil.example/login",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "login",
      "",
      null,
      undefined,
      42,
      ["/signup"],
    ]) {
      expect(signOutReturnPath(next), String(next)).toBe(SIGN_OUT_FALLBACK);
    }
    expect(SIGN_OUT_FALLBACK).toBe("/login");
  });
});
