"use server";

/**
 * Login / logout server actions for the forms. Thin: parse the form, call
 * the auth service, map errors to form state. (Next.js checks the Origin of
 * server-action POSTs itself, so no extra CSRF step is needed here.)
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Role } from "@/lib/constants";
import { loginRedirectTarget } from "@/server/auth/redirect";
import { signOutReturnPath } from "@/server/auth/return-path";
import { getOptionalContext } from "@/server/auth/session";
import { clientIp } from "@/server/http";
import { isAppError, RateLimitedError } from "@/server/errors";
import { login, logout } from "@/server/services/auth";
import { rateLimitMessage } from "@/server/services/authLimits";

export interface LoginFormState {
  /** Form-level message (bad credentials, rate limit, server error). */
  error: string | null;
  /** Per-field messages from validation. */
  fieldErrors: { email?: string; password?: string };
  /** Echoed back so the field keeps its value after a failed attempt. */
  email: string;
  /** Set when throttled: seconds until another attempt is allowed. */
  retryAfterSeconds: number | null;
}

export async function loginAction(_prev: LoginFormState, formData: FormData): Promise<LoginFormState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const h = await headers();
  let role: Role;
  try {
    role = (await login({ email, password, ip: clientIp(h), userAgent: h.get("user-agent") })).role;
  } catch (err) {
    if (err instanceof RateLimitedError) {
      // "Too many sign-in attempts. Try again in N minutes." (the DB limiter says how long).
      return { error: rateLimitMessage("sign_in", err.retryAfterSeconds), fieldErrors: {}, email, retryAfterSeconds: err.retryAfterSeconds };
    }
    if (isAppError(err) && err.code === "validation") {
      const details = err.details as { fieldErrors?: Record<string, string[]> } | undefined;
      return {
        error: null,
        fieldErrors: { email: details?.fieldErrors?.email?.[0], password: details?.fieldErrors?.password?.[0] },
        email,
        retryAfterSeconds: null,
      };
    }
    if (isAppError(err)) return { error: err.message, fieldErrors: {}, email, retryAfterSeconds: null };
    console.error("[login] unexpected error", err);
    return { error: "Something went wrong. Please try again.", fieldErrors: {}, email, retryAfterSeconds: null };
  }
  // Landing by role (plan §3): photographers /home, editors /my-jobs, clients /portal; a safe `next` wins.
  redirect(loginRedirectTarget(role, formData.get("next")));
}

export async function logoutAction(): Promise<void> {
  const h = await headers();
  await logout(await getOptionalContext(), { ip: clientIp(h), userAgent: h.get("user-agent") });
  redirect("/login?logged_out=1");
}

/**
 * "Log out" from a public page — the signed-in notice on /login, /signup and /invite/[token], and the demo studio
 * banner's "Create your own studio": ends this session (audited like any logout; in the demo studio only this browser
 * is logged out) and lands on the allowlisted `next` (/login, /login?demo=1, /signup, /invite/<token>;
 * anything else → /login).
 */
export async function signOutAction(formData: FormData): Promise<void> {
  const h = await headers();
  await logout(await getOptionalContext(), { ip: clientIp(h), userAgent: h.get("user-agent") });
  redirect(signOutReturnPath(formData.get("next")));
}

/**
 * "Log out to accept this invite" on /invite/[token] when a DIFFERENT person is signed in on this browser:
 * ends the current session (audited like any logout) and comes straight back to the invite, now anonymous.
 * (Kept for callers that still use the old name; same allowlist as `signOutAction`.)
 */
export async function signOutToInviteAction(formData: FormData): Promise<void> {
  return signOutAction(formData);
}
