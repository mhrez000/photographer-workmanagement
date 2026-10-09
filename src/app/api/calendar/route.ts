/** GET /api/calendar?from&to&... -> CalendarEvent[] */
import { read } from "@/app/api/_lib/route";
import { getCalendarEvents } from "@/server/queries/calendar";

export const GET = read((db, ctx, q) => getCalendarEvents(db, ctx, q));
