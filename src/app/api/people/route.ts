/** GET /api/people -> PeopleOverview — Settings → People: owners, photographers, editors (role cards) and the portal client count (owner only). */
import { methodNotAllowed, read } from "@/app/api/_lib/route";
import { getPeopleOverview } from "@/server/queries/settingsSimple";

export const GET = read((db, ctx) => getPeopleOverview(db, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
