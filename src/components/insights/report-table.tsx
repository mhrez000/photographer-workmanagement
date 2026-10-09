"use client";

import * as React from "react";
import { FileSpreadsheet } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TFoot, TH, THead, TR } from "@/components/ui/table";
import { useUrlSort } from "@/components/team/use-url-sort";
import { formatDate } from "@/lib/dates";
import type { ReportCell, ReportColumn } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ReportTableProps {
  columns: ReportColumn[];
  rows: Record<string, ReportCell>[];
  totals: Record<string, ReportCell> | null;
  timeZone: string;
  /** Columns shown on the stacked mobile card (after the first column). */
  mobileKeys?: string[];
  emptyTitle: string;
  emptyDescription: string;
}

/** Hours → "37.7h" / "3.2d" (reports carry hours with 2 dp). */
function hours(v: number): string {
  if (Math.abs(v) >= 48) return `${(v / 24).toFixed(1)}d`;
  return `${v.toFixed(1)}h`;
}

export function formatCell(value: ReportCell, kind: ReportColumn["kind"], timeZone: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  switch (kind) {
    case "number":
      return typeof value === "number" ? new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 }).format(value) : String(value);
    case "hours":
      return typeof value === "number" ? hours(value) : String(value);
    case "percent":
      return typeof value === "number" ? `${value % 1 === 0 ? value : value.toFixed(1)}%` : String(value);
    case "date":
      return formatDate(String(value), timeZone);
    default:
      return String(value);
  }
}

const isNumericKind = (k: ReportColumn["kind"]) => k !== "text";
const REPORT_ORDER = "report";

/** The report as a sortable table (table ≥ md, stacked cards below), totals row pinned to the bottom. */
export function ReportTable({ columns, rows, totals, timeZone, mobileKeys, emptyTitle, emptyDescription }: ReportTableProps) {
  const firstDir = React.useMemo(
    () =>
      ({
        [REPORT_ORDER]: "asc",
        ...Object.fromEntries(columns.map((c) => [c.key, c.kind === "text" ? "asc" : "desc"])),
      }) as Record<string, "asc" | "desc">,
    [columns],
  );
  // No sort param = the report's own order; a header click sorts by that column.
  const sort = useUrlSort<string>("", firstDir, REPORT_ORDER);
  const ordered = sort.key === REPORT_ORDER ? rows : sort.sortRows(rows, (r, k) => normalise(r[k]), (r) => String(r[columns[0]?.key ?? ""] ?? ""));

  if (rows.length === 0) {
    return <EmptyState icon={FileSpreadsheet} size="sm" title={emptyTitle} description={emptyDescription} />;
  }
  const head = columns[0];
  const cardKeys = (mobileKeys ?? columns.slice(1, 4).map((c) => c.key)).map((k) => columns.find((c) => c.key === k)).filter((c): c is ReportColumn => !!c);

  return (
    <>
      <div className="hidden md:block print:block">
        <Table maxHeight={rows.length > 25 ? "70vh" : undefined} wrapperClassName="print:max-h-none! print:overflow-visible!">
          <THead>
            <tr>
              {columns.map((c) => (
                <TH
                  key={c.key}
                  numeric={isNumericKind(c.kind) && c.kind !== "date"}
                  sortable
                  sortDirection={sort.directionOf(c.key)}
                  onSort={sort.toggle(c.key)}
                  className="whitespace-nowrap"
                >
                  {c.label}
                </TH>
              ))}
            </tr>
          </THead>
          <TBody>
            {ordered.map((r, i) => (
              <TR key={i}>
                {columns.map((c, ci) => (
                  <TD
                    key={c.key}
                    numeric={isNumericKind(c.kind) && c.kind !== "date"}
                    muted={c.kind === "date"}
                    primary={ci === 0}
                    className={cn(ci === 1 && c.kind === "text" && "max-w-72 truncate", "whitespace-nowrap")}
                    title={ci === 1 && c.kind === "text" ? String(r[c.key] ?? "") : undefined}
                  >
                    {formatCell(r[c.key], c.kind, timeZone)}
                  </TD>
                ))}
              </TR>
            ))}
          </TBody>
          {totals ? (
            <TFoot>
              <tr>
                {columns.map((c, ci) => (
                  <TD key={c.key} numeric={isNumericKind(c.kind) && c.kind !== "date"} className={cn("whitespace-nowrap", ci === 0 && "font-semibold")}>
                    {totals[c.key] === undefined ? "" : formatCell(totals[c.key], c.kind, timeZone)}
                  </TD>
                ))}
              </tr>
            </TFoot>
          ) : null}
        </Table>
      </div>
      <ul className="flex flex-col divide-y divide-border md:hidden print:hidden">
        {ordered.map((r, i) => (
          <li key={i} className="flex flex-col gap-1.5 px-4 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-medium text-ink">{formatCell(r[head.key], head.kind, timeZone)}</span>
              {columns[1]?.kind === "text" ? <span className="truncate text-xs text-ink-muted">{formatCell(r[columns[1].key], "text", timeZone)}</span> : null}
            </div>
            <dl className="grid grid-cols-3 gap-2 text-sm">
              {cardKeys.map((c) => (
                <div key={c.key} className="min-w-0">
                  <dt className="truncate text-2xs uppercase tracking-wider text-ink-subtle">{c.label}</dt>
                  <dd className="truncate font-medium text-ink numeric">{formatCell(r[c.key], c.kind, timeZone)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
        {totals ? (
          <li className="bg-surface-sunken px-4 py-3">
            <dl className="grid grid-cols-3 gap-2 text-sm">
              {cardKeys.map((c) => (
                <div key={c.key} className="min-w-0">
                  <dt className="truncate text-2xs uppercase tracking-wider text-ink-subtle">Total · {c.label}</dt>
                  <dd className="font-semibold text-ink numeric">{totals[c.key] === undefined ? "—" : formatCell(totals[c.key], c.kind, timeZone)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ) : null}
      </ul>
    </>
  );
}

function normalise(v: ReportCell): number | string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  return v.toLowerCase();
}
