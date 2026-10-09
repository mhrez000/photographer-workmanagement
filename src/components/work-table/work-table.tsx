"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronsDown, ChevronsUpDown } from "lucide-react";
import { jobHref } from "@/components/jobs/job-link";
import { PersonChip } from "@/components/jobs/person";
import { PriorityPill } from "@/components/jobs/priority-pill";
import { StatusPill } from "@/components/jobs/status-pill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd } from "@/components/ui/kbd";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api-client";
import type { JobTableColumn } from "@/lib/constants";
import type { JobRow } from "@/lib/types";
import { cn, pluralise } from "@/lib/utils";
import { BulkActions } from "./bulk-actions";
import { JobIdentity, WorkCell } from "./cells";
import { COLUMN_META, nextSort, parseSort, sortParam, type SortState, type WorkGroupBy } from "./columns";
import { JobCard } from "./job-card";
import { ScrollFade } from "./scroll-fade";
import { useTableColumns } from "./use-table-columns";

export interface WorkTableGroup {
  key: string;
  label: string;
  count: number;
}

export interface WorkTableProps {
  rows: JobRow[];
  /** Organisation timezone (`ctx.settings.timezone`). */
  timeZone: string;
  /** Accessible name of the table. */
  label: string;
  /** Fixed column set. Omit to let the viewer choose (needs `columnStorageKey` + `defaultColumns`). */
  columns?: readonly JobTableColumn[];
  columnStorageKey?: string;
  defaultColumns?: readonly JobTableColumn[];
  /** Header sorting via `?sort=column:dir` (server re-sorts). */
  sortable?: boolean;
  /** The sort the server actually applied (default / saved view), for the header indicator. */
  appliedSort?: SortState | null;
  groupBy?: WorkGroupBy | null;
  /** Every group over the full result (from `listJobs`). */
  groups?: WorkTableGroup[] | null;
  /** Group key per row, parallel to `rows`. */
  rowGroupKeys?: string[] | null;
  /** Cursor for the next page (GET /api/jobs?{query}&cursor=). */
  nextCursor?: string | null;
  /** Total matching rows over all pages. */
  total?: number;
  /** `listJobs` query string (no cursor) for "Load more". */
  query?: string;
  /** Checkbox column + bulk actions (managers). */
  selectable?: boolean;
  canOverride?: boolean;
  /** j / k / x / Enter shortcuts (one table per page). */
  keyboard?: boolean;
  /** Mobile cards: omit the person a Team Work group is already about. */
  hidePerson?: "editor" | "photographer";
  /** Scroll-container height so the header and first column stay put. */
  maxHeight?: string;
  /** Shown instead of the table when there are no rows. */
  empty?: React.ReactNode;
  /** Inside another card (Team Work groups): no outer border. */
  embedded?: boolean;
  className?: string;
}

interface ExtraPage {
  identity: string;
  rows: JobRow[];
  keys: string[];
  cursor: string | null;
}

interface PageResponse {
  rows: JobRow[];
  nextCursor: string | null;
  rowGroupKeys: string[] | null;
}

const INTERACTIVE = "a, button, input, label, select, textarea, [role=menuitem], [role=menuitemcheckbox]";

/**
 * The work table behind All Work, Jobs and Team Work (spec §8, §20, §38):
 * sortable sticky header, sticky identity column, collapsible groups,
 * "Load more" via cursor, row click → job, bulk selection for managers,
 * j/k/x/Enter keys, and a card list below `md`.
 */
