"use client";

import * as React from "react";
import { Building2, Camera, CircleDot, Flag, Shapes, SlidersHorizontal, UserRoundPen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useUrlState } from "@/hooks/use-url-state";
import { api } from "@/lib/api-client";
import {
  PRIORITIES,
  PRIORITY_META,
  QUICK_FILTERS,
  STATUS_CATEGORIES,
  STATUS_CATEGORY_META,
  type QuickFilter,
  type StatusCategory,
} from "@/lib/constants";
import type { ClientRef, JobTypeRef, UserRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MultiSelect, type MultiSelectOption } from "./multi-select";
import { JOB_FILTER_KEYS, QUICK_FILTER_LABELS, QUICK_FILTER_TONES } from "./quick-filters";

export type FilterFacet = "statusCategory" | "editor" | "photographer" | "client" | "jobType" | "priority";

/** Pre-loaded facet options (server pages pass these; otherwise people/clients load on open). */
export interface FilterOptions {
  editors?: Pick<UserRef, "id" | "name" | "avatarColour">[];
  photographers?: Pick<UserRef, "id" | "name" | "avatarColour">[];
  clients?: ClientRef[];
  jobTypes?: JobTypeRef[];
  /** Restrict the status categories offered. */
  statusCategories?: readonly StatusCategory[];
}

export interface FilterBarProps {
  /** Quick-filter chips to show (default: all QUICK_FILTERS). Pass [] to hide. */
  quickFilters?: readonly QuickFilter[];
  /** Facet popovers to show (default: all). */
  facets?: readonly FilterFacet[];
  options?: FilterOptions;
  /** Show the search box (writes ?q=). Default true. */
  showSearch?: boolean;
  searchPlaceholder?: string;
  /** Allow several quick filters at once (default false: chips act like tabs). */
  multiQuick?: boolean;
  /** Extra controls on the right (date range, saved views, view toggles). */
  trailing?: React.ReactNode;
  /** Bind "f" to focus the search box (default true). */
  hotkey?: boolean;
  className?: string;
}

const FACET_KEYS: Record<FilterFacet, string> = {
  statusCategory: "statusCategory",
  editor: "editorId",
  photographer: "photographerId",
  client: "clientId",
  jobType: "jobTypeId",
  priority: "priority",
};

const ALL_FACETS: readonly FilterFacet[] = ["statusCategory", "editor", "photographer", "client", "jobType", "priority"];

type LazyState = { status: "idle" | "loading" | "ready" | "error"; options: MultiSelectOption[] };

