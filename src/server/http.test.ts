import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIp, isSameOrigin, trustedProxyCount } from "./http";

afterEach(() => vi.unstubAllEnvs());

describe("trustedProxyCount", () => {
  it("defaults to 0 and only accepts a non-negative integer", () => {
    expect(trustedProxyCount({})).toBe(0);
    expect(trustedProxyCount({ TRUSTED_PROXY_COUNT: "" })).toBe(0);
    expect(trustedProxyCount({ TRUSTED_PROXY_COUNT: "abc" })).toBe(0);
    expect(trustedProxyCount({ TRUSTED_PROXY_COUNT: "-1" })).toBe(0);
    expect(trustedProxyCount({ TRUSTED_PROXY_COUNT: "2" })).toBe(2);
  });
});

describe("clientIp", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("ignores X-Forwarded-For / X-Real-IP by default (client-controlled)", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "");
    expect(clientIp(h({ "x-forwarded-for": "10.0.0.1" }))).toBeNull();
    expect(clientIp(h({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" }))).toBeNull();
    expect(clientIp(h({ "x-real-ip": "10.0.0.9" }))).toBeNull();
    // rotating XFF therefore never changes the limiter bucket
    expect(clientIp(h({ "x-forwarded-for": "10.0.0.3" }))).toBe(clientIp(h({ "x-forwarded-for": "10.0.0.4" })));
  });

  it("with TRUSTED_PROXY_COUNT = n takes the hop at index len - n (spoofed left-hand hops are ignored)", () => {
    // one proxy appends the real peer: "<spoofed>, <real>"
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }), 1)).toBe("203.0.113.7");
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7" }), 1)).toBe("203.0.113.7");
    // two proxies: "<spoofed>, <client>, <proxy1>"
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.2" }), 2)).toBe("203.0.113.7");
    // fewer hops than proxies → the leftmost hop available
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7" }), 3)).toBe("203.0.113.7");
    // no XFF → X-Real-IP set by the proxy
    expect(clientIp(h({ "x-real-ip": "198.51.100.1" }), 1)).toBe("198.51.100.1");
  });

  it("reads TRUSTED_PROXY_COUNT from the environment", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }))).toBe("203.0.113.7");
  });
});

describe("isSameOrigin (CSRF)", () => {
  const post = (headers: Record<string, string>, method = "POST") =>
    new Request("http://localhost:3130/api/clients", { method, headers });

  it("passes safe methods and a same-host Origin", () => {
    expect(isSameOrigin(post({ host: "evil.com" }, "GET"), { appOrigin: null, trustedProxies: 0 })).toBe(true);
    expect(isSameOrigin(post({ host: "localhost:3130", origin: "http://localhost:3130" }), { appOrigin: null, trustedProxies: 0 })).toBe(true);
  });

  it("rejects a missing, opaque or foreign Origin", () => {
    expect(isSameOrigin(post({ host: "localhost:3130" }), { appOrigin: null, trustedProxies: 0 })).toBe(false);
    expect(isSameOrigin(post({ host: "localhost:3130", origin: "null" }), { appOrigin: null, trustedProxies: 0 })).toBe(false);
    expect(isSameOrigin(post({ host: "localhost:3130", origin: "http://evil.com" }), { appOrigin: null, trustedProxies: 0 })).toBe(false);
  });

  it("by default ignores X-Forwarded-Host: a foreign Origin plus a matching X-Forwarded-Host is rejected", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "");
    vi.stubEnv("APP_ORIGIN", "");
    const forged = post({ host: "localhost:3130", origin: "http://evil.com", "x-forwarded-host": "evil.com" });
    expect(isSameOrigin(forged)).toBe(false);
    expect(isSameOrigin(forged, { appOrigin: null, trustedProxies: 0 })).toBe(false);
    // …and a legit request with a junk X-Forwarded-Host still passes on Host
    expect(isSameOrigin(post({ host: "localhost:3130", origin: "http://localhost:3130", "x-forwarded-host": "evil.com" }))).toBe(true);
  });

  it("honours X-Forwarded-Host only behind trusted proxies", () => {
    const proxied = post({ host: "app:3000", origin: "https://studio.example", "x-forwarded-host": "studio.example" });
    expect(isSameOrigin(proxied, { appOrigin: null, trustedProxies: 0 })).toBe(false);
    expect(isSameOrigin(proxied, { appOrigin: null, trustedProxies: 1 })).toBe(true);
  });

  it("with APP_ORIGIN configured, Origin must equal it exactly (scheme + host), whatever Host says", () => {
    const opts = { appOrigin: "https://studio.example", trustedProxies: 0 };
    expect(isSameOrigin(post({ host: "app:3000", origin: "https://studio.example" }), opts)).toBe(true);
    expect(isSameOrigin(post({ host: "app:3000", origin: "http://studio.example" }), opts)).toBe(false);
    expect(isSameOrigin(post({ host: "evil.com", origin: "https://evil.com" }), opts)).toBe(false);
    vi.stubEnv("APP_ORIGIN", "https://studio.example");
    expect(isSameOrigin(post({ host: "evil.com", origin: "https://evil.com", "x-forwarded-host": "evil.com" }))).toBe(false);
    expect(isSameOrigin(post({ host: "app:3000", origin: "https://studio.example" }))).toBe(true);
  });
});
