/**
 * The public origin links in emails / copyable invite links point at.
 *
 * Production (`NODE_ENV === "production"`): `APP_URL` (the canonical public address, e.g.
 * https://app.proofline.example) → `APP_ORIGIN` (the CSRF origin, when set) → the request's own origin →
 * http://localhost:3000. APP_URL stays authoritative there: a link in an email must point at the one
 * public address whatever host the request came in on.
 *
 * Development / test: the REQUEST origin wins when there is one, then `APP_URL` → `APP_ORIGIN` →
 * localhost. A dev server on :3130 with a stale `APP_URL=http://localhost:3000` in its environment used
 * to hand out dead links ("Copy it before you close this" → ERR_CONNECTION_REFUSED); the request origin
 * is the one address that is known to be reachable from the browser that asked.
 *
 * Never derived from client-controlled forwarding headers unless the request origin itself already was
 * (`req.url` is what Next saw: the Host header, not `x-forwarded-*`).
 */

const DEFAULT_ORIGIN = "http://localhost:3000";

function normalise(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** The configured public origin (`APP_URL`, else `APP_ORIGIN`), or null when neither is usable. */
export function configuredOrigin(env: Env = process.env): string | null {
  return normalise(env.APP_URL) ?? normalise(env.APP_ORIGIN);
}

function isProduction(env: Env): boolean {
  return env.NODE_ENV === "production";
}

/** Public origin for links (no trailing slash). */
export function appOrigin(req?: Request | null, env: Env = process.env): string {
  const configured = configuredOrigin(env);
  const requested = req ? normalise(req.url) : null;
  if (isProduction(env)) return configured ?? requested ?? DEFAULT_ORIGIN;
  return requested ?? configured ?? DEFAULT_ORIGIN;
}

/**
 * The origin of the page that is being rendered, from the request headers Next saw (`host`, and
 * `x-forwarded-proto` only to pick http vs https). For server components, which have no `Request`.
 */
export function originFromHeaders(h: { get(name: string): string | null }): string | null {
  const host = h.get("host")?.trim();
  if (!host) return null;
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https" ? "https" : "http";
  return normalise(`${proto}://${host}`);
}

export interface LinkOriginStatus {
  /** The origin generated links use for THIS request. */
  linkOrigin: string;
  /** `APP_URL` / `APP_ORIGIN` as configured (null when unset). */
  configured: string | null;
  /** The origin the request came in on (null when unknown). */
  requested: string | null;
  /** The configured address and the request origin differ — the one-line note on the Studio email card. */
  mismatch: boolean;
  production: boolean;
}

/**
 * What the Studio → Email card says about generated links: which origin they carry, and whether the
 * configured `APP_URL` differs from the address the owner is using right now.
 */
export function linkOriginStatus(requested: string | null, env: Env = process.env): LinkOriginStatus {
  const configured = configuredOrigin(env);
  const production = isProduction(env);
  const req = requested ? normalise(requested) : null;
  const linkOrigin = production ? (configured ?? req ?? DEFAULT_ORIGIN) : (req ?? configured ?? DEFAULT_ORIGIN);
  return { linkOrigin, configured, requested: req, mismatch: configured !== null && req !== null && configured !== req, production };
}

/** `${origin}/invite/${token}` — the page that accepts an invite. */
export function inviteUrl(token: string, req?: Request | null): string {
  return `${appOrigin(req)}/invite/${encodeURIComponent(token)}`;
}

/** `${origin}/reset-password?token=…` — the page that sets a new password. */
export function passwordResetUrl(token: string, req?: Request | null): string {
  return `${appOrigin(req)}/reset-password?token=${encodeURIComponent(token)}`;
}
