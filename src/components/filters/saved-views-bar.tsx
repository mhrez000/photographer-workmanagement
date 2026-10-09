"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Bookmark, BookmarkPlus, Ellipsis, Pencil, RefreshCw, Share2, Star, Trash2, Users } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { useUrlState, splitParamValues } from "@/hooks/use-url-state";
import { api } from "@/lib/api-client";
import { JOB_TABLE_COLUMNS, type JobTableColumn, type SavedViewScope } from "@/lib/constants";
import type { SavedViewConfig, SavedViewItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { firstFieldErrors, useMutationRunner, type FieldErrors } from "@/components/jobs/mutation";

/** Params that are view plumbing, not filters. */
const NON_FILTER_KEYS = new Set(["viewId", "cursor", "sort", "groupBy", "columns", "tab", "limit"]);
const GROUP_BY = ["status", "editor", "photographer", "client", "priority", "dueDate", "jobType"] as const;

/** Builds a saved-view config from the current URL. */
export function configFromParams(params: URLSearchParams, defaultColumns: readonly JobTableColumn[] = []): SavedViewConfig {
  const filters: SavedViewConfig["filters"] = {};
  for (const key of new Set(params.keys())) {
    if (NON_FILTER_KEYS.has(key)) continue;
    const values = splitParamValues(params.getAll(key));
    if (values.length === 0) continue;
    filters[key] = values.length === 1 && !["quick", "statusCategory", "statusId", "editorId", "photographerId", "clientId", "projectId", "jobTypeId", "priority"].includes(key) ? values[0] : values;
  }
  const sort = splitParamValues(params.getAll("sort"))
    .map((s) => {
      const desc = s.startsWith("-");
      const [column, dir] = (desc ? s.slice(1) : s).split(":");
      return { column, dir: (desc || dir === "desc" ? "desc" : "asc") as "asc" | "desc" };
    })
    .filter((s) => s.column)
    .slice(0, 5);
  const groupByRaw = params.get("groupBy");
  const groupBy = (GROUP_BY as readonly string[]).includes(groupByRaw ?? "") ? (groupByRaw as SavedViewConfig["groupBy"]) : null;
  const urlColumns = splitParamValues(params.getAll("columns")).filter((c): c is JobTableColumn => (JOB_TABLE_COLUMNS as readonly string[]).includes(c));
  return { filters, sort, groupBy, columns: urlColumns.length > 0 ? urlColumns : [...defaultColumns] };
}

/** The URL query a saved view stands for (its filters, sort, grouping, columns + viewId). */
export function queryFromView(view: Pick<SavedViewItem, "id" | "config">): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(view.config.filters ?? {})) {
    if (value === null || value === false || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length > 0) next.set(key, value.join(","));
    } else next.set(key, value === true ? "1" : String(value));
  }
  if (view.config.sort?.length) next.set("sort", view.config.sort.map((s) => `${s.column}:${s.dir}`).join(","));
  if (view.config.groupBy) next.set("groupBy", view.config.groupBy);
  if (view.config.columns?.length) next.set("columns", view.config.columns.join(","));
  next.set("viewId", view.id);
  return next.toString();
}

function rowsOf(payload: unknown): SavedViewItem[] {
  if (Array.isArray(payload)) return payload as SavedViewItem[];
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    for (const key of ["items", "views"]) if (Array.isArray(p[key])) return p[key] as SavedViewItem[];
  }
  return [];
}

/** Views for a scope, or null when the request failed (the bar is an enhancement, never a blocker). */
async function fetchViews(scope: SavedViewScope): Promise<SavedViewItem[] | null> {
  try {
    const payload = await api.get<unknown>("/api/views", { query: { scope } });
    return rowsOf(payload).filter((v) => !v.archivedAt);
  } catch {
    return null;
  }
}

export interface SavedViewsBarProps {
  scope: SavedViewScope;
  /** Actor may share views with the organisation (`saved_view.share`: owners / managers). */
  canShare?: boolean;
  /** Views loaded server-side (`listSavedViews`); otherwise fetched from `GET /api/views?scope=`. */
  initialViews?: SavedViewItem[];
  /** Columns stored with a new view when the URL has none. */
  defaultColumns?: readonly JobTableColumn[];
  className?: string;
}

type NameDialog = { mode: "create" } | { mode: "rename"; view: SavedViewItem } | null;

/**
 * Saved views for a list (spec §20): one chip per view (own first, then
 * shared); applying navigates to the view's stored query. "Save view" stores
 * the current filters; owners of a view can rename, update, share and delete.
 */
