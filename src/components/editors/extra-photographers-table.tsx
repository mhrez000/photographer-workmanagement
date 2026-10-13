import { PersonChip } from "@/components/jobs/person";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { ExtraPhotographerRow } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ExtraPhotographersTableProps {
  rows: ExtraPhotographerRow[];
  periodLabel: string;
}

/**
 * The small table of extra photographers (docs/SIMPLIFICATION-PLAN.md §7): Shoots this period · Waiting
 * for their check · Late. Rendered only when the studio has one.
 */
export function ExtraPhotographersTable({ rows, periodLabel }: ExtraPhotographersTableProps) {
  if (rows.length === 0) return null;
  const shootsLabel = periodLabel === "This month" ? "Shoots this month" : `Shoots · ${periodLabel.toLowerCase()}`;
  return (
    <Table>
      <THead>
        <TR>
          <TH>Photographer</TH>
          <TH numeric>{shootsLabel}</TH>
          <TH numeric>Waiting for their check</TH>
          <TH numeric>Late</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((row) => (
          <TR key={row.photographer.id}>
            <TD primary>
              <PersonChip user={row.photographer} />
            </TD>
            <TD numeric className="numeric">
              {row.shootsThisPeriod}
            </TD>
            <TD numeric className={cn("numeric", row.waitingForTheirCheck > 0 && "font-medium text-attention-fg")}>
              {row.waitingForTheirCheck}
            </TD>
            <TD numeric className={cn("numeric", row.late > 0 && "font-semibold text-danger-fg")}>
              {row.late}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
