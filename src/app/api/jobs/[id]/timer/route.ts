/** POST /api/jobs/:id/timer { action: start|pause|stop, note?, switchFromRunning? } -> TimerActionResult */
import { mutateById } from "@/app/api/_lib/route";
import { timerAction } from "@/server/actions/timer";

export const POST = mutateById("jobId", timerAction);
