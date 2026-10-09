"use client";

import * as React from "react";
import { FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TFoot, TH, THead, TR } from "@/components/ui/table";
import { useUrlSort } from "@/components/team/use-url-sort";
import { ScrollFade } from "@/components/work-table/scroll-fade";
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
  /** Key columns moved right after the identifier on screen (so they never scroll out of view). */
  leadKeys?: string[];
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
/** Stacked cards render this many rows, then "Show more" in steps of the same size. */
export const MOBILE_PAGE_SIZE = 25;

/**
 * On-screen column label. Hour columns are formatted as "37.7h" / "3.2d", so
 * the "(h)" unit suffix the CSV needs would be wrong (and truncates on cards).
 */
export function displayLabel(c: Pick<ReportColumn, "label" | "kind">): string {
  return c.kind === "hours" ? c.label.replace(/\s*\(h\)\s*$/, "") : c.label;
}

/**
 * Display order: the identifier columns (first, plus a text name right after
 * it), then `leadKeys`, then everything else in report order. The CSV keeps
 * the report's own order.
 */
export function orderColumns(columns: readonly ReportColumn[], leadKeys: readonly string[] = []): ReportColumn[] {
  const idCount = columns[1]?.kind === "text" ? 2 : 1;
  const ids = columns.slice(0, idCount);
  const lead = leadKeys.map((k) => columns.find((c) => c.key === k)).filter((c): c is ReportColumn => !!c && !ids.includes(c));
  return [...ids, ...lead, ...columns.filter((c) => !ids.includes(c) && !lead.includes(c))];
}

/** The report as a sortable table (table ≥ md, stacked cards below), totals row pinned to the bottom. */
export function ReportTable({ columns: reportColumns, rows, totals, timeZone, mobileKeys, leadKeys, emptyTitle, emptyDescription }: ReportTableProps) {
  const columns = React.useMemo(() => orderColumns(reportColumns, leadKeys), [reportColumns, leadKeys]);
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
  const [mobileLimit, setMobileLimit] = React.useState(MOBILE_PAGE_SIZE);

  if (rows.length === 0) {
    return <EmptyState icon={FileSpreadsheet} size="sm" title={emptyTitle} description={emptyDescription} />;
  }
  const head = columns[0];
  const nameCol = columns[1]?.kind === "text" ? columns[1] : null;
  const cardKeys = (mobileKeys ?? columns.slice(1, 4).map((c) => c.key)).map((k) => columns.find((c) => c.key === k)).filter((c): c is ReportColumn => !!c);
  const mobileRows = ordered.slice(0, mobileLimit);
  const remaining = ordered.length - mobileRows.length;

  return (
    <>
      <ScrollFade className="hidden md:block print:block">
        <Table maxHeight={rows.length > 25 ? "70vh" : undefined} wrapperClassName="print:max-h-none! print:overflow-visible!">
          <THead>
            <tr>
              {columns.map((c, ci) => (
                <TH
                  key={c.key}
                  numeric={isNumericKind(c.kind) && c.kind !== "date"}
                  sortable
                  sortDirection={sort.directionOf(c.key)}
                  onSort={sort.toggle(c.key)}
                  title={c.label}
                  className={cn("whitespace-nowrap", ci === 0 && "sticky left-0 z-20 bg-surface-sunken shadow-[inset_-1px_0_0_var(--border)] print:static")}
                >
                  {displayLabel(c)}
                </TH>
              ))}
            </tr>
          </THead>
          <TBody>
            {ordered.map((r, i) => (
              <TR key={i} className="group/row">
                {columns.map((c, ci) => {
                  const text = c.kind === "text" && ci > 0;
                  return (
                    <TD
                      key={c.key}
                      numeric={isNumericKind(c.kind) && c.kind !== "date"}
                      muted={c.kind === "date"}
                      primary={ci === 0}
                      className={cn(
                        "whitespace-nowrap",
                        // Text columns are capped (full value in the title) so the key numbers stay on screen.
                        text && (ci === 1 ? "max-w-64 truncate" : "max-w-48 truncate"),
                        ci === 0 &&
                          "sticky left-0 z-[1] bg-surface shadow-[inset_-1px_0_0_var(--border)] group-hover/row:bg-[color-mix(in_oklab,var(--surface-muted)_60%,var(--surface))] print:static",
                      )}
                      title={text ? String(r[c.key] ?? "") : undefined}
                    >
                      {formatCell(r[c.key], c.kind, timeZone)}
                    </TD>
                  );
                })}
              </TR>
            ))}
          </TBody>
          {totals ? (
            <TFoot>
              <tr>
                {columns.map((c, ci) => (
                  <TD
                    key={c.key}
                    numeric={isNumericKind(c.kind) && c.kind !== "date"}
                    className={cn("whitespace-nowrap", ci === 0 && "sticky left-0 z-[1] bg-surface-sunken font-semibold shadow-[inset_-1px_0_0_var(--border)] print:static")}
                  >
                    {totals[c.key] === undefined ? "" : formatCell(totals[c.key], c.kind, timeZone)}
                  </TD>
                ))}
              </tr>
            </TFoot>
          ) : null}
        </Table>
      </ScrollFade>
      <ul className="flex flex-col divide-y divide-border md:hidden print:hidden">
        {mobileRows.map((r, i) => {
          const name = nameCol ? formatCell(r[nameCol.key], "text", timeZone) : null;
          return (
            <li key={i} className="flex flex-col gap-1.5 px-4 py-3">
              <div className="flex min-w-0 items-baseline gap-2" title={name ?? undefined}>
                <span className="shrink-0 font-medium text-ink">{formatCell(r[head.key], head.kind, timeZone)}</span>
                {name !== null ? <span className="min-w-0 truncate text-xs text-ink-muted">{name}</span> : null}
              </div>
              <dl className="grid grid-cols-3 gap-2 text-sm">
                {cardKeys.map((c) => (
                  <div key={c.key} className="min-w-0">
                    <dt className="text-2xs leading-tight uppercase tracking-wider text-ink-subtle">{displayLabel(c)}</dt>
                    <dd className="truncate font-medium text-ink numeric">{formatCell(r[c.key], c.kind, timeZone)}</dd>
                  </div>
                ))}
              </dl>
            </li>
          );
        })}
        {remaining > 0 ? (
          <li className="px-4 py-3">
            <Button variant="outline" size="sm" className="w-full" onClick={() => setMobileLimit((n) => n + MOBILE_PAGE_SIZE)}>
              Show {Math.min(MOBILE_PAGE_SIZE, remaining)} more
              <span className="numeric text-ink-muted">· {remaining} left</span>
            </Button>
          </li>
        ) : null}
        {totals ? (
          <li className="bg-surface-sunken px-4 py-3">
            <dl className="grid grid-cols-3 gap-2 text-sm">
              {cardKeys.map((c) => (
                <div key={c.key} className="min-w-0">
                  <dt className="text-2xs leading-tight uppercase tracking-wider text-ink-subtle">Total · {displayLabel(c)}</dt>
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
