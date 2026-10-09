/** GET /api/me/timer -> RunningSessionView | null */
import { read } from "@/app/api/_lib/route";
import { runningSessionFor } from "@/server/services/timeTracking";

export const GET = read((db, ctx) => runningSessionFor(db, ctx));
