import * as React from "react";
import { cn } from "@/lib/utils";
import { SECTION_ICONS, SECTION_TONE_CLASSES, sectionAnchor, type MyWorkSectionKey, type MyWorkSectionMeta } from "./sections";

export interface SummaryStripProps {
  sections: MyWorkSectionMeta[];
  counts: Record<MyWorkSectionKey, number>;
}

/**
 * Counts per section as jump links. Scrolls horizontally on phones, a calm
 * grid on larger screens. Tones only light up when the count is non-zero.
 */
export function SummaryStrip({ sections, counts }: SummaryStripProps) {
  return (
    <nav aria-label="Queue summary" className="-mx-4 overflow-x-auto px-4 scrollbar-none sm:mx-0 sm:px-0">
      <ol className="flex min-w-max gap-2 sm:grid sm:min-w-0 sm:grid-cols-4 lg:grid-cols-7">
        {sections.map((s) => {
          const count = counts[s.key];
          const Icon = SECTION_ICONS[s.icon];
          const styles = SECTION_TONE_CLASSES[s.tone];
          const lit = count > 0;
          return (
            <li key={s.key} className="min-w-[7.5rem] sm:min-w-0">
              <a
                href={`#${sectionAnchor(s.key)}`}
                className={cn(
                  "group/stat flex h-full flex-col gap-1 rounded-md border border-border bg-surface px-3 py-2.5 focus-ring",
                  "transition-[border-color,box-shadow] duration-(--motion-fast) hover:border-border-hover hover:shadow-xs",
                  !lit && "bg-surface-sunken/60",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="eyebrow truncate">{s.short}</span>
                  <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", lit ? styles.count : "text-ink-subtle")} />
                </span>
                <span className={cn("text-xl font-semibold leading-7 tracking-tight numeric", lit ? styles.count : "text-ink-subtle")}>{count}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
