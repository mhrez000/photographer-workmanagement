/** GET /api/reports/:kind?range&format=json|csv -> Report, or a text/csv attachment */
import { one, readBy } from "@/app/api/_lib/route";
import { getReport, reportFileName, toCsv } from "@/server/queries/reports";

export const GET = readBy((db, ctx, kind, q) => {
  const report = getReport(db, ctx, kind, q);
  if (one(q, "format") !== "csv") return report;
  return new Response(toCsv(report), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${reportFileName(report)}"`,
      "cache-control": "no-store",
    },
  });
}, "kind");
