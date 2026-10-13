/**
 * GET /api/jobs/simple?stage&late&showCancelled&q&editorId&clientId&cursor&limit
 *   -> SimpleJobListResult & { counts: StageCounts } — the one Jobs list (SIMPLIFICATION-PLAN §1, §4):
 *   `stage` = all_active (default) | needs_editor | with_editor | ready_to_check | changes_asked | done |
 *   cancelled; `late=1` keeps late jobs; `showCancelled=1` adds cancelled rows to all_active;
 *   `editorId=none` = jobs without an editor. `counts` are the tab numbers under the same q / editor /
 *   client filters. Who you are decides which rows you see, never which list you open.
 */
import { methodNotAllowed, read } from "@/app/api/_lib/route";
import { listJobsByStage, stageCounts } from "@/server/queries/jobsSimple";

export const GET = read(async (db, ctx, q) => {
  const [list, counts] = await Promise.all([listJobsByStage(db, ctx, q), stageCounts(db, ctx, q)]);
  return { ...list, counts };
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
