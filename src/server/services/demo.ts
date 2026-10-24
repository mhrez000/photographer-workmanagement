/**
 * "Look around the demo" (docs/ACCOUNTS.md §7): the sign-in page's persona buttons sign a visitor straight into the
 * shared demo studio as Owner / Photographer / Editor / Client — no email or password is ever shown or typed.
 *
 *   demoSignIn(db, { persona, ip, userAgent }, opts)   POST /api/auth/demo (public). 404 "The demo studio is turned
 *                                                      off" when `DEMO_SIGN_IN=off` or no demo studio exists (the
 *                                                      persona must be an active, accepted DEMO_ACCOUNTS user INSIDE an
 *                                                      `is_demo` organisation — `findDemoPersonaUser`, never a real
 *                                                      studio's look-alike address); 30 sign-ins / 10 min per client IP
 *                                                      (429, plain words; skipped when the IP is unknown, so no one can
 *                                                      lock everybody out); then `startSession(method "demo")` — the
 *                                                      one sign-in path: last_login_at, `auth.logged_in` with
 *                                                      `metadata.method: "demo"` + the persona, and the cookie.
 *
 * Inside the demo studio the services refuse what would spoil it for the next visitor (`assertNotDemo`), and
 * signing out never revokes the persona's other sessions (services/auth.ts `recordLogout`).
 */
import type { Db } from "@/db/index";
import type { Role } from "@/lib/constants";
import { DemoSignInInput } from "@/lib/validation/auth";
import { knownIpKey } from "@/server/auth/db-rate-limit";
import { demoSignInEnabled, findDemoPersonaUser } from "@/server/auth/demo";
import { loginRedirectTarget } from "@/server/auth/redirect";
import { startSession } from "@/server/auth/sign-in";
import { NotFoundError } from "@/server/errors";
import { enforceLimit } from "./authLimits";
import { parseInput } from "./_shared";

export const DEMO_OFF_MESSAGE = "The demo studio is turned off";

export interface DemoSignInResult {
  /** The persona's landing page (owner / photographer /home, editor /my-jobs, client /portal). */
  redirectTo: string;
  user: { id: string; name: string; role: Role };
}

export interface DemoSignInOptions {
  requestId?: string;
  /** Test seam for `DEMO_SIGN_IN`. */
  env?: Readonly<Record<string, string | undefined>>;
}

function demoOff(): NotFoundError {
  return new NotFoundError("Demo", DEMO_OFF_MESSAGE);
}

/** Signs this browser in as one demo persona (route handlers: sets the session cookie). */
export async function demoSignIn(db: Db, raw: unknown, opts: DemoSignInOptions = {}): Promise<DemoSignInResult> {
  // Turned off → the endpoint looks absent, whatever was sent.
  if (!demoSignInEnabled(opts.env)) throw demoOff();
  const input = parseInput(DemoSignInInput, raw);
  const user = await findDemoPersonaUser(db, input.persona);
  if (!user) throw demoOff();
  // Per network only when the network is known (SEC-10): without TRUSTED_PROXY_COUNT every visitor would share ONE
  // bucket, and anyone could lock the demo for everybody with 30 presses.
  const network = knownIpKey(input.ip);
  if (network) await enforceLimit(db, "demoSignIn", network, "demo");
  const started = await startSession(
    db,
    {
      userId: user.id,
      method: "demo",
      ip: input.ip,
      userAgent: input.userAgent,
      requestId: opts.requestId,
      metadata: { persona: input.persona },
    },
    { env: opts.env },
  );
  return { redirectTo: loginRedirectTarget(started.role, null), user: { id: started.userId, name: started.name, role: started.role } };
}
