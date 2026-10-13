"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Command, defaultFilter } from "cmdk";
import {
  ArrowRight,
  Briefcase,
  Building2,
  CornerDownLeft,
  FolderOpen,
  History,
  Keyboard,
  Search,
  SearchX,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { useModalDialog } from "@/components/ui/use-modal-dialog";
import { OPEN_SEARCH_EVENT } from "@/components/shell/types";
import { StagePill } from "@/components/jobs/stage-pill";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { flattenNavigation, navigationFor, quickActionsFor, type NavGates } from "@/config/nav";
import { api, ApiError } from "@/lib/api-client";
import { personaLabel } from "@/lib/constants";
import type { JobRef, SearchResults, UserRef } from "@/lib/types";
import { cn, readStorage, writeStorage } from "@/lib/utils";
import { ShortcutsDialog } from "./shortcuts-dialog";

const RECENT_KEY = "proofline.recent-jobs";
const RECENT_MAX = 5;
const SEARCH_DEBOUNCE_MS = 160;

type RecentJob = Pick<JobRef, "id" | "jobNumber" | "name">;

function readRecent(): RecentJob[] {
  try {
    const raw = readStorage(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is RecentJob => !!r && typeof r.id === "string" && typeof r.jobNumber === "string" && typeof r.name === "string")
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Remember a job opened from the palette (shown under "Recent" next time). */
export function rememberRecentJob(job: RecentJob): void {
  const next = [job, ...readRecent().filter((r) => r.id !== job.id)].slice(0, RECENT_MAX);
  writeStorage(RECENT_KEY, JSON.stringify(next));
}

interface StaticCommand {
  id: string;
  label: string;
  hint?: string;
  group: "Navigation" | "Actions";
  icon: LucideIcon;
  keywords: string[];
  shortcut?: string;
  run: () => void;
}

type SearchState =
  | { status: "idle" }
  | { status: "done"; query: string; results: SearchResults }
  | { status: "error"; query: string; message: string };

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Navigation gates of the signed-in staff user (docs/ROLES.md §10; computed server-side). */
  gates: NavGates;
  /** Opens the keyboard shortcuts sheet (Advanced tools only, plan §8). */
  onShowShortcuts?: () => void;
}

/**
 * ⌘K search (plan §3 "Ctrl K still works"): global search across jobs, clients
 * and people (`GET /api/search?q=`, debounced and abortable; an exact job number
 * jumps to its full history), the pages the viewer can open, and quick actions.
 * Job rows wear the same five stage words as every list (plan §1). Projects,
 * keyboard chords and the shortcuts sheet only appear with Advanced tools on (plan §8).
 */
export function CommandPalette({ open, onOpenChange, gates, onShowShortcuts }: CommandPaletteProps) {
  const { ref, handleCancel, handleClose, handleBackdropClick } = useModalDialog({ open, onOpenChange });
  return (
    <dialog
      ref={ref}
      onCancel={handleCancel}
      onClose={handleClose}
      onClick={handleBackdropClick}
      aria-label="Search"
      className="mx-auto mb-auto mt-[min(12vh,7rem)] w-[calc(100vw-1.5rem)] max-w-xl bg-transparent p-0 outline-none open:animate-scale-in"
    >
      {open ? <PaletteBody gates={gates} close={() => onOpenChange(false)} onShowShortcuts={onShowShortcuts} /> : null}
    </dialog>
  );
}

function PaletteBody({
  gates,
  close,
  onShowShortcuts,
}: {
  gates: NavGates;
  close: () => void;
  onShowShortcuts?: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [search, setSearch] = React.useState<SearchState>({ status: "idle" });
  const [recent] = React.useState<RecentJob[]>(readRecent);
  const debounced = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const term = query.trim();

  React.useEffect(() => {
    if (!debounced) return undefined;
    const controller = new AbortController();
    api
      .get<SearchResults>("/api/search", { query: { q: debounced }, signal: controller.signal })
      .then((results) => setSearch({ status: "done", query: debounced, results }))
      .catch((err: unknown) => {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        const message =
          err instanceof ApiError && err.status === 404 ? "Search is not available yet." : err instanceof Error ? err.message : "Search failed";
        setSearch({ status: "error", query: debounced, message });
      });
    return () => controller.abort();
  }, [debounced]);

  const go = React.useCallback(
    (href: string) => {
      close();
      router.push(href);
    },
    [close, router],
  );

  const openJob = (job: RecentJob, tab?: "history") => {
    rememberRecentJob(job);
    go(tab ? `/jobs/${job.id}?tab=${tab}` : `/jobs/${job.id}`);
  };

  const personHref = (u: UserRef) => {
    // Plan §3: editors open their Editors page (owners), everyone else lands on the Jobs list filtered to them.
    if (u.role === "editor") return gates.admin ? `/editors/${u.id}` : `/jobs?editorId=${encodeURIComponent(u.id)}`;
    return gates.admin ? `/settings/people/${u.id}` : "/jobs";
  };

  const statics = React.useMemo<StaticCommand[]>(() => {
    const nav = flattenNavigation(navigationFor(gates)).map(
      (item): StaticCommand => ({
        id: `nav-${item.id}`,
        label: item.label,
        hint: item.group,
        group: "Navigation",
        icon: item.icon,
        keywords: [item.group ?? "", item.description ?? "", "go to", "open"].filter(Boolean),
        shortcut: item.shortcut,
        run: () => go(item.href),
      }),
    );
    const actions = quickActionsFor(gates).map(
      (a): StaticCommand => ({
        id: `action-${a.id}`,
        label: a.label,
        hint: a.description,
        group: "Actions",
        icon: a.icon,
        keywords: ["create", "add", a.description ?? ""],
        shortcut: a.id === "new-job" ? "n" : undefined,
        run: () => go(a.href),
      }),
    );
    if (gates.advanced) {
      actions.push({
        id: "action-shortcuts",
        label: "Keyboard shortcuts",
        hint: "See every shortcut",
        group: "Actions",
        icon: Keyboard,
        keywords: ["help", "keys", "hotkeys"],
        shortcut: "?",
        run: () => {
          close();
          onShowShortcuts?.();
        },
      });
    }
    return [...nav, ...actions];
  }, [gates, go, close, onShowShortcuts]);

  const scored = term
    ? statics
        .map((c) => ({ c, score: defaultFilter(c.label, term, c.keywords) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.c)
    : statics;
  const navItems = scored.filter((c) => c.group === "Navigation").slice(0, term ? 6 : 8);
  const actionItems = scored.filter((c) => c.group === "Actions").slice(0, term ? 4 : 6);

  const settled = (search.status === "done" || search.status === "error") && search.query === term;
  const loading = Boolean(term) && !settled;
  // Keep the previous results on screen while the next query loads (no flicker).
  const results = term && search.status === "done" ? search.results : null;
  const errorMessage = term && search.status === "error" && settled ? search.message : null;
  const exact = results?.exactJob ?? null;
  const jobs = results?.jobs ?? [];
  const projects = results && gates.advanced ? results.projects : [];
  const nothing =
    Boolean(term) &&
    settled &&
    results !== null &&
    results.jobs.length + results.clients.length + projects.length + results.users.length === 0 &&
    navItems.length === 0 &&
    actionItems.length === 0;

  // cmdk highlights the first item only when the INPUT changes; results arrive later
  // (debounced fetch). When an exact job number comes back, highlight it so Enter opens
  // its History (the ↵ hint promises that). Controlled value, re-pointed per exact match.
  const exactValue = exact ? `exact-history-${exact.id}` : null;
  const [highlighted, setHighlighted] = React.useState("");
  const [highlightedFor, setHighlightedFor] = React.useState<string | null>(null);
  if (exactValue !== highlightedFor) {
    setHighlightedFor(exactValue);
    if (exactValue) setHighlighted(exactValue);
  }

  const itemClass =
    "group/item flex cursor-pointer select-none items-center gap-3 rounded-md px-3 py-2 text-sm text-ink outline-none data-[selected=true]:bg-surface-muted data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50";
  const groupClass =
    "px-2 pb-1 [&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3";

  return (
    <Command
      label="Search"
      shouldFilter={false}
      loop
      value={highlighted}
      onValueChange={setHighlighted}
      className="flex max-h-[min(36rem,calc(100dvh-8rem))] flex-col overflow-hidden rounded-xl border border-border bg-surface-raised text-ink shadow-pop"
    >
      <div className="flex items-center gap-3 border-b border-border px-4">
        {loading ? <Spinner size="sm" className="text-ink-subtle" /> : <Search aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />}
        <Command.Input
          data-autofocus
          value={query}
          onValueChange={setQuery}
          placeholder="Search jobs, clients, people… or type a command"
          className="h-13 min-w-0 flex-1 bg-transparent py-4 text-md text-ink outline-none placeholder:text-ink-subtle"
        />
        <Kbd className="hidden sm:inline-flex">Esc</Kbd>
      </div>

      <Command.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2 scrollbar-thin">
        {exact ? (
          <Command.Group heading="Jump to job" className={groupClass}>
            <Command.Item value={exactValue ?? undefined} onSelect={() => openJob(exact, "history")} className={itemClass}>
              <IconTile icon={History} tone="accent" />
              <span className="min-w-0 flex-1 truncate">
                Open <span className="font-mono numeric font-medium">{exact.jobNumber}</span> history
                <span className="ml-2 text-ink-muted">{exact.name}</span>
              </span>
              <EnterHint />
            </Command.Item>
          </Command.Group>
        ) : null}

        {jobs.length > 0 ? (
          <Command.Group heading="Jobs" className={groupClass}>
            {jobs.map((j) => (
              <Command.Item key={j.id} value={`job-${j.id}`} onSelect={() => openJob(j)} className={itemClass}>
                <IconTile icon={Briefcase} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="shrink-0 font-mono text-xs text-ink-muted numeric">{j.jobNumber}</span>
                    <span className="truncate font-medium">{j.name}</span>
                  </span>
                  <span className="block truncate text-xs text-ink-muted">
                    {j.client?.name}
                    {j.matchedIn !== "number" && j.matchedIn !== "name" ? ` · matched in ${j.matchedIn}` : ""}
                  </span>
                </span>
                {j.status ? <StagePill job={{ category: j.status.category, revisionCount: 0 }} hideSubLabel className="hidden sm:inline-flex" /> : null}
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        {results && results.clients.length > 0 ? (
          <Command.Group heading="Clients" className={groupClass}>
            {results.clients.map((c) => (
              <Command.Item key={c.id} value={`client-${c.id}`} onSelect={() => go(`/clients/${c.id}`)} className={itemClass}>
                <IconTile icon={Building2} />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        {projects.length > 0 ? (
          <Command.Group heading="Projects" className={groupClass}>
            {projects.map((p) => (
              <Command.Item key={p.id} value={`project-${p.id}`} onSelect={() => go(`/projects/${p.id}`)} className={itemClass}>
                <IconTile icon={FolderOpen} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{p.name}</span>
                  <span className="block truncate text-xs text-ink-muted">{p.client?.name}</span>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        {results && results.users.length > 0 ? (
          <Command.Group heading="People" className={groupClass}>
            {results.users.map((u) => (
              <Command.Item key={u.id} value={`user-${u.id}`} onSelect={() => go(personHref(u))} className={itemClass}>
                <Avatar name={u.name} size="sm" colour={u.avatarColour || undefined} />
                <span className="min-w-0 flex-1 truncate">{u.name}</span>
                <span className="text-xs text-ink-muted">{personaLabel(u)}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        {!term && recent.length > 0 ? (
          <Command.Group heading="Recent jobs" className={groupClass}>
            {recent.map((j) => (
              <Command.Item key={j.id} value={`recent-${j.id}`} onSelect={() => openJob(j)} className={itemClass}>
                <IconTile icon={History} />
                <span className="shrink-0 font-mono text-xs text-ink-muted numeric">{j.jobNumber}</span>
                <span className="min-w-0 flex-1 truncate">{j.name}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        {actionItems.length > 0 ? (
          <Command.Group heading="Actions" className={groupClass}>
            {actionItems.map((c) => (
              <StaticItem key={c.id} command={c} className={itemClass} />
            ))}
          </Command.Group>
        ) : null}

        {navItems.length > 0 ? (
          <Command.Group heading="Go to" className={groupClass}>
            {navItems.map((c) => (
              <StaticItem key={c.id} command={c} className={itemClass} />
            ))}
          </Command.Group>
        ) : null}

        {term ? (
          <Command.Group className={cn(groupClass, "pt-1")}>
            <Command.Item value="see-all" onSelect={() => go(`/search?q=${encodeURIComponent(term)}`)} className={itemClass}>
              <IconTile icon={Search} />
              <span className="min-w-0 flex-1 truncate">
                See all results for <span className="font-medium">“{term}”</span>
              </span>
              <ArrowRight aria-hidden="true" className="size-4 text-ink-subtle" />
            </Command.Item>
          </Command.Group>
        ) : null}

        {errorMessage ? (
          <div role="status" className="mx-4 mt-3 flex items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-ink-muted">
            <TriangleAlert aria-hidden="true" className="size-4 text-attention" />
            {errorMessage}
          </div>
        ) : null}

        {nothing ? (
          <div role="status" className="flex flex-col items-center px-6 py-10 text-center">
            <SearchX aria-hidden="true" className="mb-3 size-6 text-ink-subtle" />
            <p className="text-sm font-medium text-ink">No matches for “{term}”</p>
            <p className="mt-1 max-w-xs text-xs text-ink-muted">Try a job number like PJ-0042, a client, a street name, or a person.</p>
          </div>
        ) : null}
      </Command.List>

      <div className="hidden items-center gap-4 border-t border-border bg-surface-sunken px-4 py-2 text-2xs text-ink-muted sm:flex">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>↵</Kbd> open
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Esc</Kbd> close
        </span>
        {gates.advanced ? (
          <span className="ml-auto inline-flex items-center gap-1">
            <Kbd>?</Kbd> all shortcuts
          </span>
        ) : null}
      </div>
    </Command>
  );
}

function IconTile({ icon: Icon, tone = "default" }: { icon: LucideIcon; tone?: "default" | "accent" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md ring-1 ring-inset",
        tone === "accent" ? "bg-accent-soft text-accent-ink ring-accent/20" : "bg-surface text-ink-muted ring-border group-data-[selected=true]/item:text-ink",
      )}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

function EnterHint() {
  return (
    <span aria-hidden="true" className="hidden items-center text-ink-subtle group-data-[selected=true]/item:inline-flex">
      <CornerDownLeft className="size-3.5" />
    </span>
  );
}

function StaticItem({ command, className }: { command: StaticCommand; className: string }) {
  return (
    <Command.Item value={command.id} onSelect={command.run} className={className}>
      <IconTile icon={command.icon} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{command.label}</span>
      </span>
      {command.hint && command.group === "Navigation" ? <span className="hidden text-xs text-ink-subtle sm:inline">{command.hint}</span> : null}
      {command.shortcut ? (
        <span className="hidden items-center gap-0.5 sm:inline-flex">
          {command.shortcut.split(" ").map((k, i) => (
            <Kbd key={`${k}-${i}`}>{k.toUpperCase()}</Kbd>
          ))}
        </span>
      ) : null}
    </Command.Item>
  );
}

/* ------------------------------------------------------------------ */
/*  Mount: one per app layout                                          */
/* ------------------------------------------------------------------ */

const GO_TO_FALLBACKS: Record<string, string> = {
  "g d": "/home",
  "g a": "/jobs",
  "g m": "/jobs",
  "g k": "/workspace/kanban",
  "g c": "/workspace/calendar",
  "g n": "/notifications",
};

export interface CommandPaletteMountProps {
  /** Navigation gates of the signed-in staff user (filters navigation and actions). */
  gates: NavGates;
}

/**
 * Mounted once by `src/app/(app)/layout.tsx`. Opens the palette on the shell's
 * OPEN_SEARCH_EVENT (⌘K / Ctrl K, the search button) and on "/". The go-to
 * chords ("g d/a/m/k/c/n"), "n" new job and "?" (the shortcut sheet) are wired
 * only when the studio's Advanced tools are on (plan §8: chords are hidden).
 */
export function CommandPaletteMount({ gates }: CommandPaletteMountProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

  // Close on navigation (e.g. browser back while open).
  const [lastPath, setLastPath] = React.useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (open) setOpen(false);
  }

  React.useEffect(() => {
    const onOpen = () => {
      setShortcutsOpen(false);
      setOpen(true);
    };
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, onOpen);
  }, []);

  const bindings = React.useMemo(() => {
    const map: Record<string, () => void> = {
      "/": () => setOpen(true),
    };
    // The shortcuts sheet and the go-to chords are Advanced only (plan §8); Ctrl K and "/" stay for everyone.
    if (gates.advanced) map["?"] = () => setShortcutsOpen(true);
    const allowed = new Map<string, string>();
    for (const item of flattenNavigation(navigationFor(gates))) {
      if (item.shortcut) allowed.set(item.shortcut, item.href);
    }
    if (gates.advanced) {
      for (const [keys, href] of Object.entries(GO_TO_FALLBACKS)) {
        map[keys] = () => router.push(allowed.get(keys) ?? href);
      }
      if (quickActionsFor(gates).some((a) => a.id === "new-job")) {
        map.n = () => router.push("/jobs/new");
      }
    }
    return map;
  }, [gates, router]);

  useHotkeys(bindings, { enabled: !open });

  return (
    <>
      <CommandPalette open={open} onOpenChange={setOpen} gates={gates} onShowShortcuts={() => setShortcutsOpen(true)} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  );
}
