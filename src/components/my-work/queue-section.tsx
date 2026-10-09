"use client";

import * as React from "react";
import { CheckCircle2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { SECTION_ICONS, SECTION_TONE_CLASSES, sectionAnchor, type MyWorkSectionKey, type SectionIconKey, type SectionTone } from "./sections";

const STORAGE_PREFIX = "pwm.my-work.collapsed.";
const CHANGE_EVENT = "pwm:my-work-collapse";

function readCollapsed(key: MyWorkSectionKey): boolean | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    return raw === null ? null : raw === "1";
  } catch {
    return null;
  }
}

function writeCollapsed(key: MyWorkSectionKey, collapsed: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, collapsed ? "1" : "0");
  } catch {
    // Storage blocked (private mode): the choice simply is not remembered.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

/** Remembered collapse state per section (localStorage, per viewer); SSR renders the default. */
function useCollapsed(key: MyWorkSectionKey, defaultCollapsed: boolean): [boolean, (next: boolean) => void] {
  const stored = React.useSyncExternalStore(
    subscribe,
    () => readCollapsed(key),
    () => null,
  );
  const collapsed = stored ?? defaultCollapsed;
  const set = React.useCallback((next: boolean) => writeCollapsed(key, next), [key]);
  return [collapsed, set];
}

export interface QueueSectionProps {
  sectionKey: MyWorkSectionKey;
  title: string;
  description: string;
  empty: string;
  tone: SectionTone;
  icon: SectionIconKey;
  count: number;
  defaultCollapsed?: boolean;
  /** The job cards (server-rendered). */
  children?: React.ReactNode;
}

/**
 * One My Work bucket: a header button that collapses/expands the cards, with
 * the count in the section's tone. Empty sections render as a slim, quiet
 * line so the queue stays scannable.
 */
export function QueueSection({ sectionKey, title, description, empty, tone, icon, count, defaultCollapsed = false, children }: QueueSectionProps) {
  const [collapsed, setCollapsed] = useCollapsed(sectionKey, defaultCollapsed);
  const styles = SECTION_TONE_CLASSES[tone];
  const Icon = SECTION_ICONS[icon];
  const anchor = sectionAnchor(sectionKey);
  const panelId = `${anchor}-panel`;

  if (count === 0) {
    return (
      <section id={anchor} aria-label={`${title}: none`} className="scroll-mt-20">
        <div className="flex items-center gap-3 rounded-lg border border-dashed border-border px-4 py-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-muted text-ink-subtle">
            <Icon aria-hidden="true" className="size-3.5" />
          </span>
          <span className="text-sm font-medium text-ink-secondary">{title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-ink-subtle">
            <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-success" />
            <span className="truncate">{empty}</span>
          </span>
        </div>
      </section>
    );
  }

  const open = !collapsed;
  return (
    <section id={anchor} aria-labelledby={`${anchor}-title`} className="scroll-mt-20">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setCollapsed(open)}
        className="group/section flex w-full items-center gap-3 rounded-md py-1.5 text-left focus-ring"
      >
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full", styles.chip)}>
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-3">
          <span className="flex items-baseline gap-2">
            <h2 id={`${anchor}-title`} className="text-md font-semibold text-ink">
              {title}
            </h2>
            <span className={cn("text-md font-semibold numeric", styles.count)}>{count}</span>
          </span>
          <span className="truncate text-sm text-ink-muted">{description}</span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-ink-subtle transition-transform duration-(--motion-base) ease-out-soft group-hover/section:text-ink-muted",
            collapsed && "-rotate-90",
          )}
        />
        <span className="sr-only">{open ? "Collapse section" : "Expand section"}</span>
      </button>
      <div id={panelId} hidden={collapsed} className="mt-3">
        <ul role="list" className="flex flex-col gap-2.5">
          {children}
        </ul>
      </div>
    </section>
  );
}
