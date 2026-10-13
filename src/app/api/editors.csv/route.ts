/**
 * GET /api/editors.csv?period -> text/csv attachment — the Editors table plus "Average days to edit"
 * (SIMPLIFICATION-PLAN §7 "[Download CSV]", replaces Reports for the simple UI). Link it with a plain
 * `<a href="/api/editors.csv?period=last_month">`.
 */
import { methodNotAllowed, one, read } from "@/app/api/_lib/route";
import { editorsCsv } from "@/server/queries/editors";

export const GET = read(async (db, ctx, q) => {
  const { fileName, csv } = await editorsCsv(db, ctx, { period: one(q, "period") });
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "no-store",
    },
  });
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
