/**
 * "Continue with Google" — the OpenID Connect half (docs/ACCOUNTS.md §8 B, contract docs/ACCOUNTS-PLAN.md §4 AREA
 * google). Pure protocol: no database, no cookies. `src/server/services/googleAuth.ts` decides what a verified
 * Google identity means for Proofline.
 *
 *   newFlowSecrets()              state + nonce + PKCE verifier for one round trip (32 random bytes each)
 *   buildAuthorizeUrl(…)          https://accounts.google.com/o/oauth2/v2/auth?… (code flow, PKCE S256, nonce,
 *                                 scope "openid email profile", prompt=select_account)
 *   exchangeCode(…)               POST the code + verifier + client secret to Google's token endpoint → id_token
 *   verifyIdToken(…)              jose `jwtVerify` against Google's JWKS: RS256, iss ∈ GOOGLE_OIDC.issuers,
 *                                 aud = our client id, our nonce, exp / iat present and valid; then requires
 *                                 `email_verified === true`
 *   completeGoogleCodeFlow(…)     exchange + verify in one call
 *
 * Test seams (`GoogleOidcDeps`): `fetch` (the token endpoint), `jwks` (a `JWTVerifyGetKey`, e.g. jose's
 * `createLocalJWKSet` over a test key pair) and `now` (the clock jose checks `exp` / `iat` against). Unit tests
 * never touch the network.
 *
 * Nothing here logs: codes, verifiers and id_tokens are secrets and never leave this module except as return values.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { now as clockNow } from "@/server/clock";
import { GOOGLE_OIDC, type GoogleAuthConfig } from "./google-config";

/** The subset of `fetch` the token exchange uses. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GoogleOidcDeps {
  /** Token endpoint transport (default: global `fetch`). */
  fetch?: FetchLike;
  /** Google's signing keys (default: a cached remote JWKS at GOOGLE_OIDC.jwksUrl). */
  jwks?: JWTVerifyGetKey;
  /** Clock for exp / iat checks (default: the app clock, src/server/clock.ts). */
  now?: () => Date;
  /** Token endpoint timeout in ms (default 10 s). */
  timeoutMs?: number;
}

/** Why a round trip failed, in the words the callback maps to `?google=<result>`. */
export type GoogleOidcFailure = "exchange_failed" | "invalid_token" | "unverified_email";

/** A failed exchange or a token we refuse. The message is generic on purpose (it may reach a log, never a page). */
export class GoogleOidcError extends Error {
  constructor(readonly reason: GoogleOidcFailure) {
    super(`Google sign-in failed (${reason})`);
    this.name = "GoogleOidcError";
  }
}

/** What Proofline uses from a verified id_token. */
export interface GoogleIdentity {
  /** Google's stable account id (OIDC `sub`). */
  sub: string;
  /** The Google account's email, trimmed and lower-cased. */
  email: string;
  /** Always true for an identity returned by `verifyIdToken` (false tokens are refused). */
  emailVerified: true;
  /** Display name (`name`, else given + family), trimmed; null when Google sent none. */
  name: string | null;
  /** Google Workspace domain (`hd`), lower-cased; null for consumer accounts. */
  hostedDomain: string | null;
}

/** Allowed id_token clock skew between Google and us. */
export const ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 60;
/** An id_token is minted by the code exchange a moment earlier; anything older than Google's own hour is refused. */
export const ID_TOKEN_MAX_AGE_SECONDS = 3600;
const DEFAULT_TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------ */
/*  Random values + PKCE                                               */
/* ------------------------------------------------------------------ */

