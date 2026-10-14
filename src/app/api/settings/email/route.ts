import { methodNotAllowed, read } from "@/app/api/_lib/route";
import { getEmailSettings } from "@/server/services/settings";

/**
 * GET /api/settings/email (admin) → `{ data: { configured, provider: "resend" | "console", from, notificationsEnabled } }`
 * — whether invite / reset links are emailed (RESEND_API_KEY + EMAIL_FROM) or must be copied from the screen.
 */
export const GET = read((db, ctx) => getEmailSettings(db, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
