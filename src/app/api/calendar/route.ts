/** GET /api/calendar?from&to&... -> CalendarEvent[] */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { getCalendarEvents } from "@/server/queries/calendar";

export const GET = read((db, ctx, q) => getCalendarEvents(db, ctx, q));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
