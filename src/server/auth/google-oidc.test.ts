/**
 * "Continue with Google" — the protocol half (src/server/auth/google-oidc.ts): PKCE, the authorize URL, the code
 * exchange and every id_token check, against a local RSA key pair and a fake token endpoint. No network.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { GOOGLE_OIDC } from "./google-config";
import {
  GoogleOidcError,
  buildAuthorizeUrl,
  completeGoogleCodeFlow,
  exchangeCode,
  googleIsAuthoritative,
  newFlowSecrets,
  pkceChallenge,
  randomUrlToken,
  sameSecret,
  verifyIdToken,
  type FetchLike,
} from "./google-oidc";

const CONFIG = { clientId: "client-123.apps.googleusercontent.com", clientSecret: "shh-secret" };
const NOW = new Date("2026-10-08T00:00:00.000Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const NONCE = "nonce-abcdefghijklmnopqrstuvwxyz0123456789";
const clock = () => NOW;

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] });
});

interface TokenOptions {
  key?: CryptoKey;
  kid?: string;
  iss?: string;
  aud?: string | string[];
  iat?: number;
  exp?: number | null;
}

async function idToken(claims: Record<string, unknown> = {}, opts: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({ sub: "google-sub-1", email: "Mo@Gmail.com", email_verified: true, nonce: NONCE, name: " Mo Carter ", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "k1" })
    .setIssuer(opts.iss ?? "https://accounts.google.com")
    .setAudience(opts.aud ?? CONFIG.clientId)
    .setIssuedAt(opts.iat ?? NOW_S - 10);
  if (opts.exp !== null) jwt.setExpirationTime(opts.exp ?? NOW_S + 3600);
  return jwt.sign(opts.key ?? privateKey);
}

const verify = (token: string, nonce = NONCE) => verifyIdToken(token, { clientId: CONFIG.clientId, nonce }, { jwks, now: clock });

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof GoogleOidcError) return err.reason;
    throw err;
  }
  throw new Error("expected a GoogleOidcError");
}

describe("PKCE + random values", () => {
  it("S256 = unpadded base64url of the verifier's SHA-256 (checked with WebCrypto)", async () => {
    const verifier = "dBjftJeZ4CVP-mJ92K9hTnNGvNYXVvKe9ScsgXoTfTU";
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = pkceChallenge(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Uint8Array(Buffer.from(challenge, "base64url"))).toEqual(digest);
  });

  it("flow secrets are 43-character base64url values, fresh every time", () => {
    const a = newFlowSecrets();
    const b = newFlowSecrets();
    for (const value of [a.state, a.nonce, a.verifier]) expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([a.state, a.nonce, a.verifier, b.state, b.nonce, b.verifier]).size).toBe(6);
    expect(randomUrlToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("sameSecret is exact and refuses empty / missing values", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abd")).toBe(false);
    expect(sameSecret("abc", "abcd")).toBe(false);
    expect(sameSecret("", "")).toBe(false);
    expect(sameSecret(null, "abc")).toBe(false);
    expect(sameSecret("abc", undefined)).toBe(false);
  });
});

describe("buildAuthorizeUrl", () => {
  it("asks for the code flow with PKCE S256, nonce, openid email profile and the account chooser", () => {
    const verifier = "dBjftJeZ4CVP-mJ92K9hTnNGvNYXVvKe9ScsgXoTfTU";
    const url = new URL(buildAuthorizeUrl({ clientId: CONFIG.clientId, redirectUri: "http://localhost:3130/api/auth/google/callback", state: "st", nonce: "nn", codeVerifier: verifier }));
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_OIDC.authorizeUrl);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CONFIG.clientId,
      redirect_uri: "http://localhost:3130/api/auth/google/callback",
      response_type: "code",
      scope: "openid email profile",
      state: "st",
      nonce: "nn",
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    // The verifier itself never travels in the URL.
    expect(url.toString()).not.toContain("dBjftJeZ4CVP");
  });

  it("adds login_hint only when given", () => {
    const url = new URL(buildAuthorizeUrl({ clientId: "c", redirectUri: "http://x/cb", state: "s", nonce: "n", codeVerifier: "v".repeat(43), loginHint: "sam@studio.test" }));
    expect(url.searchParams.get("login_hint")).toBe("sam@studio.test");
  });
});

describe("exchangeCode", () => {
  const input = { code: "4/0Acode", codeVerifier: "verifier-xyz", redirectUri: "http://localhost:3130/api/auth/google/callback" };

  it("POSTs code + verifier + secret to Google's token endpoint and returns the id_token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return Response.json({ id_token: "the.id.token", access_token: "ya29", token_type: "Bearer" });
    };
    await expect(exchangeCode(CONFIG, input, { fetch: fetcher })).resolves.toBe("the.id.token");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(GOOGLE_OIDC.tokenUrl);
    expect(calls[0].init?.method).toBe("POST");
    expect(new Headers(calls[0].init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init?.body)))).toEqual({
      grant_type: "authorization_code",
      code: "4/0Acode",
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
      redirect_uri: input.redirectUri,
      code_verifier: "verifier-xyz",
    });
  });

  it("any failure is exchange_failed: an error answer, a network error, bad JSON, no id_token", async () => {
    const cases: FetchLike[] = [
      async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => new Response("<html>oops</html>", { status: 200 }),
      async () => Response.json({ access_token: "ya29" }),
      async () => Response.json({ id_token: "" }),
    ];
    for (const fetcher of cases) expect(await reason(exchangeCode(CONFIG, input, { fetch: fetcher }))).toBe("exchange_failed");
  });
});

describe("verifyIdToken", () => {
  it("accepts a good token: lower-cased email, trimmed name, no hosted domain", async () => {
    await expect(verify(await idToken())).resolves.toEqual({ sub: "google-sub-1", email: "mo@gmail.com", emailVerified: true, name: "Mo Carter", hostedDomain: null });
  });

  it("accepts the bare issuer too, joins given + family names, keeps the Workspace domain", async () => {
    const token = await idToken({ name: undefined, given_name: "Sam", family_name: "Whitfield", hd: "Studio.Test", email: "sam@studio.test" }, { iss: "accounts.google.com" });
    await expect(verify(token)).resolves.toMatchObject({ name: "Sam Whitfield", hostedDomain: "studio.test", email: "sam@studio.test" });
  });

  it("refuses the wrong audience, issuer, signing key, kid or algorithm", async () => {
    expect(await reason(verify(await idToken({}, { aud: "someone-else.apps.googleusercontent.com" })))).toBe("invalid_token");
    expect(await reason(verify(await idToken({}, { iss: "https://evil.example.com" })))).toBe("invalid_token");
    expect(await reason(verify(await idToken({}, { key: otherKey })))).toBe("invalid_token");
    expect(await reason(verify(await idToken({}, { kid: "unknown-kid" })))).toBe("invalid_token");
    const hs256 = await new SignJWT({ sub: "x", email: "a@gmail.com", email_verified: true, nonce: NONCE })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://accounts.google.com")
      .setAudience(CONFIG.clientId)
      .setIssuedAt(NOW_S)
      .setExpirationTime(NOW_S + 60)
      .sign(new TextEncoder().encode("a-shared-secret-that-is-long-enough!!"));
    expect(await reason(verify(hs256))).toBe("invalid_token");
    expect(await reason(verify("not-a-jwt"))).toBe("invalid_token");
  });

  it("refuses an expired token, one issued in the future or too long ago, and one without exp", async () => {
    expect(await reason(verify(await idToken({}, { iat: NOW_S - 7200, exp: NOW_S - 3600 })))).toBe("invalid_token");
    expect(await reason(verify(await idToken({}, { iat: NOW_S - 7200, exp: NOW_S + 3600 })))).toBe("invalid_token");
    expect(await reason(verify(await idToken({}, { iat: NOW_S + 3600, exp: NOW_S + 7200 })))).toBe("invalid_token");
    expect(await reason(verify(await idToken({}, { exp: null })))).toBe("invalid_token");
    // Inside the 60-second skew allowance: fine.
    await expect(verify(await idToken({}, { iat: NOW_S - 3600, exp: NOW_S - 30 }))).resolves.toMatchObject({ sub: "google-sub-1" });
  });

  it("refuses a wrong or missing nonce (replayed / injected token)", async () => {
    expect(await reason(verify(await idToken(), "a-different-nonce"))).toBe("invalid_token");
    expect(await reason(verify(await idToken({ nonce: undefined })))).toBe("invalid_token");
  });

  it("refuses a token without sub or email", async () => {
    expect(await reason(verify(await idToken({ sub: undefined })))).toBe("invalid_token");
    expect(await reason(verify(await idToken({ email: undefined })))).toBe("invalid_token");
    expect(await reason(verify(await idToken({ email: "not-an-address" })))).toBe("invalid_token");
  });

  it("several audiences: azp must be us", async () => {
    expect(await reason(verify(await idToken({ azp: "someone-else" }, { aud: [CONFIG.clientId, "someone-else"] })))).toBe("invalid_token");
    await expect(verify(await idToken({ azp: CONFIG.clientId }, { aud: [CONFIG.clientId, "someone-else"] }))).resolves.toMatchObject({ sub: "google-sub-1" });
  });

  it("an unverified email is its own refusal (never 'true' as a string)", async () => {
    expect(await reason(verify(await idToken({ email_verified: false })))).toBe("unverified_email");
    expect(await reason(verify(await idToken({ email_verified: "true" })))).toBe("unverified_email");
    expect(await reason(verify(await idToken({ email_verified: undefined })))).toBe("unverified_email");
  });
});

describe("completeGoogleCodeFlow", () => {
  it("exchanges then verifies against the round trip's nonce", async () => {
    const token = await idToken();
    const fetcher: FetchLike = async () => Response.json({ id_token: token });
    const input = { code: "c", codeVerifier: "v", redirectUri: "http://x/cb" };
    await expect(completeGoogleCodeFlow(CONFIG, { ...input, nonce: NONCE }, { fetch: fetcher, jwks, now: clock })).resolves.toMatchObject({ email: "mo@gmail.com" });
    expect(await reason(completeGoogleCodeFlow(CONFIG, { ...input, nonce: "other" }, { fetch: fetcher, jwks, now: clock }))).toBe("invalid_token");
  });
});

describe("googleIsAuthoritative", () => {
  it("Gmail and matching Workspace domains only", () => {
    expect(googleIsAuthoritative({ email: "mo@gmail.com", hostedDomain: null })).toBe(true);
    expect(googleIsAuthoritative({ email: "mo@googlemail.com", hostedDomain: null })).toBe(true);
    expect(googleIsAuthoritative({ email: "mo@studio.test", hostedDomain: "studio.test" })).toBe(true);
    expect(googleIsAuthoritative({ email: "mo@studio.test", hostedDomain: null })).toBe(false);
    expect(googleIsAuthoritative({ email: "mo@studio.test", hostedDomain: "other.test" })).toBe(false);
    expect(googleIsAuthoritative({ email: "mo@yahoo.com", hostedDomain: null })).toBe(false);
  });
});
