"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { buttonVariants, type ButtonProps } from "./button";
import { Spinner } from "./spinner";
import { useAutoFlip, useControllableOpen, useDismissable, useViewportClamp } from "./use-dismissable";

interface PopoverContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  contentId: string;
}

const PopoverContext = React.createContext<PopoverContextValue | null>(null);

function usePopoverContext(component: string): PopoverContextValue {
  const ctx = React.useContext(PopoverContext);
  if (!ctx) throw new Error(`<${component}> must be used inside <Popover>`);
  return ctx;
}

export interface PopoverProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}

/** Non-modal floating panel anchored to a trigger (filters, pickers, hints). */
export function Popover({ open, defaultOpen = false, onOpenChange, children, className }: PopoverProps) {
  const [isOpen, setOpen] = useControllableOpen(open, defaultOpen, onOpenChange);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const contentId = React.useId();

  useDismissable({ open: isOpen, onDismiss: () => setOpen(false), refs: [triggerRef, contentRef] });

  const ctx = React.useMemo<PopoverContextValue>(
    () => ({ open: isOpen, setOpen, triggerRef, contentRef, contentId }),
    [isOpen, setOpen, contentId],
  );

  return (
    <PopoverContext.Provider value={ctx}>
      <div className={cn("relative inline-flex", className)}>{children}</div>
    </PopoverContext.Provider>
  );
}

export type PopoverTriggerProps = Omit<Extract<ButtonProps, { href?: undefined }>, "href">;

export function PopoverTrigger({
  variant = "outline",
  size = "md",
  className,
  children,
  onClick,
  loading,
  leadingIcon,
  trailingIcon,
  ...props
}: PopoverTriggerProps) {
  const { open, setOpen, triggerRef, contentId } = usePopoverContext("PopoverTrigger");
  return (
    <button
      ref={triggerRef}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? contentId : undefined}
      aria-busy={loading || undefined}
      disabled={props.disabled || loading}
      data-state={open ? "open" : "closed"}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setOpen(!open);
      }}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {loading ? <Spinner size="xs" className="text-current" /> : leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
}

export interface PopoverContentProps extends React.ComponentPropsWithRef<"div"> {
  align?: "start" | "end" | "center";
  side?: "top" | "bottom";
  /** Accessible name. */
  "aria-label"?: string;
}

export function PopoverContent(props: PopoverContentProps) {
  const { open } = usePopoverContext("PopoverContent");
  if (!open) return null;
  return <PopoverPanel {...props} />;
}

/** Mounted only while open, so focus + auto-flip run on every open. */
function PopoverPanel({ align = "start", side = "bottom", className, children, onKeyDown, ...props }: PopoverContentProps) {
  const { setOpen, triggerRef, contentRef, contentId } = usePopoverContext("PopoverContent");
  useAutoFlip(contentRef, side);
  useViewportClamp(contentRef, align);

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = contentRef.current;
      if (!el) return;
      const focusable = el.querySelector<HTMLElement>(
        'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])',
      );
      (focusable ?? el).focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [contentRef]);

  return (
    <div
      ref={contentRef}
      id={contentId}
      role="dialog"
      tabIndex={-1}
      data-side={side}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
      className={cn(
        "absolute z-(--z-popover) min-w-56 rounded-md border border-border bg-surface-raised p-4 text-ink shadow-pop outline-none",
        "data-[side=bottom]:top-full data-[side=bottom]:mt-1.5 data-[side=bottom]:animate-slide-down",
        "data-[side=top]:bottom-full data-[side=top]:mb-1.5 data-[side=top]:animate-slide-up",
        align === "start" && "left-0",
        align === "end" && "right-0",
        align === "center" && "left-1/2 -translate-x-1/2",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function usePopover() {
  const { open, setOpen } = usePopoverContext("usePopover");
  return { open, setOpen };
}
