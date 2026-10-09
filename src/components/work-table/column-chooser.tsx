"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Columns3, Lock, RotateCcw } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { JOB_TABLE_COLUMNS, type JobTableColumn } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { COLUMN_META } from "./columns";
import { useTableColumns } from "./use-table-columns";

export interface ColumnChooserProps {
  storageKey: string;
  defaults: readonly JobTableColumn[];
  className?: string;
}

/** Show / hide / reorder table columns (persisted in the URL + localStorage). */
export function ColumnChooser({ storageKey, defaults, className }: ColumnChooserProps) {
  const { columns, source, setColumns } = useTableColumns(storageKey, defaults);
  const hidden = JOB_TABLE_COLUMNS.filter((c) => !columns.includes(c));
  const [announce, setAnnounce] = React.useState("");

  const toggle = (column: JobTableColumn) => {
    if (COLUMN_META[column].locked) return;
    if (columns.includes(column)) {
      setColumns(columns.filter((c) => c !== column));
      setAnnounce(`${COLUMN_META[column].label} hidden`);
    } else {
      setColumns([...columns, column]);
      setAnnounce(`${COLUMN_META[column].label} shown`);
    }
  };

  const move = (column: JobTableColumn, delta: -1 | 1) => {
    const index = columns.indexOf(column);
    const target = index + delta;
    // "job" stays first.
    if (index < 1 || target < 1 || target >= columns.length) return;
    const next = [...columns];
    [next[index], next[target]] = [next[target], next[index]];
    setColumns(next);
    setAnnounce(`${COLUMN_META[column].label} moved to position ${target + 1}`);
  };

  const isDefault = source === "default" || (columns.length === defaults.length && columns.every((c, i) => c === defaults[i]));

  return (
    <Popover className={className}>
      <PopoverTrigger variant="outline" size="sm" leadingIcon={<Columns3 aria-hidden="true" />} aria-label={`Columns (${columns.length} shown)`}>
        <span className="hidden sm:inline">Columns</span>
        <span className="numeric text-xs text-ink-muted">{columns.length}</span>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Choose columns" className="w-72 p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
          <span className="eyebrow">Columns</span>
          <button
            type="button"
            onClick={() => {
              setColumns(null);
              setAnnounce("Columns reset to default");
            }}
            disabled={isDefault}
            className="inline-flex items-center gap-1 rounded-xs text-xs text-ink-muted hover:text-ink focus-ring disabled:pointer-events-none disabled:opacity-40"
          >
            <RotateCcw aria-hidden="true" className="size-3" />
            Reset
          </button>
        </div>
        <ul className="max-h-[min(60vh,26rem)] overflow-y-auto scrollbar-thin py-1" aria-label="Visible columns, in order">
          {columns.map((column, index) => {
            const meta = COLUMN_META[column];
            return (
              <li key={column} className="group/col flex items-center gap-1 px-2 py-0.5 hover:bg-surface-muted/60">
                {meta.locked ? (
                  <span className="flex flex-1 items-center gap-2.5 px-1 py-1 text-base text-ink">
                    <Lock aria-hidden="true" className="size-3.5 text-ink-subtle" />
                    {meta.label}
                    <span className="text-2xs text-ink-subtle">always shown</span>
                  </span>
                ) : (
                  <Checkbox size="sm" checked onChange={() => toggle(column)} label={meta.label} wrapperClassName="flex-1 px-1 py-1" />
                )}
                {!meta.locked ? (
                  <span className="flex items-center opacity-60 transition-opacity group-hover/col:opacity-100 group-focus-within/col:opacity-100">
                    <IconButton size="xs" label={`Move ${meta.label} left`} disabled={index <= 1} onClick={() => move(column, -1)}>
                      <ArrowUp aria-hidden="true" />
                    </IconButton>
                    <IconButton size="xs" label={`Move ${meta.label} right`} disabled={index >= columns.length - 1} onClick={() => move(column, 1)}>
                      <ArrowDown aria-hidden="true" />
                    </IconButton>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
        {hidden.length > 0 ? (
          <div className="border-t border-border py-1">
            <div className="px-3 pb-1 pt-2 eyebrow">Hidden</div>
            <ul aria-label="Hidden columns">
              {hidden.map((column) => (
                <li key={column} className="px-2 py-0.5 hover:bg-surface-muted/60">
                  <Checkbox
                    size="sm"
                    checked={false}
                    onChange={() => toggle(column)}
                    label={<span className="text-ink-secondary">{COLUMN_META[column].label}</span>}
                    wrapperClassName="w-full px-1 py-1"
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p aria-live="polite" className={cn("sr-only")}>
          {announce}
        </p>
      </PopoverContent>
    </Popover>
  );
}
