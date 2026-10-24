/**
 * "Continue with Google" configuration (docs/ACCOUNTS.md "Google sign-in"). Google sign-in exists only when BOTH
 * `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set; otherwise every Google button renders nothing, and
 * /api/auth/google/start + /callback send the browser back to the page with `?google=disabled` (never a 404 or an
 * error page). /complete still works with a valid finish cookie and /disconnect always works, so a connected account
 * can be tidied up after Google is switched off. The OAuth client's authorised redirect URI must equal
 * `googleRedirectUri()` exactly: https://<APP_URL host>/api/auth/google/callback (production) and
 * http://localhost:3130/api/auth/google/callback (local dev).
 */
import { appOrigin } from "@/server/origin";

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
}

/** Google's OpenID Connect endpoints (fixed; no discovery round trip). */
export const GOOGLE_OIDC = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
  scope: "openid email profile",
} as const;

/** The configured client, or null when Google sign-in is off. */
export function googleAuthConfig(env: Readonly<Record<string, string | undefined>> = process.env): GoogleAuthConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** `${appOrigin(req)}/api/auth/google/callback` — the redirect URI sent to Google (must match the OAuth client). */
export function googleRedirectUri(req?: Request | null, env: Readonly<Record<string, string | undefined>> = process.env): string {
  return `${appOrigin(req, env)}/api/auth/google/callback`;
}
