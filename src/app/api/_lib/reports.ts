import type { DbLike } from "@/db/index";
import type { AuthContext } from "@/lib/types";
import { getReport, reportFileName, toCsv } from "@/server/queries/reports";
import { one } from "./route";

/** A report as JSON (`{ data }` via the route factory) or, with `format=csv`, a text/csv attachment. */
export function reportResponse(db: DbLike, ctx: AuthContext, kind: string, q: Record<string, string | string[]>): unknown {
  const report = getReport(db, ctx, kind, q);
  if (one(q, "format") !== "csv") return report;
  return new Response(toCsv(report, ctx.settings.timezone), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${reportFileName(report, ctx.settings.timezone)}"`,
      "cache-control": "no-store",
    },
  });
}