export function WorkTable(props: WorkTableProps) {
  const {
    rows,
    timeZone,
    label,
    columns: fixedColumns,
    columnStorageKey = "work-table:columns",
    defaultColumns = [],
    sortable = false,
    appliedSort,
    groupBy = null,
    groups = null,
    rowGroupKeys = null,
    nextCursor = null,
    total,
    query = "",
    selectable = false,
    canOverride = false,
    keyboard = false,
    hidePerson,
    maxHeight,
    empty,
    embedded = false,
    className,
  } = props;

  const router = useRouter();
  const url = useUrlState();
  const chosen = useTableColumns(columnStorageKey, defaultColumns.length ? defaultColumns : ["job"], !fixedColumns);
  const columns = fixedColumns ?? chosen.columns;
  const sort = parseSort(url.get("sort"), url.get("dir")) ?? appliedSort ?? null;
  const containerRef = React.useRef<HTMLDivElement>(null);

  /* ---------------- pages ("Load more") ---------------- */
  const identity = React.useMemo(
    () => `${query}|${nextCursor ?? ""}|${rows.map((r) => `${r.id}:${r.version}`).join(",")}`,
    [query, nextCursor, rows],
  );
  const [extra, setExtra] = React.useState<ExtraPage | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const more = extra && extra.identity === identity ? extra : null;

  const { allRows, allKeys } = React.useMemo(() => {
    if (!more) return { allRows: rows, allKeys: rowGroupKeys };
    const seen = new Set(rows.map((r) => r.id));
    const addRows: JobRow[] = [];
    const addKeys: string[] = [];
    more.rows.forEach((r, i) => {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      addRows.push(r);
      addKeys.push(more.keys[i] ?? "");
    });
    return { allRows: [...rows, ...addRows], allKeys: rowGroupKeys ? [...rowGroupKeys, ...addKeys] : null };
  }, [rows, rowGroupKeys, more]);
  const cursor = more ? more.cursor : nextCursor;

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const qs = `${query}${query ? "&" : ""}cursor=${encodeURIComponent(cursor)}`;
      const page = await api.get<PageResponse>(`/api/jobs?${qs}`);
      setExtra({
        identity,
        rows: [...(more?.rows ?? []), ...page.rows],
        keys: [...(more?.keys ?? []), ...(page.rowGroupKeys ?? page.rows.map(() => ""))],
        cursor: page.nextCursor,
      });
    } catch (err) {
      toast.error("Couldn't load more jobs", errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  /* ---------------- groups ---------------- */
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set());
  const sections = React.useMemo(() => {
    if (!groupBy || !groups || !allKeys) return [{ key: "__all__", label: "", count: allRows.length, rows: allRows }];
    const byKey = new Map<string, JobRow[]>();
    allRows.forEach((r, i) => {
      const k = allKeys[i] ?? "";
      byKey.set(k, [...(byKey.get(k) ?? []), r]);
    });
    const ordered = groups.filter((g) => byKey.has(g.key)).map((g) => ({ ...g, rows: byKey.get(g.key) ?? [] }));
    // Rows whose group the server did not list (should not happen) still show.
    const known = new Set(groups.map((g) => g.key));
    for (const [k, list] of byKey) if (!known.has(k)) ordered.push({ key: k, label: k || "Other", count: list.length, rows: list });
    return ordered;
  }, [groupBy, groups, allKeys, allRows]);
  const grouped = sections.length > 0 && sections[0].key !== "__all__";

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const visibleRows = React.useMemo(
    () => sections.flatMap((s) => (collapsed.has(s.key) ? [] : s.rows)),
    [sections, collapsed],
  );

  /* ---------------- selection ---------------- */
  const [selectedIds, setSelectedIds] = React.useState<ReadonlySet<string>>(new Set());
  const loadedIds = React.useMemo(() => new Set(allRows.map((r) => r.id)), [allRows]);
  const selectedRows = React.useMemo(() => allRows.filter((r) => selectedIds.has(r.id)), [allRows, selectedIds]);
  const allSelected = selectable && allRows.length > 0 && selectedRows.length === allRows.length;
  const someSelected = selectedRows.length > 0 && !allSelected;

  const toggleRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(loadedIds));
  const toggleSection = (sectionRows: JobRow[]) => {
    const everyOn = sectionRows.every((r) => selectedIds.has(r.id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const r of sectionRows) {
        if (everyOn) next.delete(r.id);
        else next.add(r.id);
      }
      return next;
    });
  };

  /* ---------------- keyboard ---------------- */
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const activeFocusId = focusedId && visibleRows.some((r) => r.id === focusedId) ? focusedId : null;

  const focusRow = (id: string) => {
    setFocusedId(id);
    requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector<HTMLElement>(`tr[data-row-id="${CSS.escape(id)}"]`);
      el?.focus({ preventScroll: false });
      el?.scrollIntoView({ block: "nearest" });
    });
  };

  const step = (delta: 1 | -1) => {
    if (visibleRows.length === 0) return;
    const index = activeFocusId ? visibleRows.findIndex((r) => r.id === activeFocusId) : -1;
    const next = index === -1 ? (delta === 1 ? 0 : visibleRows.length - 1) : Math.min(visibleRows.length - 1, Math.max(0, index + delta));
    focusRow(visibleRows[next].id);
  };

  const openJob = (row: JobRow, newTab = false) => {
    const href = jobHref(row.id);
    if (newTab) window.open(href, "_blank", "noopener");
    else router.push(href);
  };

  useHotkeys(
    {
      j: () => step(1),
      k: () => step(-1),
      x: () => {
        if (selectable && activeFocusId) toggleRow(activeFocusId);
      },
      esc: () => {
        if (selectedIds.size > 0) setSelectedIds(new Set());
      },
    },
    { enabled: keyboard },
  );

  const onRowClick = (event: React.MouseEvent, row: JobRow) => {
    if ((event.target as HTMLElement).closest(INTERACTIVE)) return;
    if (window.getSelection()?.toString()) return; // let people copy text
    openJob(row, event.metaKey || event.ctrlKey);
  };

  const onRowKeyDown = (event: React.KeyboardEvent, row: JobRow) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter") {
      event.preventDefault();
      openJob(row, event.metaKey || event.ctrlKey);
    } else if (event.key === " " && selectable) {
      event.preventDefault();
      toggleRow(row.id);
    }
  };

  const onSort = (column: JobTableColumn) => {
    url.patch({ sort: sortParam(nextSort(sort, column)), dir: null });
  };

  /* ---------------- render ---------------- */
  if (rows.length === 0 && empty) {
    return <Card className={cn("overflow-hidden", className)}>{empty}</Card>;
  }

  const colCount = columns.length;
  const shownCount = allRows.length;
  const firstTabRow = activeFocusId ?? visibleRows[0]?.id ?? null;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Desktop / tablet table */}
      <div
        ref={containerRef}
        className={cn(
          "hidden md:block",
          !embedded && "overflow-hidden rounded-lg border border-border bg-surface shadow-xs",
          url.isPending && "opacity-70 transition-opacity",
        )}
        aria-busy={url.isPending || undefined}
      >
        <ScrollFade>
          <Table aria-label={label} maxHeight={maxHeight} density="compact" aria-rowcount={total ?? undefined}>
            <THead>
              <TR className="hover:bg-transparent">
                {columns.map((column) => {
                  const meta = COLUMN_META[column];
                  const isJob = column === "job";
                  const direction = sort?.column === column ? sort.dir : null;
                  if (isJob && selectable) {
                    // Checkbox + sort button side by side (a checkbox may not sit inside the sort <button>).
                    const SortIcon = direction === "asc" ? ArrowUp : direction === "desc" ? ArrowDown : ChevronsUpDown;
                    return (
                      <TH
                        key={column}
                        className={cn(meta.width, "sticky left-0 z-20 bg-surface-sunken p-0 shadow-[inset_-1px_0_0_var(--border)]")}
                        aria-sort={sortable ? (direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none") : undefined}
                      >
                        <span className="flex items-center gap-1 pl-4">
                          <Checkbox
                            size="sm"
                            checked={allSelected}
                            indeterminate={someSelected}
                            onChange={toggleAll}
                            aria-label={allSelected ? "Deselect all loaded jobs" : `Select all ${shownCount} loaded jobs`}
                          />
                          {sortable ? (
                            <button
                              type="button"
                              onClick={() => onSort(column)}
                              className={cn(
                                "group/sort inline-flex items-center gap-1 rounded-xs px-2 py-2 uppercase tracking-wider hover:text-ink focus-ring-inset",
                                direction && "text-ink",
                              )}
                            >
                              <span>{meta.label}</span>
                              <SortIcon
                                aria-hidden="true"
                                className={cn("size-3.5 shrink-0", direction ? "text-accent-ink" : "text-ink-subtle opacity-50 group-hover/sort:opacity-100")}
                              />
                            </button>
                          ) : (
                            <span className="px-2">{meta.label}</span>
                          )}
                        </span>
                      </TH>
                    );
                  }
                  return (
                    <TH
                      key={column}
                      numeric={meta.numeric}
                      sortable={sortable && meta.sortable}
                      sortDirection={direction}
                      onSort={() => onSort(column)}
                      className={cn(meta.width, isJob && "sticky left-0 z-20 bg-surface-sunken shadow-[inset_-1px_0_0_var(--border)]")}
                      title={meta.label}
                    >
                      {meta.label}
                    </TH>
                  );
                })}
              </TR>
            </THead>
            {sections.map((section) => {
              const isCollapsed = collapsed.has(section.key);
              const sectionSelected = selectable && section.rows.length > 0 && section.rows.every((r) => selectedIds.has(r.id));
              return (
                <TBody key={section.key}>
                  {grouped ? (
                    <tr className="border-b border-border bg-surface-sunken/70">
                      <th scope="rowgroup" colSpan={colCount} className="p-0 text-left font-normal">
                        <div className="sticky left-0 flex w-max max-w-[100vw] items-center gap-2 py-1.5 pl-2 pr-4">
                          {selectable ? (
                            <span className="pl-1.5">
                              <Checkbox
                                size="sm"
                                checked={sectionSelected}
                                indeterminate={!sectionSelected && section.rows.some((r) => selectedIds.has(r.id))}
                                onChange={() => toggleSection(section.rows)}
                                aria-label={`Select loaded jobs in ${section.label}`}
                              />
                            </span>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => toggleGroup(section.key)}
                            aria-expanded={!isCollapsed}
                            className="inline-flex items-center gap-2 rounded-sm px-1.5 py-1 text-sm text-ink hover:bg-surface-muted focus-ring"
                          >
                            {isCollapsed ? <ChevronRight aria-hidden="true" className="size-4 text-ink-muted" /> : <ChevronDown aria-hidden="true" className="size-4 text-ink-muted" />}
                            <GroupLabel groupBy={groupBy} section={section} />
                            <Badge size="sm" variant="neutral" className="numeric">
                              {section.count}
                            </Badge>
                            {section.rows.length < section.count ? (
                              <span className="text-xs text-ink-subtle numeric">{section.rows.length} loaded</span>
                            ) : null}
                          </button>
                        </div>
                      </th>
                    </tr>
                  ) : null}
                  {isCollapsed
                    ? null
                    : section.rows.map((row) => {
                        const isSelected = selectedIds.has(row.id);
                        return (
                          <TR
                            key={row.id}
                            data-row-id={row.id}
                            interactive
                            selected={isSelected}
                            tabIndex={firstTabRow === row.id ? 0 : -1}
                            aria-selected={selectable ? isSelected : undefined}
                            onClick={(e) => onRowClick(e, row)}
                            onKeyDown={(e) => onRowKeyDown(e, row)}
                            onFocus={(e) => {
                              if (e.target === e.currentTarget) setFocusedId(row.id);
                            }}
                            className={cn(
                              "group/row outline-none focus-visible:bg-accent-soft/40 focus-visible:shadow-[inset_2px_0_0_var(--accent)]",
                              row.isOverdue && "shadow-[inset_2px_0_0_var(--danger)]",
                            )}
                          >
                            {columns.map((column) => {
                              const meta = COLUMN_META[column];
                              if (column === "job") {
                                return (
                                  <TD
                                    key={column}
                                    className={cn(
                                      // Capped so the identity column never pushes Status / Priority off a 1440 screen (name truncates, full text in its title).
                                      "sticky left-0 z-[1] max-w-[18rem] bg-surface shadow-[inset_-1px_0_0_var(--border)]",
                                      "group-hover/row:bg-[color-mix(in_oklab,var(--surface-muted)_60%,var(--surface))]",
                                      "group-data-[state=selected]/row:bg-[color-mix(in_oklab,var(--accent-soft)_50%,var(--surface))]",
                                      // The opaque sticky cell hides the row's own tint / edge bar, so repeat them here.
                                      row.isOverdue && "shadow-[inset_2px_0_0_var(--danger),inset_-1px_0_0_var(--border)]",
                                      "group-focus-visible/row:bg-[color-mix(in_oklab,var(--accent-soft)_40%,var(--surface))]",
                                      "group-focus-visible/row:shadow-[inset_2px_0_0_var(--accent),inset_0_1px_0_var(--accent),inset_0_-1px_0_var(--accent),inset_-1px_0_0_var(--border)]",
                                    )}
                                  >
                                    <span className="flex min-w-0 items-center gap-3">
                                      {selectable ? (
                                        <Checkbox
                                          size="sm"
                                          checked={isSelected}
                                          onChange={() => toggleRow(row.id)}
                                          aria-label={`Select ${row.jobNumber} ${row.name}`}
                                          tabIndex={-1}
                                        />
                                      ) : null}
                                      <a
                                        href={jobHref(row.id)}
                                        tabIndex={-1}
                                        onClick={(e) => {
                                          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                                          e.preventDefault();
                                          openJob(row);
                                        }}
                                        className="min-w-0 flex-1 rounded-xs focus-ring"
                                      >
                                        <JobIdentity row={row} timeZone={timeZone} />
                                      </a>
                                    </span>
                                  </TD>
                                );
                              }
                              return (
                                <TD key={column} numeric={meta.numeric} className={cn(meta.width, "max-w-[12rem]")}>
                                  <WorkCell column={column} row={row} timeZone={timeZone} />
                                </TD>
                              );
                            })}
                          </TR>
                        );
                      })}
                </TBody>
              );
            })}
          </Table>
        </ScrollFade>
      </div>

      {/* Mobile cards */}
      <div className={cn("md:hidden", !embedded && "overflow-hidden rounded-lg border border-border bg-surface shadow-xs")}>
        {sections.map((section) => {
          const isCollapsed = collapsed.has(section.key);
          return (
            <section key={section.key} aria-label={grouped ? section.label : label}>
              {grouped ? (
                <button
                  type="button"
                  onClick={() => toggleGroup(section.key)}
                  aria-expanded={!isCollapsed}
                  className="flex w-full items-center gap-2 border-b border-border bg-surface-sunken/70 px-3 py-2 text-left text-sm focus-ring-inset"
                >
                  {isCollapsed ? <ChevronRight aria-hidden="true" className="size-4 text-ink-muted" /> : <ChevronDown aria-hidden="true" className="size-4 text-ink-muted" />}
                  <GroupLabel groupBy={groupBy} section={section} />
                  <Badge size="sm" variant="neutral" className="ml-auto numeric">
                    {section.count}
                  </Badge>
                </button>
              ) : null}
              {isCollapsed ? null : (
                <ul className="divide-y divide-border border-b border-border last:border-b-0">
                  {section.rows.map((row) => (
                    <li key={row.id}>
                      <JobCard row={row} timeZone={timeZone} hidePerson={hidePerson} selected={selectedIds.has(row.id)} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {/* Footer: count + load more + key hints */}
      {cursor || (total !== undefined && !embedded) ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-ink-muted">
          <span className="numeric" aria-live="polite">
            {total !== undefined ? `Showing ${shownCount.toLocaleString("en-AU")} of ${pluralise(total, "job")}` : `${pluralise(shownCount, "job")}`}
          </span>
          <div className="flex items-center gap-3">
            {keyboard ? (
              <span className="hidden items-center gap-1.5 lg:flex" aria-hidden="true">
                <Kbd>j</Kbd>
                <Kbd>k</Kbd> move
                {selectable ? (
                  <>
                    <Kbd className="ml-1.5">x</Kbd> select
                  </>
                ) : null}
                <Kbd className="ml-1.5">↵</Kbd> open
              </span>
            ) : null}
            {cursor ? (
              <Button size="sm" variant="outline" onClick={loadMore} loading={loadingMore} leadingIcon={<ChevronsDown aria-hidden="true" />}>
                Load more
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {selectable ? (
        <BulkActions
          selected={selectedRows}
          canOverride={canOverride}
          onClear={() => setSelectedIds(new Set())}
          onKeep={(ids) => setSelectedIds(new Set(ids))}
        />
      ) : null}
    </div>
  );
}

function GroupLabel({ groupBy, section }: { groupBy: WorkGroupBy | null; section: { key: string; label: string; rows: JobRow[] } }) {
  const first = section.rows[0];
  switch (groupBy) {
    case "status":
      return first ? <StatusPill status={first.status} size="sm" /> : <span className="font-medium">{section.label}</span>;
    case "editor":
      return <PersonChip user={first?.editor ?? null} size="xs" emptyLabel="Unassigned" />;
    case "photographer":
      return <PersonChip user={first?.photographer ?? null} size="xs" emptyLabel="No photographer" />;
    case "priority":
      return first ? <PriorityPill priority={first.priority} size="sm" /> : <span className="font-medium">{section.label}</span>;
    case "jobType":
      return (
        <span className="flex items-center gap-2 font-medium">
          {first ? <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: first.jobType.colour }} /> : null}
          {section.label}
        </span>
      );
    case "dueDate":
      return (
        <span
          className={cn(
            "font-medium",
            section.key === "overdue" && "text-danger-fg",
            section.key === "today" && "text-attention-fg",
            section.key === "tomorrow" && "text-warning-fg",
          )}
        >
          {section.label}
        </span>
      );
    default:
      return <span className="font-medium">{section.label}</span>;
  }
}
