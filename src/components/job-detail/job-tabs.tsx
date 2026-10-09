"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  ChevronDown,
  FileText,
  GitCommitVertical,
  History,
  LayoutDashboard,
  Link2,
  MessagesSquare,
  RotateCcw,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useHotkeys } from "@/hooks";
import { cn } from "@/lib/utils";
import { fitTabs, JOB_TAB_LABELS, type JobTab } from "./format";

const TAB_ICONS: Record<JobTab, LucideIcon> = {
  overview: LayoutDashboard,
  links: Link2,
  notes: FileText,
  comments: MessagesSquare,
  revisions: RotateCcw,
  timeline: GitCommitVertical,
  activity: Activity,
  history: History,
  time: Timer,
};

/** Search params that belong to one tab and are dropped when switching tabs. */
const TAB_SCOPED_PARAMS = ["events", "cursor", "kind", "respond", "compose", "thread"];

export interface JobTabsProps {
  active: JobTab;
  tabs: { key: JobTab; count?: number }[];
  /** `/jobs/[id]/edit` when the viewer may edit fields ("e" shortcut). */
  editHref?: string | null;
  /** The active tab's panel (rendered on the server). */
  children: React.ReactNode;
}

/**
 * URL-driven tabs (`?tab=`): each tab's data is loaded on the server only when
 * it is active, so switching is a soft navigation with a skeleton while the
 * next panel streams in. Keys: 1–9 switch tabs, "c" opens the comment box,
 * "e" opens the edit form.
 *
 * Priority+ bar: tabs that do not fit the column move into a trailing "More"
 * menu (the shown tab always stays in the bar), so no section is ever hidden
 * off the edge without an indicator.
 */