function rows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === "object") {
    for (const key of ["items", "options", "users", "clients", "rows"]) {
      const v = (payload as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

function peopleOptions(list: Pick<UserRef, "id" | "name" | "avatarColour">[]): MultiSelectOption[] {
  return list.map((u) => ({ value: u.id, label: u.name, avatar: { name: u.name, colour: u.avatarColour } }));
}

/** Loads facet options from an `/options` route the first time a popover opens. */
function useLazyOptions(url: string, map: (row: Record<string, unknown>) => MultiSelectOption | null, preset?: MultiSelectOption[]) {
  const [state, setState] = React.useState<LazyState>({ status: preset ? "ready" : "idle", options: preset ?? [] });
  const load = React.useCallback(() => {
    if (preset || state.status === "loading" || state.status === "ready") return;
    setState({ status: "loading", options: [] });
    api
      .get<unknown>(url)
      .then((payload) => setState({ status: "ready", options: rows(payload).map(map).filter((o): o is MultiSelectOption => o !== null) }))
      .catch(() => setState({ status: "error", options: [] }));
  }, [preset, state.status, url, map]);
  return { options: preset ?? state.options, loading: state.status === "loading", load };
}

const mapUser = (r: Record<string, unknown>): MultiSelectOption | null => {
  const u = (r.user && typeof r.user === "object" ? r.user : r) as Record<string, unknown>;
  if (typeof u.id !== "string" || typeof u.name !== "string") return null;
  return { value: u.id, label: u.name, avatar: { name: u.name, colour: typeof u.avatarColour === "string" ? u.avatarColour : null } };
};

const mapClient = (r: Record<string, unknown>): MultiSelectOption | null =>
  typeof r.id === "string" && typeof r.name === "string" ? { value: r.id, label: r.name } : null;

/**
 * Job list filters driven by URL search params (shareable, back-button safe):
 * debounced search → ?q=, quick-filter chips → ?quick=, facet popovers →
 * ?statusCategory= / ?editorId= / ?photographerId= / ?clientId= / ?jobTypeId= /
 * ?priority= (comma lists). "Clear all" removes every filter key.
 */
export function FilterBar({
  quickFilters = QUICK_FILTERS,
  facets = ALL_FACETS,
  options = {},
  showSearch = true,
  searchPlaceholder = "Search jobs, clients, notes…",
  multiQuick = false,
  trailing,
  hotkey = true,
  className,
}: FilterBarProps) {
  const url = useUrlState();
  const searchRef = React.useRef<HTMLInputElement>(null);
  const urlQ = url.get("q") ?? "";
  // Local text so typing never waits for the round trip; re-synced when the URL changes elsewhere.
  const [text, setText] = React.useState(urlQ);
  const [syncedQ, setSyncedQ] = React.useState(urlQ);
  if (urlQ !== syncedQ) {
    setSyncedQ(urlQ);
    setText(urlQ);
  }

  useHotkeys({ f: () => searchRef.current?.focus() }, { enabled: hotkey && showSearch });

  const editorPreset = React.useMemo(() => (options.editors ? peopleOptions(options.editors) : undefined), [options.editors]);
  const photographerPreset = React.useMemo(
    () => (options.photographers ? peopleOptions(options.photographers) : undefined),
    [options.photographers],
  );
  const clientPreset = React.useMemo(
    () => (options.clients ? options.clients.map((c) => ({ value: c.id, label: c.name })) : undefined),
    [options.clients],
  );
  const editors = useLazyOptions("/api/users/options?role=editor", mapUser, editorPreset);
  const photographers = useLazyOptions("/api/users/options?role=photographer", mapUser, photographerPreset);
  const clients = useLazyOptions("/api/clients/options", mapClient, clientPreset);

  const statusOptions: MultiSelectOption[] = (options.statusCategories ?? STATUS_CATEGORIES).map((c) => ({
    value: c,
    label: STATUS_CATEGORY_META[c].label,
    colour: STATUS_CATEGORY_META[c].hex,
  }));
  const priorityOptions: MultiSelectOption[] = [...PRIORITIES].reverse().map((p) => ({
    value: p,
    label: PRIORITY_META[p].label,
    colour: PRIORITY_META[p].hex,
  }));
  const jobTypeOptions: MultiSelectOption[] = (options.jobTypes ?? []).map((t) => ({ value: t.id, label: t.name, colour: t.colour }));

  const quick = url.getAll("quick");
  const facetValues = (facet: FilterFacet) => url.getAll(FACET_KEYS[facet]);
  const activeCount =
    (urlQ ? 1 : 0) +
    quick.length +
    facets.reduce((n, f) => n + (facetValues(f).length > 0 ? 1 : 0), 0) +
    (url.get("dueFrom") || url.get("dueTo") ? 1 : 0);

  const toggleQuick = (q: QuickFilter) => {
    const on = quick.includes(q);
    const next = multiQuick ? (on ? quick.filter((x) => x !== q) : [...quick, q]) : on ? [] : [q];
    url.patch({ quick: next, viewId: null });
  };

  const setFacet = (facet: FilterFacet, next: string[]) => url.patch({ [FACET_KEYS[facet]]: next, viewId: null });

  const facetEl = (facet: FilterFacet) => {
    switch (facet) {
      case "statusCategory":
        return <MultiSelect key={facet} label="Status" icon={CircleDot} options={statusOptions} value={facetValues(facet)} onChange={(v) => setFacet(facet, v)} />;
      case "editor":
        return (
          <MultiSelect
            key={facet}
            label="Editor"
            icon={UserRoundPen}
            options={[{ value: "none", label: "No editor" }, ...editors.options]}
            loading={editors.loading}
            onOpen={editors.load}
            searchable
            value={facetValues(facet)}
            onChange={(v) => setFacet(facet, v)}
          />
        );
      case "photographer":
        return (
          <MultiSelect
            key={facet}
            label="Photographer"
            icon={Camera}
            options={[{ value: "none", label: "No photographer" }, ...photographers.options]}
            loading={photographers.loading}
            onOpen={photographers.load}
            searchable
            value={facetValues(facet)}
            onChange={(v) => setFacet(facet, v)}
          />
        );
      case "client":
        return (
          <MultiSelect
            key={facet}
            label="Client"
            icon={Building2}
            options={clients.options}
            loading={clients.loading}
            onOpen={clients.load}
            searchable
            value={facetValues(facet)}
            onChange={(v) => setFacet(facet, v)}
          />
        );
      case "jobType":
        return jobTypeOptions.length > 0 ? (
          <MultiSelect key={facet} label="Job type" icon={Shapes} options={jobTypeOptions} value={facetValues(facet)} onChange={(v) => setFacet(facet, v)} />
        ) : null;
      case "priority":
        return <MultiSelect key={facet} label="Priority" icon={Flag} options={priorityOptions} value={facetValues(facet)} onChange={(v) => setFacet(facet, v)} />;
      default:
        return null;
    }
  };

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)} role="search" aria-label="Filter jobs">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {showSearch ? (
          <SearchInput
            ref={searchRef}
            value={text}
            onValueChange={setText}
            debounce={300}
            onDebouncedChange={(v) => {
              if (v.trim() !== urlQ) url.patch({ q: v.trim() || null, viewId: null });
            }}
            onClear={() => url.patch({ q: null })}
            placeholder={searchPlaceholder}
            shortcut={hotkey ? "F" : undefined}
            aria-label="Search"
            wrapperClassName="sm:w-72"
            size="sm"
          />
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          {facets.map(facetEl)}
          {activeCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<X />}
              onClick={() => {
                setText("");
                url.clear([...JOB_FILTER_KEYS, "viewId"]);
              }}
            >
              Clear all
              <span className="numeric text-ink-subtle">({activeCount})</span>
            </Button>
          ) : null}
          {url.isPending ? <Spinner size="xs" label="Updating results" className="ml-1 text-ink-subtle" /> : null}
        </div>
        {trailing ? <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{trailing}</div> : null}
      </div>

      {quickFilters.length > 0 ? (
        <div className="-mx-4 overflow-x-auto px-4 scrollbar-none sm:mx-0 sm:px-0">
          <div className="flex w-max items-center gap-1.5 sm:w-auto sm:flex-wrap" role="group" aria-label="Quick filters">
            <SlidersHorizontal aria-hidden="true" className="mr-0.5 size-3.5 shrink-0 text-ink-subtle" />
            {quickFilters.map((q) => {
              const on = quick.includes(q);
              const tone = QUICK_FILTER_TONES[q];
              return (
                <button
                  key={q}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleQuick(q)}
                  className={cn(
                    "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors focus-ring",
                    on
                      ? tone === "danger"
                        ? "border-danger/40 bg-danger-soft text-danger-fg"
                        : tone === "attention"
                          ? "border-attention/40 bg-attention-soft text-attention-fg"
                          : "border-accent/40 bg-accent-soft text-accent-ink"
                      : "border-border bg-surface text-ink-secondary hover:border-border-hover hover:bg-surface-muted",
                  )}
                >
                  {tone && !on ? (
                    <span
                      aria-hidden="true"
                      className={cn("size-1.5 rounded-full", tone === "danger" ? "bg-danger" : tone === "attention" ? "bg-attention" : "bg-warning")}
                    />
                  ) : null}
                  {QUICK_FILTER_LABELS[q]}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
