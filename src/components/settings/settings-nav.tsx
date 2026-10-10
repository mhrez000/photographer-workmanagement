"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/select";
import { activeSettingsHref, settingsNavFor } from "./nav-items";

/** Left sub-navigation on desktop; a compact select on small screens. */
export function SettingsNav({ showStudio }: { showStudio: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const sections = React.useMemo(() => settingsNavFor(showStudio), [showStudio]);
  const active = activeSettingsHref(pathname, sections);

  return (
    <>
      {/* Mobile: one select, thumb-reachable at the top of the page. */}
      <div className="px-4 pt-4 sm:px-6 lg:hidden">
        {/* Visually labelled by the page header below; the label is for assistive tech. */}
        <label htmlFor="settings-section" className="sr-only">
          Settings
        </label>
        <Select
          id="settings-section"
          value={active ?? ""}
          onChange={(e) => router.push(e.target.value)}
          aria-label="Settings section"
        >
          {active === null ? <option value="">Choose a section…</option> : null}
          {sections.map((section) => (
            <optgroup key={section.id} label={section.label}>
              {section.items.map((item) => (
                <option key={item.href} value={item.href}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </div>

      {/* Desktop: sticky rail. */}
      <nav
        aria-label="Settings"
        className="sticky top-[var(--topbar-height)] hidden h-[calc(100dvh-var(--topbar-height))] self-start overflow-y-auto border-r border-border py-6 pl-6 pr-4 scrollbar-thin lg:block"
      >
        <p className="eyebrow mb-4 px-2.5">Settings</p>
        <div className="flex flex-col gap-6">
          {sections.map((section) => (
            <div key={section.id}>
              <p className="mb-1.5 px-2.5 text-2xs font-semibold uppercase tracking-wider text-ink-subtle">{section.label}</p>
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = item.href === active;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-base transition-colors duration-(--motion-fast) focus-ring",
                          isActive ? "bg-surface-muted font-medium text-ink" : "text-ink-secondary hover:bg-surface-muted/70 hover:text-ink",
                        )}
                      >
                        <Icon
                          aria-hidden="true"
                          className={cn("size-4 shrink-0", isActive ? "text-accent-ink" : "text-ink-subtle group-hover:text-ink-muted")}
                        />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>
    </>
  );
}
