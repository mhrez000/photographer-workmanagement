"use client";

import * as React from "react";
import { CalendarRange, Hash, ListFilter, UserRound, X } from "lucide-react";
import { MultiSelect, type MultiSelectOption } from "@/components/filters/multi-select";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useUrlState } from "@/hooks/use-url-state";
import { todayCivil, addCivilDays } from "@/lib/dates";
import { cn } from "@/lib/utils";

export interface ActivityFilterPerson {
  id: string;
  name: string;
  colour: string;
  isActive: boolean;
  role: string;
}

export interface ActivityFiltersProps {
  people: ActivityFilterPerson[];
  groups: { key: string; label: string; description: string }[];
  timeZone: string;
  className?: string;
}

const RANGE_OPTIONS = [
  { value: "", label: "Any date" },
  { value: "today", label: "Today" },
  { value: "this_week", label: "This week" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "last_7_days", label: "Last 7 days" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "custom", label: "Custom range…" },
] as const;

const FILTER_KEYS = ["userId", "events", "job", "jobId", "range", "from", "to"] as const;

/** URL-driven filters for /activity: person, event groups, job number, date range. */
export function ActivityFilters({ people, groups, timeZone, className }: ActivityFiltersProps) {
  const url = useUrlState();
  const userId = url.get("userId");
  const events = url.getAll("events");
  const range = url.get("range") ?? "";
  const jobParam = url.get("job") ?? "";

  const today = todayCivil(timeZone);
  const from = url.get("from") ?? addCivilDays(today, -29);
  const to = url.get("to") ?? today;

  const personOptions: MultiSelectOption[] = people.map((p) => ({
    value: p.id,
    label: p.isActive ? p.name : `${p.name} (inactive)`,
    description: p.role.charAt(0).toUpperCase() + p.role.slice(1),
    avatar: { name: p.name, colour: p.isActive ? p.colour : null },
  }));
  const groupOptions: MultiSelectOption[] = groups.map((g) => ({ value: g.key, label: g.label, description: g.description }));
  const active = FILTER_KEYS.some((k) => url.has(k));

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)} role="group" aria-label="Activity filters">
      <MultiSelect
        label="Person"
        icon={UserRound}
        single
        searchable
        options={personOptions}
        value={userId ? [userId] : []}
        onChange={(next) => url.set("userId", next[0] ?? null)}
      />
      <MultiSelect
        label="Event"
        icon={ListFilter}
        options={groupOptions}
        value={events}
        onChange={(next) => url.set("events", next)}
      />
      <JobNumberFilter key={jobParam} initial={jobParam} onCommit={(v) => url.patch({ job: v || null, jobId: null })} />
      <label className="relative inline-flex items-center">
        <span className="sr-only">Date range</span>
        <CalendarRange aria-hidden="true" className="pointer-events-none absolute left-2.5 size-3.5 text-ink-muted" />
        <select
          value={range}
          onChange={(e) => {
            const v = e.target.value;
            url.patch({ range: v || null, from: v === "custom" ? from : null, to: v === "custom" ? to : null });
          }}
          className={cn(
            "h-8 appearance-none rounded-sm border border-border bg-surface pl-8 pr-7 text-sm text-ink shadow-xs focus-ring hover:border-border-hover",
            range && "border-accent/40 bg-accent-soft/50 text-accent-ink",
          )}
        >
          {RANGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span aria-hidden="true" className="pointer-events-none absolute right-2.5 text-2xs text-ink-subtle">
          ▾
        </span>
      </label>
      {range === "custom" ? (
        <div className="flex items-center gap-1.5">
          <DateInput size="sm" aria-label="From" value={from} max={to} onChange={(e) => e.target.value && url.set("from", e.target.value)} />
          <span className="text-xs text-ink-subtle">to</span>
          <DateInput size="sm" aria-label="To" value={to} min={from} onChange={(e) => e.target.value && url.set("to", e.target.value)} />
        </div>
      ) : null}
      {active ? (
        <Button variant="ghost" size="sm" leadingIcon={<X aria-hidden="true" />} onClick={() => url.clear([...FILTER_KEYS])}>
          Clear
        </Button>
      ) : null}
      {url.isPending ? <Spinner size="xs" className="text-ink-subtle" label="Updating" /> : null}
    </div>
  );
}

/** Job-number box; remounted (via `key`) whenever the URL value changes. */
function JobNumberFilter({ initial, onCommit }: { initial: string; onCommit: (value: string) => void }) {
  const [job, setJob] = React.useState(initial);
  const commit = () => {
    const v = job.trim().toUpperCase();
    if (v !== initial) onCommit(v);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
      className="w-40"
      role="search"
      aria-label="Filter by job number"
    >
      <Input
        size="sm"
        mono
        value={job}
        onChange={(e) => setJob(e.target.value)}
        onBlur={commit}
        placeholder="PJ-0042"
        aria-label="Job number"
        leading={<Hash aria-hidden="true" />}
      />
    </form>
  );
}
