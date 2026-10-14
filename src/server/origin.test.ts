/** Public origin for links in emails / copyable invite links (front door). */
import { describe, expect, it } from "vitest";
import { appOrigin, inviteUrl, passwordResetUrl } from "./origin";

const req = new Request("https://studio.example.com/api/users?x=1", { method: "POST", headers: { host: "evil.example.net" } });

describe("appOrigin", () => {
  it("prefers APP_URL (origin only, no path / trailing slash), then APP_ORIGIN, then the request origin, then localhost", () => {
    expect(appOrigin(req, { APP_URL: "https://app.proofline.example/some/path/" })).toBe("https://app.proofline.example");
    expect(appOrigin(req, { APP_ORIGIN: "https://origin.example" })).toBe("https://origin.example");
    expect(appOrigin(req, { APP_URL: "https://app.proofline.example", APP_ORIGIN: "https://origin.example" })).toBe("https://app.proofline.example");
    expect(appOrigin(req, {})).toBe("https://studio.example.com");
    expect(appOrigin(null, {})).toBe("http://localhost:3000");
    expect(appOrigin(undefined, {})).toBe("http://localhost:3000");
  });

  it("ignores an unusable APP_URL (blank, not a URL, not http(s)) and never reads forwarding headers", () => {
    expect(appOrigin(req, { APP_URL: "   " })).toBe("https://studio.example.com");
    expect(appOrigin(req, { APP_URL: "not a url" })).toBe("https://studio.example.com");
    expect(appOrigin(req, { APP_URL: "ftp://files.example.com" })).toBe("https://studio.example.com");
    expect(appOrigin(req, { APP_URL: "javascript:alert(1)" })).toBe("https://studio.example.com");
    const forwarded = new Request("http://localhost:3000/api/users", { method: "POST", headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" } });
    expect(appOrigin(forwarded, {})).toBe("http://localhost:3000");
  });
});

describe("link builders", () => {
  it("inviteUrl / passwordResetUrl put the URL-encoded token on the public pages", () => {
    const token = "abc_DEF-123";
    expect(inviteUrl(token, null).endsWith(`/invite/${token}`)).toBe(true);
    expect(passwordResetUrl(token, null).endsWith(`/reset-password?token=${token}`)).toBe(true);
    expect(new URL(inviteUrl("a/b c", req)).pathname).toBe("/invite/a%2Fb%20c");
    expect(new URL(passwordResetUrl("a&b=c", req)).searchParams.get("token")).toBe("a&b=c");
  });
});
