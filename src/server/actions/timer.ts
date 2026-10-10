/**
 * `POST /api/jobs/:id/timer { action: start|pause|stop, note?, switchFromRunning? }`
 * — one entry point over the time-tracking service (ARCHITECTURE.md §9).
 *
 * Plain module (no "use server"): a composite the REST handler calls inside
 * its transaction. Permission checks stay in startTimer / pauseTimer / stopTimer.
 */
import type { Tx } from "@/db/index";
import type { AuthContext, TimerActionResult } from "@/lib/types";
import { TimerActionInput } from "@/lib/validation/timeTracking";
import { parseInput } from "@/server/services/_shared";
import { pauseTimer, startTimer, stopTimer } from "@/server/services/timeTracking";

export async function timerAction(tx: Tx, ctx: AuthContext, input: unknown): Promise<TimerActionResult> {
  const p = parseInput(TimerActionInput, input);
  if (p.action === "start") {
    const r = await startTimer(tx, ctx, { jobId: p.jobId, note: p.note, switchFromRunning: p.switchFromRunning });
    return { action: "start", session: r.session, alreadyRunning: r.alreadyRunning, stopped: r.stopped };
  }
  const end = p.action === "pause" ? pauseTimer : stopTimer;
  const session = await end(tx, ctx, { jobId: p.jobId, note: p.note });
  return { action: p.action, session, alreadyRunning: false, stopped: null };
}