export function SavedViewsBar({ scope, canShare = false, initialViews, defaultColumns = [], className }: SavedViewsBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const url = useUrlState();
  const run = useMutationRunner();
  const [views, setViews] = React.useState<SavedViewItem[]>(initialViews ?? []);
  const [loaded, setLoaded] = React.useState(Boolean(initialViews));
  const [prevInitial, setPrevInitial] = React.useState(initialViews);
  if (initialViews !== prevInitial) {
    setPrevInitial(initialViews);
    if (initialViews) setViews(initialViews);
  }
  const [nameDialog, setNameDialog] = React.useState<NameDialog>(null);
  const [deleting, setDeleting] = React.useState<SavedViewItem | null>(null);

  const reload = React.useCallback(async () => {
    const list = await fetchViews(scope);
    if (list) setViews(list);
    setLoaded(true);
  }, [scope]);

  React.useEffect(() => {
    if (initialViews) return undefined;
    let cancelled = false;
    fetchViews(scope).then((list) => {
      if (cancelled) return;
      if (list) setViews(list);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [initialViews, scope]);

  const activeId = url.get("viewId");
  const active = views.find((v) => v.id === activeId) ?? null;
  const currentConfig = configFromParams(url.params, defaultColumns);
  const hasFilters = Object.keys(currentConfig.filters).length > 0 || currentConfig.sort.length > 0 || Boolean(currentConfig.groupBy);

  const apply = (view: SavedViewItem) => router.replace(`${pathname}?${queryFromView(view)}`, { scroll: false });
  const clearView = () => router.replace(pathname, { scroll: false });

  const afterChange = async () => {
    await reload();
    router.refresh();
  };

  const patchView = async (view: SavedViewItem, patch: Record<string, unknown>, success: string) => {
    const result = await run(() => api.patch(`/api/views/${view.id}`, { viewId: view.id, expectedVersion: view.version, ...patch }), {
      success,
      noRefresh: true,
    });
    if (result.ok) await afterChange();
    return result;
  };

  const mine = views.filter((v) => v.isMine);
  const shared = views.filter((v) => !v.isMine);
  const ordered = [...mine, ...shared];

  if (!loaded && views.length === 0) {
    return <div className={cn("h-8", className)} aria-hidden="true" />;
  }

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <div className="-mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 py-0.5 scrollbar-none" role="group" aria-label="Saved views">
        <ViewChip label="All" active={!activeId} onClick={clearView} />
        {ordered.map((v) => (
          <ViewChip
            key={v.id}
            label={v.name}
            active={v.id === activeId}
            shared={v.isShared}
            isDefault={v.isDefault && v.isMine}
            title={v.isMine ? (v.isShared ? "Your view · shared with the team" : "Your view") : `Shared by ${v.owner?.name ?? "a teammate"}`}
            onClick={() => apply(v)}
          />
        ))}
      </div>

      {active && active.isMine ? (
        <DropdownMenu>
          <DropdownMenuTrigger variant="ghost" size="sm" aria-label={`Manage view ${active.name}`} className="w-8 px-0">
            <Ellipsis aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width="14rem" aria-label="Manage view">
            <DropdownMenuItem
              icon={<RefreshCw />}
              onSelect={() => void patchView(active, { config: currentConfig }, `“${active.name}” updated`)}
            >
              Update with current filters
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Pencil />} onSelect={() => setNameDialog({ mode: "rename", view: active })}>
              Rename…
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Star />}
              onSelect={() => void patchView(active, { isDefault: !active.isDefault }, active.isDefault ? "No longer your default" : "Set as your default view")}
            >
              {active.isDefault ? "Remove as default" : "Make my default"}
            </DropdownMenuItem>
            {canShare ? (
              <DropdownMenuItem
                icon={<Share2 />}
                onSelect={() => void patchView(active, { isShared: !active.isShared }, active.isShared ? "View is now private" : "View shared with the team")}
              >
                {active.isShared ? "Stop sharing" : "Share with team"}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<Trash2 />} destructive onSelect={() => setDeleting(active)}>
              Delete view…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <Button
        variant="ghost"
        size="sm"
        leadingIcon={<BookmarkPlus />}
        onClick={() => setNameDialog({ mode: "create" })}
        disabled={!hasFilters}
        title={hasFilters ? "Save the current filters as a view" : "Add a filter or sort first"}
        className="shrink-0"
      >
        <span className="max-sm:sr-only">Save view</span>
      </Button>

      <ViewNameDialog
        state={nameDialog}
        onClose={() => setNameDialog(null)}
        canShare={canShare}
        onSubmit={async ({ name, isShared, isDefault }) => {
          if (nameDialog?.mode === "rename") {
            const r = await patchView(nameDialog.view, { name }, "View renamed");
            return r.ok ? true : r.fieldErrors ? { fieldErrors: r.fieldErrors } : false;
          }
          const result = await run(
            () => api.post<SavedViewItem>("/api/views", { name, scope, config: currentConfig, isShared: canShare ? isShared : undefined, isDefault }),
            { success: `Saved “${name}”`, noRefresh: true },
          );
          if (!result.ok) return result.fieldErrors ? { fieldErrors: result.fieldErrors } : false;
          await reload();
          if (result.data && typeof result.data === "object" && "id" in result.data) {
            url.patch({ viewId: (result.data as SavedViewItem).id });
          }
          return true;
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        title={`Delete “${deleting?.name ?? "view"}”?`}
        description={deleting?.isShared ? "It is shared, so it will disappear for your whole team as well." : "Only the saved view is removed — no jobs change."}
        confirmLabel="Delete view"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const result = await run(
            () => api.delete(`/api/views/${deleting.id}`, { query: { expectedVersion: deleting.version } }),
            { success: "View deleted", noRefresh: true },
          );
          if (!result.ok) return false;
          if (activeId === deleting.id) clearView();
          await afterChange();
          return true;
        }}
      />
    </div>
  );
}

function ViewChip({
  label,
  active,
  shared,
  isDefault,
  title,
  onClick,
}: {
  label: string;
  active: boolean;
  shared?: boolean;
  isDefault?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 max-w-48 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors focus-ring",
        active ? "bg-surface text-ink shadow-xs ring-1 ring-border" : "text-ink-muted hover:bg-surface-muted hover:text-ink",
      )}
    >
      {label === "All" ? null : shared ? (
        <Users aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
      ) : (
        <Bookmark aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
      )}
      <span className="truncate">{label}</span>
      {isDefault ? <Star aria-label="Default view" className="size-3 shrink-0 fill-current text-attention" /> : null}
    </button>
  );
}

function ViewNameDialog({
  state,
  onClose,
  canShare,
  onSubmit,
}: {
  state: NameDialog;
  onClose: () => void;
  canShare: boolean;
  onSubmit: (v: { name: string; isShared: boolean; isDefault: boolean }) => Promise<boolean | { fieldErrors: FieldErrors }>;
}) {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => (open ? undefined : onClose())} size="sm">
      {state ? <ViewNameForm key={state.mode === "rename" ? state.view.id : "create"} state={state} onClose={onClose} canShare={canShare} onSubmit={onSubmit} /> : null}
    </Dialog>
  );
}

