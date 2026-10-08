"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "./icon-button";
import { useModalDialog } from "./use-modal-dialog";

interface SheetContextValue {
  close: () => void;
  titleId: string;
  descriptionId: string;
}

const SheetContext = React.createContext<SheetContextValue | null>(null);

function useSheetContext(component: string): SheetContextValue {
  const ctx = React.useContext(SheetContext);
  if (!ctx) throw new Error(`<${component}> must be used inside <Sheet>`);
  return ctx;
}

export type SheetSide = "left" | "right" | "bottom";

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  side?: SheetSide;
  /** Panel width (left/right) or height (bottom). */
  size?: "sm" | "md" | "lg" | "xl";
  dismissible?: boolean;
  className?: string;
  /** Accessible name when there is no SheetTitle. */
  "aria-label"?: string;
}

const widths = {
  sm: "sm:w-80",
  md: "sm:w-[420px]",
  lg: "sm:w-[560px]",
  xl: "sm:w-[720px]",
} as const;

const heights = {
  sm: "h-[40dvh]",
  md: "h-[60dvh]",
  lg: "h-[80dvh]",
  xl: "h-[92dvh]",
} as const;

/**
 * Side drawer on the native `<dialog>` element. Used for mobile
 * navigation, filters and the mobile job detail.
 */
export function Sheet({
  open,
  onOpenChange,
  children,
  side = "right",
  size = "md",
  dismissible = true,
  className,
  "aria-label": ariaLabel,
}: SheetProps) {
  const { ref, handleCancel, handleClose, handleBackdropClick, close } = useModalDialog({
    open,
    onOpenChange,
    dismissible,
  });
  const titleId = React.useId();
  const descriptionId = React.useId();
  const ctx = React.useMemo<SheetContextValue>(
    () => ({ close, titleId, descriptionId }),
    [close, titleId, descriptionId],
  );

  const position =
    side === "left"
      ? cn("inset-y-0 left-0 right-auto h-dvh w-[88vw] max-w-[88vw]", widths[size], "open:animate-slide-in-left")
      : side === "right"
        ? cn("inset-y-0 right-0 left-auto h-dvh w-[88vw] max-w-[88vw]", widths[size], "open:animate-slide-in-right")
        : cn("inset-x-0 bottom-0 top-auto w-full max-w-none", heights[size], "open:animate-slide-in-bottom");

  return (
    <dialog
      ref={ref}
      onCancel={handleCancel}
      onClose={handleClose}
      onClick={handleBackdropClick}
      aria-labelledby={ariaLabel ? undefined : titleId}
      aria-label={ariaLabel}
      aria-describedby={descriptionId}
      className={cn("fixed m-0 bg-transparent p-0 outline-none", position)}
    >
      <SheetContext.Provider value={ctx}>
        {open ? (
          <div
            className={cn(
              "flex h-full w-full flex-col overflow-hidden bg-surface-raised text-ink shadow-pop",
              side === "left" && "border-r border-border",
              side === "right" && "border-l border-border",
              side === "bottom" && "rounded-t-xl border-t border-border safe-bottom",
              className,
            )}
          >
            {children}
          </div>
        ) : null}
      </SheetContext.Provider>
    </dialog>
  );
}

export interface SheetHeaderProps extends React.ComponentPropsWithRef<"div"> {
  hideClose?: boolean;
}

export function SheetHeader({ className, children, hideClose, ...props }: SheetHeaderProps) {
  const { close } = useSheetContext("SheetHeader");
  return (
    <div
      className={cn("flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4", className)}
      {...props}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {!hideClose ? (
        <IconButton label="Close" size="sm" onClick={close} className="-mr-1.5">
          <X />
        </IconButton>
      ) : null}
    </div>
  );
}

export function SheetTitle({ className, ...props }: React.ComponentPropsWithRef<"h2">) {
  const { titleId } = useSheetContext("SheetTitle");
  return <h2 id={titleId} className={cn("text-md font-semibold leading-6 text-ink", className)} {...props} />;
}

export function SheetDescription({ className, ...props }: React.ComponentPropsWithRef<"p">) {
  const { descriptionId } = useSheetContext("SheetDescription");
  return <p id={descriptionId} className={cn("mt-0.5 text-sm text-ink-muted", className)} {...props} />;
}

export function SheetBody({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin", className)} {...props} />;
}

export function SheetFooter({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t border-border bg-surface-sunken px-5 py-3 sm:flex-row sm:items-center sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

export function useSheet() {
  return useSheetContext("useSheet");
}
