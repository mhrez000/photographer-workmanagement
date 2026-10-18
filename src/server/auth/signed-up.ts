/**
 * Front door: remembers on THIS browser that a real studio was created here (`pl_signed_up`), so the sign-in
 * page stops offering the demo accounts to someone who now has an account of their own. A convenience, never
 * authorisation: it is httpOnly, carries no identity and is read only by the sign-in page.
 */
import { cookies } from "next/headers";

export const SIGNED_UP_COOKIE_NAME = "pl_signed_up";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Set right after `POST /api/auth/signup` succeeds (route handlers / server actions only). */
export async function markSignedUp(): Promise<void> {
  const jar = await cookies();
  jar.set(SIGNED_UP_COOKIE_NAME, "1", { path: "/", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: ONE_YEAR_SECONDS });
}

/** Has a studio been created from this browser? */
export async function hasSignedUp(): Promise<boolean> {
  const jar = await cookies();
  return jar.get(SIGNED_UP_COOKIE_NAME)?.value === "1";
}
