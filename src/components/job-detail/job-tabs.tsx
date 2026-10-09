"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
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
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useHotkeys } from "@/hooks";
import { JOB_TAB_LABELS, type JobTab } from "./format";

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

  return (
    <Tabs value={shown} onValueChange={(v) => (v !== active || pending ? go(v) : undefined)}>
      <TabsList aria-label="Job sections" className="-mx-4 px-4 sm:mx-0 sm:px-0">
        {tabs.map((t, i) => {
          const Icon = TAB_ICONS[t.key];
          return (
            <TabsTrigger
              key={t.key}
              value={t.key}
              icon={<Icon aria-hidden="true" />}
              count={t.count !== undefined && t.count > 0 ? t.count : undefined}
              aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
              title={i < 9 ? `${JOB_TAB_LABELS[t.key]} (${i + 1})` : JOB_TAB_LABELS[t.key]}
            >
              {JOB_TAB_LABELS[t.key]}
            </TabsTrigger>
          );
        })}
      </TabsList>
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