function ViewNameForm({
  state,
  onClose,
  canShare,
  onSubmit,
}: {
  state: NonNullable<NameDialog>;
  onClose: () => void;
  canShare: boolean;
  onSubmit: (v: { name: string; isShared: boolean; isDefault: boolean }) => Promise<boolean | { fieldErrors: FieldErrors }>;
}) {
  const [name, setName] = React.useState(state.mode === "rename" ? state.view.name : "");
  const [isShared, setShared] = React.useState(false);
  const [isDefault, setDefault] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  return (
    <form
      className="contents"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) {
          setError("Give the view a name");
          return;
        }
        setSaving(true);
        const result = await onSubmit({ name: trimmed, isShared, isDefault });
        setSaving(false);
        if (result === true) onClose();
        else if (typeof result === "object") {
          const errs = firstFieldErrors(result.fieldErrors);
          setError(errs.name ?? Object.values(errs)[0] ?? "Please check the name");
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>{state.mode === "rename" ? "Rename view" : "Save view"}</DialogTitle>
        <DialogDescription>
          {state.mode === "rename" ? "Only the name changes." : "Saves the current search, filters, sort and grouping so you can come back in one click."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4 pb-5">
        <FormField label="Name" required error={error ?? undefined}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Overdue weddings" autoFocus />
        </FormField>
        {state.mode === "create" ? (
          <div className="space-y-2.5">
            <Checkbox label="Make this my default view" checked={isDefault} onChange={(e) => setDefault(e.target.checked)} />
            {canShare ? (
              <Checkbox
                label="Share with the team"
                description="Everyone in the organisation sees it in their views (results still respect their permissions)."
                checked={isShared}
                onChange={(e) => setShared(e.target.checked)}
              />
            ) : null}
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          {state.mode === "rename" ? "Rename" : "Save view"}
        </Button>
      </DialogFooter>
    </form>
  );
}
