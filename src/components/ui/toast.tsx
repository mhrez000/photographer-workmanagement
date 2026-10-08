"use client";

import * as React from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "./icon-button";

export type ToastVariant = "default" | "success" | "warning" | "danger" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastInput {
  title: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss. `0` keeps it until dismissed. */
  duration?: number;
  action?: ToastAction;
  /** Reuse an id to update an existing toast in place. */
  id?: string;
}

export interface ToastItem extends Required<Pick<ToastInput, "id" | "title" | "variant" | "duration">> {
  description?: React.ReactNode;
  action?: ToastAction;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/*  Store (works outside React too: `toast({ title })` from anywhere)  */
/* ------------------------------------------------------------------ */

type Listener = () => void;

let items: ToastItem[] = [];
const listeners = new Set<Listener>();
let counter = 0;
const MAX_VISIBLE = 5;

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ToastItem[] {
  return items;
}

const EMPTY: ToastItem[] = [];
function getServerSnapshot(): ToastItem[] {
  return EMPTY;
}

/** Show a toast. Returns its id. */
export function toast(input: ToastInput): string {
  const id = input.id ?? `toast-${++counter}`;
  const next: ToastItem = {
    id,
    title: input.title,
    description: input.description,
    variant: input.variant ?? "default",
    duration: input.duration ?? (input.variant === "danger" ? 8000 : 5000),
    action: input.action,
    createdAt: Date.now(),
  };
  const existing = items.findIndex((t) => t.id === id);
  if (existing >= 0) {
    items = items.map((t, i) => (i === existing ? next : t));
  } else {
    items = [...items, next].slice(-MAX_VISIBLE);
  }
  emit();
  return id;
}

toast.success = (title: React.ReactNode, description?: React.ReactNode) =>
  toast({ title, description, variant: "success" });
toast.error = (title: React.ReactNode, description?: React.ReactNode) =>
  toast({ title, description, variant: "danger" });
toast.warning = (title: React.ReactNode, description?: React.ReactNode) =>
  toast({ title, description, variant: "warning" });
toast.info = (title: React.ReactNode, description?: React.ReactNode) =>
  toast({ title, description, variant: "info" });

export function dismissToast(id?: string): void {
  items = id ? items.filter((t) => t.id !== id) : [];
  emit();
}

/** Subscribe to the toast queue and get the `toast`/`dismiss` helpers. */
export function useToast() {
  const toasts = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { toasts, toast, dismiss: dismissToast };
}

/* ------------------------------------------------------------------ */
/*  Rendering                                                          */
/* ------------------------------------------------------------------ */

const variantMeta: Record<ToastVariant, { icon: React.ReactNode; iconClass: string; bar: string }> = {
  default: { icon: <Info aria-hidden="true" />, iconClass: "text-ink-muted", bar: "bg-ink-subtle" },
  success: { icon: <CircleCheck aria-hidden="true" />, iconClass: "text-success", bar: "bg-success" },
  warning: { icon: <TriangleAlert aria-hidden="true" />, iconClass: "text-warning", bar: "bg-warning" },
  danger: { icon: <CircleAlert aria-hidden="true" />, iconClass: "text-danger", bar: "bg-danger" },
  info: { icon: <Info aria-hidden="true" />, iconClass: "text-info", bar: "bg-info" },
};

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const [paused, setPaused] = React.useState(false);
  const meta = variantMeta[item.variant];

  React.useEffect(() => {
    if (item.duration <= 0 || paused) return;
    const timer = window.setTimeout(onDismiss, item.duration);
    return () => window.clearTimeout(timer);
  }, [item.duration, item.createdAt, paused, onDismiss]);

  return (
    <div
      role={item.variant === "danger" || item.variant === "warning" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cn(
        "pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-md border border-border bg-surface-raised p-3.5 pr-10 text-ink shadow-pop",
        "animate-slide-up",
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-0.75", meta.bar)} aria-hidden="true" />
      <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", meta.iconClass)}>{meta.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium leading-5">{item.title}</div>
        {item.description ? <div className="mt-0.5 text-sm text-ink-muted">{item.description}</div> : null}
        {item.action ? (
          <button
            type="button"
            onClick={() => {
              item.action?.onClick();
              onDismiss();
            }}
            className="mt-2 text-sm font-medium text-accent-ink underline-offset-4 hover:underline focus-ring rounded-xs"
          >
            {item.action.label}
          </button>
        ) : null}
      </div>
      <IconButton label="Dismiss" size="xs" onClick={onDismiss} className="absolute right-2 top-2">
        <X />
      </IconButton>
    </div>
  );
}

export interface ToasterProps {
  position?: "bottom-right" | "bottom-center" | "top-right" | "top-center";
  className?: string;
}

const positions: Record<NonNullable<ToasterProps["position"]>, string> = {
  "bottom-right": "bottom-4 right-4 items-end",
  "bottom-center": "bottom-4 left-1/2 -translate-x-1/2 items-center",
  "top-right": "top-4 right-4 items-end",
  "top-center": "top-4 left-1/2 -translate-x-1/2 items-center",
};

/** Mount once (AppShell does this). Renders the toast queue. */
export function Toaster({ position = "bottom-right", className }: ToasterProps) {
  const { toasts, dismiss } = useToast();

  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      className={cn(
        "pointer-events-none fixed z-[100] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2",
        "max-lg:bottom-[calc(var(--tabbar-height)+0.5rem)]",
        positions[position],
        className,
      )}
    >
      {toasts.map((item) => (
        <ToastView key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
      ))}
    </div>
  );
}

/** Optional provider: renders children + a Toaster. The store is global. */
export function ToastProvider({ children, position }: { children: React.ReactNode; position?: ToasterProps["position"] }) {
  return (
    <>
      {children}
      <Toaster position={position} />
    </>
  );
}
