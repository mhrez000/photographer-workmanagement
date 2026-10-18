/** Public origin for links in emails / copyable invite links (front door). */
import { describe, expect, it } from "vitest";
import { appOrigin, configuredOrigin, inviteUrl, linkOriginStatus, originFromHeaders, passwordResetUrl } from "./origin";

const req = new Request("https://studio.example.com/api/users?x=1", { method: "POST", headers: { host: "evil.example.net" } });
const PROD = { NODE_ENV: "production" } as const;

describe("appOrigin in production", () => {
  it("prefers APP_URL (origin only, no path / trailing slash), then APP_ORIGIN, then the request origin, then localhost", () => {
    expect(appOrigin(req, { ...PROD, APP_URL: "https://app.proofline.example/some/path/" })).toBe("https://app.proofline.example");
    expect(appOrigin(req, { ...PROD, APP_ORIGIN: "https://origin.example" })).toBe("https://origin.example");
    expect(appOrigin(req, { ...PROD, APP_URL: "https://app.proofline.example", APP_ORIGIN: "https://origin.example" })).toBe("https://app.proofline.example");
    expect(appOrigin(req, PROD)).toBe("https://studio.example.com");
    expect(appOrigin(null, PROD)).toBe("http://localhost:3000");
    expect(appOrigin(undefined, PROD)).toBe("http://localhost:3000");
  });

  it("ignores an unusable APP_URL (blank, not a URL, not http(s)) and never reads forwarding headers", () => {
    expect(appOrigin(req, { ...PROD, APP_URL: "   " })).toBe("https://studio.example.com");
    expect(appOrigin(req, { ...PROD, APP_URL: "not a url" })).toBe("https://studio.example.com");
    expect(appOrigin(req, { ...PROD, APP_URL: "ftp://files.example.com" })).toBe("https://studio.example.com");
    expect(appOrigin(req, { ...PROD, APP_URL: "javascript:alert(1)" })).toBe("https://studio.example.com");
    const forwarded = new Request("http://localhost:3000/api/users", { method: "POST", headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" } });
    expect(appOrigin(forwarded, PROD)).toBe("http://localhost:3000");
    expect(appOrigin(forwarded, {})).toBe("http://localhost:3000");
  });
});

describe("appOrigin in development", () => {
  it("prefers the request origin over a (possibly stale) APP_URL, so copied links open on the server that made them", () => {
    const dev = new Request("http://localhost:3130/api/users", { method: "POST" });
    expect(appOrigin(dev, { APP_URL: "http://localhost:3000" })).toBe("http://localhost:3130");
    expect(appOrigin(dev, { NODE_ENV: "development", APP_URL: "http://localhost:3000" })).toBe("http://localhost:3130");
    expect(appOrigin(dev, { NODE_ENV: "test", APP_ORIGIN: "http://localhost:3000" })).toBe("http://localhost:3130");
    // The same stale APP_URL stays authoritative in production.
    expect(appOrigin(dev, { NODE_ENV: "production", APP_URL: "http://localhost:3000" })).toBe("http://localhost:3000");
  });

  it("falls back to APP_URL, then APP_ORIGIN, then localhost when there is no request (sitemap, robots, metadata)", () => {
    expect(appOrigin(null, { APP_URL: "http://localhost:3130/" })).toBe("http://localhost:3130");
    expect(appOrigin(null, { APP_ORIGIN: "http://localhost:3131" })).toBe("http://localhost:3131");
    expect(appOrigin(null, {})).toBe("http://localhost:3000");
  });
});

describe("linkOriginStatus / originFromHeaders", () => {
  it("reports a mismatch between APP_URL and the request origin, and which one links use", () => {
    const dev = linkOriginStatus("http://localhost:3130", { APP_URL: "http://localhost:3000" });
    expect(dev).toEqual({ linkOrigin: "http://localhost:3130", configured: "http://localhost:3000", requested: "http://localhost:3130", mismatch: true, production: false });
    const prod = linkOriginStatus("https://preview.example", { NODE_ENV: "production", APP_URL: "https://app.proofline.example" });
    expect(prod).toMatchObject({ linkOrigin: "https://app.proofline.example", mismatch: true, production: true });
    expect(linkOriginStatus("http://localhost:3130", { APP_URL: "http://localhost:3130" }).mismatch).toBe(false);
    expect(linkOriginStatus("http://localhost:3130", {})).toMatchObject({ linkOrigin: "http://localhost:3130", configured: null, mismatch: false });
    expect(linkOriginStatus(null, {})).toMatchObject({ linkOrigin: "http://localhost:3000", requested: null, mismatch: false });
    expect(configuredOrigin({ APP_URL: "nope" })).toBeNull();
  });

  it("originFromHeaders uses the host Next saw and x-forwarded-proto only for the scheme", () => {
    expect(originFromHeaders(new Headers({ host: "localhost:3130" }))).toBe("http://localhost:3130");
    expect(originFromHeaders(new Headers({ host: "app.proofline.example", "x-forwarded-proto": "https" }))).toBe("https://app.proofline.example");
    expect(originFromHeaders(new Headers({ host: "app.proofline.example", "x-forwarded-proto": "https, http" }))).toBe("https://app.proofline.example");
    expect(originFromHeaders(new Headers({}))).toBeNull();
    expect(originFromHeaders(new Headers({ host: "not a host" }))).toBeNull();
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
