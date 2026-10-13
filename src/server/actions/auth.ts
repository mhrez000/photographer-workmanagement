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
import { getOptionalContext } from "@/server/auth/session";
import { clientIp } from "@/server/http";
import { isAppError, RateLimitedError } from "@/server/errors";
import { login, logout } from "@/server/services/auth";

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


function minutes(seconds: number): string {
  const m = Math.ceil(seconds / 60);
  return m <= 1 ? "a minute" : `${m} minutes`;
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
      return {
        error: `Too many sign-in attempts. Try again in ${minutes(err.retryAfterSeconds)}.`,
        fieldErrors: {},
        email,
        retryAfterSeconds: err.retryAfterSeconds,
      };
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
  redirect("/login");
}
