/** GET /api/jobs/simple/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD -> SimpleCalendarEvent[] — shoot and due dates for the List / Calendar switch (at most 92 days). */
import { methodNotAllowed, read } from "@/app/api/_lib/route";
import { calendarJobs } from "@/server/queries/jobsSimple";

export const GET = read((db, ctx, q) => calendarJobs(db, ctx, q));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
