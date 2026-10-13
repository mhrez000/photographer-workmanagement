"use client";

import * as React from "react";
import { Check, Laptop, Monitor, Moon, Rows3, Rows4, Sun } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  APPEARANCE_EVENT,
  DENSITIES,
  DENSITY_KEY,
  THEMES,
  THEME_KEY,
  type DensityPreference,
  type ThemePreference,
} from "./appearance";

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = window.localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(APPEARANCE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(APPEARANCE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

function usePreference<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  return React.useSyncExternalStore(
    subscribe,
    () => read(key, allowed, fallback),
    () => fallback,
  );
}

function apply(theme: ThemePreference, density: DensityPreference) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  if (density === "compact") root.setAttribute("data-density", "compact");
  else root.removeAttribute("data-density");
}

function persist(key: string, value: string, defaultValue: string): boolean {
  try {
    if (value === defaultValue) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

const THEME_OPTIONS: { value: ThemePreference; label: string; description: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", description: "Follow this device's light/dark setting", icon: Laptop },
  { value: "light", label: "Light", description: "Warm paper, best in bright rooms", icon: Sun },
  { value: "dark", label: "Dark", description: "Easy on the eyes when editing late", icon: Moon },
];

const DENSITY_OPTIONS: { value: DensityPreference; label: string; description: string; icon: typeof Rows3 }[] = [
  { value: "comfortable", label: "Comfortable", description: "Roomy spacing, larger touch targets", icon: Rows3 },
  { value: "compact", label: "Compact", description: "More rows on screen for desk work", icon: Rows4 },
];

function ThemePreview({ mode }: { mode: ThemePreference }) {
  const half = mode === "system";
  const dark = mode === "dark";
  return (
    <span aria-hidden="true" className="relative flex h-16 w-full overflow-hidden rounded-md border border-border">
      <span className={cn("flex flex-1 flex-col gap-1 p-2", dark ? "bg-[#121315]" : "bg-[#faf9f7]")}>
        <span className={cn("h-1.5 w-8 rounded-full", dark ? "bg-[#2dd4bf]" : "bg-[#0f766e]")} />
        <span className={cn("h-1.5 w-12 rounded-full", dark ? "bg-[#3a3e45]" : "bg-[#d9d5ce]")} />
        <span className={cn("h-1.5 w-10 rounded-full", dark ? "bg-[#3a3e45]" : "bg-[#d9d5ce]")} />
      </span>
      {half ? (
        <span className="flex flex-1 flex-col gap-1 bg-[#121315] p-2">
          <span className="h-1.5 w-8 rounded-full bg-[#2dd4bf]" />
          <span className="h-1.5 w-12 rounded-full bg-[#3a3e45]" />
          <span className="h-1.5 w-10 rounded-full bg-[#3a3e45]" />
        </span>
      ) : null}
    </span>
  );
}

function OptionCard({
  selected,
  onSelect,
  icon: Icon,
  label,
  description,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: typeof Sun;
  label: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "relative flex flex-col gap-3 rounded-lg border p-3 text-left transition-[border-color,box-shadow,background-color] duration-(--motion-fast) focus-ring",
        selected ? "border-accent bg-accent-soft/40 shadow-xs ring-1 ring-accent/30" : "border-border bg-surface hover:border-border-hover",
      )}
    >
      {children}
      <span className="flex items-start gap-2">
        <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", selected ? "text-accent-ink" : "text-ink-muted")} />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink">{label}</span>
          <span className="block text-xs text-ink-muted">{description}</span>
        </span>
      </span>
      {selected ? (
        <span className="absolute right-2.5 top-2.5 flex size-5 items-center justify-center rounded-full bg-accent text-accent-fg">
          <Check aria-hidden="true" className="size-3" />
        </span>
      ) : null}
    </button>
  );
}

/**
 * Appearance for this browser only (localStorage): Light / Dark / System. Density is an Advanced
 * tool (SIMPLIFICATION-PLAN §8) and only shows when `showDensity` is true.
 */
export function AppearanceSettings({ showDensity = false }: { showDensity?: boolean } = {}) {
  const theme = usePreference<ThemePreference>(THEME_KEY, THEMES, "system");
  const density = usePreference<DensityPreference>(DENSITY_KEY, DENSITIES, "comfortable");

  const update = (next: { theme?: ThemePreference; density?: DensityPreference }) => {
    const t = next.theme ?? theme;
    const d = next.density ?? density;
    const ok = (next.theme ? persist(THEME_KEY, t, "system") : true) && (next.density ? persist(DENSITY_KEY, d, "comfortable") : true);
    apply(t, d);
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
    if (!ok) toast.warning("Applied for now", "This browser blocks site storage, so it won't be remembered next time.");
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionCard id="appearance" title="Appearance" description="Light, dark, or match your device." actions={<Monitor aria-hidden="true" className="size-4 text-ink-subtle" />}>
        <div role="radiogroup" aria-label="Theme" className="grid gap-3 sm:grid-cols-3">
          {THEME_OPTIONS.map((o) => (
            <OptionCard key={o.value} selected={theme === o.value} onSelect={() => update({ theme: o.value })} icon={o.icon} label={o.label} description={o.description}>
              <ThemePreview mode={o.value} />
            </OptionCard>
          ))}
        </div>
      </SectionCard>
      {showDensity ? (
      <SectionCard title="Density" description="How tightly lists, tables and forms are packed." actions={<Badge variant="outline" size="sm">Advanced</Badge>}>
        <div role="radiogroup" aria-label="Density" className="grid gap-3 sm:grid-cols-2">
          {DENSITY_OPTIONS.map((o) => (
            <OptionCard key={o.value} selected={density === o.value} onSelect={() => update({ density: o.value })} icon={o.icon} label={o.label} description={o.description}>
              <span aria-hidden="true" className={cn("flex w-full flex-col rounded-md border border-border bg-surface-sunken p-2", o.value === "compact" ? "gap-1" : "gap-2")}>
                {[0, 1, 2].map((i) => (
                  <span key={i} className={cn("flex items-center gap-2 rounded-sm bg-surface px-2", o.value === "compact" ? "h-4" : "h-5.5")}>
                    <span className="size-1.5 rounded-full bg-accent" />
                    <span className="h-1 w-16 rounded-full bg-border-strong" />
                  </span>
                ))}
              </span>
            </OptionCard>
          ))}
        </div>
      </SectionCard>
      ) : null}
      <p className="text-sm text-ink-muted">
        This is saved in this browser only — it does not follow you to your phone or another computer, and clearing site data resets it.
      </p>
    </div>
  );
}