export function JobTabs({ active, tabs, editHref, children }: JobTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = React.useTransition();
  const [target, setTarget] = React.useState<JobTab | null>(null);

  const go = React.useCallback(
    (next: string, extra?: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const key of TAB_SCOPED_PARAMS) params.delete(key);
      if (next === "overview") params.delete("tab");
      else params.set("tab", next);
      for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
      const qs = params.toString();
      setTarget(next as JobTab);
      startTransition(() => {
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      });
    },
    [pathname, router, searchParams],
  );

  const hotkeys = React.useMemo(() => {
    const map: Record<string, () => void> = {
      c: () => {
        if (active === "comments") {
          document.getElementById("comment-composer")?.focus();
          return;
        }
        if (tabs.some((t) => t.key === "comments")) go("comments", { compose: "1" });
      },
    };
    tabs.slice(0, 9).forEach((t, i) => {
      map[String(i + 1)] = () => go(t.key);
    });
    if (editHref) map.e = () => router.push(editHref);
    return map;
  }, [active, editHref, go, router, tabs]);
  useHotkeys(hotkeys);

  const shown = pending && target ? target : active;
  const { wrapRef, listOf, moreRef, measured, fades } = useTabBarMeasurements();

  // Narrow bars (phones, a squeezed column): icon-only tabs except the shown one, then "More" for what still does not fit.
  const compact = measured !== null && measured.available < COMPACT_BELOW;
  const labelled = (key: JobTab) => !compact || key === shown;
  // Until every tab has been measured (first paint, a tab appearing) all tabs render and the bar scrolls.
  const keys = tabs.map((t) => t.key);
  const widths = measured ? keys.map((k) => measured.widths[widthKey(k, labelled(k))]) : [];
  const split =
    measured && widths.every((w) => w !== undefined)
      ? fitTabs(widths as number[], measured.available, measured.moreWidth, keys.indexOf(shown))
      : null;
  const visible = split ? split.visible.map((i) => tabs[i]) : tabs;
  const overflow = split ? split.overflow.map((i) => tabs[i]) : [];
  const visibleCount = visible.length;

  // Keep the shown tab in view while the bar scrolls (before measurement).
  React.useEffect(() => {
    const list = listOf();
    const el = list?.querySelector<HTMLElement>(`[data-tab="${shown}"]`);
    if (!list || !el) return;
    // Same as scrollIntoView({ inline: "nearest" }) but never scrolls the page vertically.
    const left = el.offsetLeft - list.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < list.scrollLeft) list.scrollLeft = Math.max(0, left - 16);
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth + 16;
  }, [shown, listOf, visibleCount]);

  return (
    <Tabs value={shown} onValueChange={(v) => (v !== active || pending ? go(v) : undefined)}>
      <div ref={wrapRef} className="relative -mx-4 flex items-end border-b border-border px-4 sm:mx-0 sm:px-0">
        <TabsList aria-label="Job sections" className="min-w-0 flex-1 border-b-0">
          {visible.map((t) => {
            const i = keys.indexOf(t.key);
            const Icon = TAB_ICONS[t.key];
            const label = JOB_TAB_LABELS[t.key];
            const count = t.count !== undefined && t.count > 0 ? t.count : undefined;
            const withLabel = labelled(t.key);
            return (
              <TabsTrigger
                key={t.key}
                value={t.key}
                data-tab={t.key}
                data-tab-width={widthKey(t.key, withLabel)}
                icon={<Icon aria-hidden="true" />}
                count={withLabel ? count : undefined}
                className={withLabel ? undefined : "mx-1 px-1.5"}
                aria-label={withLabel ? undefined : count !== undefined ? `${label} (${count})` : label}
                aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
                title={`${label}${!withLabel && count !== undefined ? ` · ${count}` : ""}${i < 9 ? ` (${i + 1})` : ""}`}
              >
                {withLabel ? label : <span className="sr-only">{label}</span>}
              </TabsTrigger>
            );
          })}
        </TabsList>
        {/* Edge fades: shown only while the bar actually scrolls in that direction. */}
        <span
          aria-hidden="true"
          data-fade="start"
          className={cn(
            "pointer-events-none absolute bottom-px left-4 top-0 w-8 bg-gradient-to-r from-canvas to-transparent transition-opacity sm:left-0",
            fades.left ? "opacity-100" : "opacity-0",
          )}
        />
        <span
          aria-hidden="true"
          data-fade="end"
          className={cn(
            "pointer-events-none absolute bottom-px right-4 top-0 w-8 bg-gradient-to-l from-canvas to-transparent transition-opacity sm:right-0",
            fades.right ? "opacity-100" : "opacity-0",
          )}
        />
        {overflow.length > 0 ? (
          <div ref={moreRef} className="shrink-0 pb-1 pl-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                variant="ghost"
                size="sm"
                aria-label={`More sections: ${overflow.map((t) => JOB_TAB_LABELS[t.key]).join(", ")}`}
                trailingIcon={<ChevronDown aria-hidden="true" />}
              >
                More
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" aria-label="More job sections">
                {overflow.map((t) => {
                  const i = keys.indexOf(t.key);
                  const Icon = TAB_ICONS[t.key];
                  return (
                    <DropdownMenuItem
                      key={t.key}
                      data-tab-overflow={t.key}
                      icon={<Icon aria-hidden="true" />}
                      shortcut={i < 9 ? String(i + 1) : undefined}
                      aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
                      onSelect={() => go(t.key)}
                    >
                      {JOB_TAB_LABELS[t.key]}
                      {t.count !== undefined && t.count > 0 ? <span className="ml-1.5 text-xs text-ink-muted numeric">{t.count}</span> : null}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </div>
      <TabsContent value={shown} className="pt-5" aria-busy={pending || undefined}>
        {shown === active && !pending ? (
          <div className="animate-fade-in">{children}</div>
        ) : (
          <TabSkeleton />
        )}
      </TabsContent>
    </Tabs>
  );
}

/** Below this bar width tabs other than the shown one are icon-only. */
const COMPACT_BELOW = 560;

/** Measurement key: a tab's width differs with and without its label. */
function widthKey(key: JobTab, labelled: boolean): string {
  return `${key}:${labelled ? "label" : "icon"}`;
}

interface TabBarMeasurements {
  /** Outer width of every tab variant rendered so far (incl. margins + gap), by `widthKey`. */
  widths: Partial<Record<string, number>>;
  /** Content width of the bar. */
  available: number;
  moreWidth: number;
}

const DEFAULT_MORE_WIDTH = 96;
const same = (a: number, b: number) => Math.abs(a - b) < 1;

/**
 * Measures the tab bar with a ResizeObserver (bar width, every rendered tab,
 * the More button) and whether the list can scroll left / right (edge fades).
 * Widths of tabs currently in the More menu are kept from their last render.
 */
function useTabBarMeasurements() {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  // TabsList keeps its own ref (keyboard navigation), so the list is found inside the wrapper.
  const listOf = React.useCallback(() => wrapRef.current?.querySelector<HTMLElement>('[role="tablist"]') ?? null, []);
  const moreRef = React.useRef<HTMLDivElement>(null);
  const observerRef = React.useRef<ResizeObserver | null>(null);
  const [measured, setMeasured] = React.useState<TabBarMeasurements | null>(null);
  const [fades, setFades] = React.useState({ left: false, right: false });

  const measure = React.useCallback(() => {
    const wrap = wrapRef.current;
    const list = listOf();
    if (!wrap || !list) return;
    const wrapStyle = getComputedStyle(wrap);
    const available = wrap.clientWidth - parseFloat(wrapStyle.paddingLeft) - parseFloat(wrapStyle.paddingRight);
    const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
    const next: Partial<Record<string, number>> = {};
    list.querySelectorAll<HTMLElement>("[data-tab-width]").forEach((el) => {
      const cs = getComputedStyle(el);
      // +2px slack so sub-pixel rounding never leaves the last tab half-clipped.
      next[el.dataset.tabWidth as string] = el.offsetWidth + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight) + gap + 2;
    });
    const moreWidth = moreRef.current ? moreRef.current.offsetWidth : DEFAULT_MORE_WIDTH;
    setMeasured((prev) => {
      const widths = { ...(prev?.widths ?? {}), ...next };
      const changed =
        !prev ||
        !same(prev.available, available) ||
        !same(prev.moreWidth, moreWidth) ||
        Object.keys(widths).some((k) => prev.widths[k] === undefined || !same(prev.widths[k] as number, widths[k] as number));
      return changed ? { widths, available, moreWidth } : prev;
    });
    const left = list.scrollLeft > 1;
    const right = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
    setFades((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, [listOf]);

  // Subscribe once; (re)observe after every render so newly rendered tabs / the More button report their size.
  React.useLayoutEffect(() => {
    if (!observerRef.current) observerRef.current = new ResizeObserver(() => measure());
    const observer = observerRef.current;
    if (wrapRef.current) observer.observe(wrapRef.current);
    if (moreRef.current) observer.observe(moreRef.current);
    listOf()?.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => observer.observe(el));
  });

  React.useEffect(() => {
    const list = listOf();
    list?.addEventListener("scroll", measure, { passive: true });
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) measure();
    });
    return () => {
      alive = false;
      list?.removeEventListener("scroll", measure);
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [measure, listOf]);

  return { wrapRef, listOf, moreRef, measured, fades };
}

function TabSkeleton() {
  return (
    <div role="status" aria-label="Loading section" className="flex flex-col gap-4">
      <Skeleton className="h-5 w-40" />
      <div className="rounded-lg border border-border bg-surface p-5">
        <SkeletonText lines={4} />
      </div>
      <div className="rounded-lg border border-border bg-surface p-5">
        <SkeletonText lines={3} />
      </div>
    </div>
  );
}
