/**
 * The public origin links in emails / copyable invite links point at.
 *
 * Order: `APP_URL` (the canonical public address, e.g. https://app.proofline.example) → `APP_ORIGIN` (the CSRF
 * origin, when set) → the request's own origin (host header as Next saw it) → http://localhost:3000.
 * Never derived from client-controlled forwarding headers unless the request origin itself already was.
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

/** Public origin for links (no trailing slash). */
export function appOrigin(req?: Request | null, env: Readonly<Record<string, string | undefined>> = process.env): string {
  return normalise(env.APP_URL) ?? normalise(env.APP_ORIGIN) ?? (req ? normalise(req.url) : null) ?? DEFAULT_ORIGIN;
}

/** `${origin}/invite/${token}` — the page that accepts an invite. */
export function inviteUrl(token: string, req?: Request | null): string {
  return `${appOrigin(req)}/invite/${encodeURIComponent(token)}`;
}

/** `${origin}/reset-password?token=…` — the page that sets a new password. */
export function passwordResetUrl(token: string, req?: Request | null): string {
  return `${appOrigin(req)}/reset-password?token=${encodeURIComponent(token)}`;
}
