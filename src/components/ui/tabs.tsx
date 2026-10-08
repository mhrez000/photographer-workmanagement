"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { moveFocus } from "./use-dismissable";

type TabsVariant = "underline" | "pills" | "enclosed";

interface TabsContextValue {
  value: string;
  setValue: (value: string) => void;
  baseId: string;
  variant: TabsVariant;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error(`<${component}> must be used inside <Tabs>`);
  return ctx;
}

export interface TabsProps extends Omit<React.ComponentPropsWithRef<"div">, "defaultValue" | "onChange"> {
  value?: string;
  defaultValue?: string;
  /** Fires on change — wire this to the URL (`?tab=`) when tabs should be shareable. */
  onValueChange?: (value: string) => void;
  variant?: TabsVariant;
}

/**
 * Accessible tabs (WAI-ARIA pattern, arrow-key navigation). Controlled via
 * `value`/`onValueChange` or uncontrolled via `defaultValue`.
 */
export function Tabs({
  value,
  defaultValue,
  onValueChange,
  variant = "underline",
  className,
  children,
  ...props
}: TabsProps) {
  const [internal, setInternal] = React.useState(defaultValue ?? "");
  const isControlled = value !== undefined;
  const current = isControlled ? value : internal;
  const baseId = React.useId();

  const setValue = React.useCallback(
    (next: string) => {
      if (!isControlled) setInternal(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const ctx = React.useMemo<TabsContextValue>(
    () => ({ value: current, setValue, baseId, variant }),
    [current, setValue, baseId, variant],
  );

  return (
    <TabsContext.Provider value={ctx}>
      <div className={cn("flex flex-col", className)} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export interface TabsListProps extends React.ComponentPropsWithRef<"div"> {
  /** Stretch triggers to fill the width. */
  fullWidth?: boolean;
}

export function TabsList({ className, fullWidth, onKeyDown, ...props }: TabsListProps) {
  const { variant } = useTabsContext("TabsList");
  const ref = React.useRef<HTMLDivElement>(null);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const map: Record<string, "next" | "prev" | "first" | "last"> = {
      ArrowRight: "next",
      ArrowLeft: "prev",
      Home: "first",
      End: "last",
    };
    const dir = map[event.key];
    if (!dir) return;
    event.preventDefault();
    moveFocus(ref.current, '[role="tab"]', dir);
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.getAttribute("role") === "tab") active.click();
  };

  return (
    <div
      ref={ref}
      role="tablist"
      onKeyDown={handleKeyDown}
      className={cn(
        "relative flex items-center gap-1 overflow-x-auto scrollbar-none",
        variant === "underline" && "border-b border-border",
        variant === "pills" && "rounded-md bg-surface-muted p-1",
        variant === "enclosed" && "gap-0 border-b border-border",
        fullWidth && "[&>[role=tab]]:flex-1",
        className,
      )}
      {...props}
    />
  );
}

export interface TabsTriggerProps extends Omit<React.ComponentPropsWithRef<"button">, "value"> {
  value: string;
  icon?: React.ReactNode;
  /** Count bubble on the right. */
  count?: number | string;
}

export function TabsTrigger({ value, icon, count, className, children, onClick, ...props }: TabsTriggerProps) {
  const ctx = useTabsContext("TabsTrigger");
  const selected = ctx.value === value;

  return (
    <button
      type="button"
      role="tab"
      id={`${ctx.baseId}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${ctx.baseId}-panel-${value}`}
      tabIndex={selected ? 0 : -1}
      data-state={selected ? "active" : "inactive"}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) ctx.setValue(value);
      }}
      className={cn(
        "group/tab relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap text-sm font-medium",
        "transition-colors duration-(--motion-fast) focus-ring rounded-sm disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        ctx.variant === "underline" && [
          "-mb-px h-10 border-b-2 border-transparent px-1 text-ink-muted hover:text-ink",
          "mx-2 first:ml-0",
          "data-[state=active]:border-accent data-[state=active]:text-ink",
        ],
        ctx.variant === "pills" && [
          "h-7 rounded-sm px-3 text-ink-muted hover:text-ink",
          "data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-xs",
        ],
        ctx.variant === "enclosed" && [
          "-mb-px h-9 rounded-t-md border border-transparent px-3 text-ink-muted hover:text-ink",
          "data-[state=active]:border-border data-[state=active]:border-b-canvas data-[state=active]:bg-canvas data-[state=active]:text-ink",
        ],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
      {count !== undefined ? (
        <span
          className={cn(
            "ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-2xs font-semibold numeric",
            selected ? "bg-accent-soft text-accent-ink" : "bg-surface-muted text-ink-muted",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

export interface TabsContentProps extends React.ComponentPropsWithRef<"div"> {
  value: string;
  /** Keep the panel mounted while hidden (preserves local state). */
  forceMount?: boolean;
}

export function TabsContent({ value, forceMount = false, className, children, ...props }: TabsContentProps) {
  const ctx = useTabsContext("TabsContent");
  const selected = ctx.value === value;
  if (!selected && !forceMount) return null;

  return (
    <div
      role="tabpanel"
      id={`${ctx.baseId}-panel-${value}`}
      aria-labelledby={`${ctx.baseId}-tab-${value}`}
      hidden={!selected}
      tabIndex={0}
      className={cn("pt-4 focus-ring rounded-sm", className)}
      {...props}
    >
      {children}
    </div>
  );
}