/** `bytes` random bytes, base64url (32 bytes → 43 characters). */
export function randomUrlToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** RFC 7636 S256: base64url(sha256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export interface GoogleFlowSecrets {
  /** CSRF binding between /start and /callback (echoed by Google in `?state=`). */
  state: string;
  /** Replay binding of the id_token (Google copies it into the token's `nonce` claim). */
  nonce: string;
  /** PKCE code verifier (43 characters, within RFC 7636's 43–128). */
  verifier: string;
}

export function newFlowSecrets(): GoogleFlowSecrets {
  return { state: randomUrlToken(), nonce: randomUrlToken(), verifier: randomUrlToken() };
}

/** Constant-time string equality (state / nonce comparison). */
export function sameSecret(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/* ------------------------------------------------------------------ */
/*  Authorize URL                                                      */
/* ------------------------------------------------------------------ */

export interface AuthorizeUrlInput {
  clientId: string;
  /** `googleRedirectUri(req)` — must match the OAuth client's authorised redirect URI exactly. */
  redirectUri: string;
  state: string;
  nonce: string;
  /** The PKCE verifier; only its S256 challenge goes into the URL. */
  codeVerifier: string;
  /** Pre-selects an account in Google's chooser (optional). */
  loginHint?: string | null;
}

/** Google's authorization endpoint for the code flow with PKCE (S256), nonce and the account chooser. */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(GOOGLE_OIDC.authorizeUrl);
  const params: Record<string, string> = {
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_OIDC.scope,
    state: input.state,
    nonce: input.nonce,
    code_challenge: pkceChallenge(input.codeVerifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  };
  if (input.loginHint) params.login_hint = input.loginHint;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/* ------------------------------------------------------------------ */
/*  Code exchange                                                      */
/* ------------------------------------------------------------------ */

export interface ExchangeCodeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/**
 * POSTs the authorization code to Google's token endpoint (client secret + PKCE verifier) and returns the id_token.
 * Any transport error, non-2xx answer, timeout or missing id_token → `GoogleOidcError("exchange_failed")`.
 */
export async function exchangeCode(config: GoogleAuthConfig, input: ExchangeCodeInput, deps: GoogleOidcDeps = {}): Promise<string> {
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  let res: Response;
  try {
    res = await doFetch(GOOGLE_OIDC.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleOidcError("exchange_failed");
  }
  if (!res.ok) throw new GoogleOidcError("exchange_failed");
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new GoogleOidcError("exchange_failed");
  }
  const idToken = payload && typeof payload === "object" ? (payload as Record<string, unknown>).id_token : undefined;
  if (typeof idToken !== "string" || idToken.length === 0) throw new GoogleOidcError("exchange_failed");
  return idToken;
}

/* ------------------------------------------------------------------ */
/*  id_token verification                                              */
/* ------------------------------------------------------------------ */

let remoteJwks: JWTVerifyGetKey | null = null;

/** Google's JWKS, fetched lazily and cached by jose (keys rotate; jose refetches on an unknown `kid`). */
function googleJwks(): JWTVerifyGetKey {
  remoteJwks ??= createRemoteJWKSet(new URL(GOOGLE_OIDC.jwksUrl), { timeoutDuration: 5_000, cooldownDuration: 30_000 });
  return remoteJwks;
}

function nameOf(payload: JWTPayload): string | null {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const full = str(payload.name);
  if (full) return full;
  const parts = [str(payload.given_name), str(payload.family_name)].filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(" ") : null;
}

export interface VerifyIdTokenInput {
  clientId: string;
  /** The nonce this browser's round trip started with. */
  nonce: string;
}

/**
 * Verifies an id_token from Google: signature (RS256, Google's keys), `iss` ∈ GOOGLE_OIDC.issuers, `aud` = our
 * client id, `exp` / `iat` present and valid (±60 s; `iat` not in the future, at most an hour old), `nonce` equal to ours, a non-empty `sub` and an `email`.
 * Anything wrong → `GoogleOidcError("invalid_token")`. A valid token whose `email_verified` is not exactly `true`
 * → `GoogleOidcError("unverified_email")` (never link or create an account on an unverified address).
 */
export async function verifyIdToken(idToken: string, input: VerifyIdTokenInput, deps: GoogleOidcDeps = {}): Promise<GoogleIdentity> {
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(idToken, deps.jwks ?? googleJwks(), {
      algorithms: ["RS256"],
      issuer: [...GOOGLE_OIDC.issuers],
      audience: input.clientId,
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
      // Also refuses an `iat` in the future.
      maxTokenAge: ID_TOKEN_MAX_AGE_SECONDS,
      currentDate: (deps.now ?? clockNow)(),
      requiredClaims: ["exp", "iat", "sub", "nonce"],
    });
    payload = verified.payload;
  } catch {
    throw new GoogleOidcError("invalid_token");
  }
  if (typeof payload.nonce !== "string" || !sameSecret(payload.nonce, input.nonce)) throw new GoogleOidcError("invalid_token");
  // Several audiences: Google sets `azp` to the client that asked; it must be us.
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== input.clientId) throw new GoogleOidcError("invalid_token");
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!sub || sub.length > 255 || !email || email.length > 254 || !email.includes("@")) throw new GoogleOidcError("invalid_token");
  if (payload.email_verified !== true) throw new GoogleOidcError("unverified_email");
  const hd = typeof payload.hd === "string" && payload.hd.trim() ? payload.hd.trim().toLowerCase() : null;
  return { sub, email, emailVerified: true, name: nameOf(payload), hostedDomain: hd };
}

/**
 * Is Google the authority for this address? True for Gmail addresses and for Google Workspace accounts whose
 * address is on the Workspace domain (`hd`). For any other address `email_verified` only means "verified once" —
 * good enough to confirm a NEW account's email, not to take over an existing Proofline account by email.
 */
export function googleIsAuthoritative(identity: Pick<GoogleIdentity, "email" | "hostedDomain">): boolean {
  const domain = identity.email.slice(identity.email.lastIndexOf("@") + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") return true;
  return identity.hostedDomain !== null && identity.hostedDomain === domain;
}

/** Code → id_token → verified identity, in one call. */
export async function completeGoogleCodeFlow(
  config: GoogleAuthConfig,
  input: ExchangeCodeInput & { nonce: string },
  deps: GoogleOidcDeps = {},
): Promise<GoogleIdentity> {
  const idToken = await exchangeCode(config, input, deps);
  return verifyIdToken(idToken, { clientId: config.clientId, nonce: input.nonce }, deps);
}
