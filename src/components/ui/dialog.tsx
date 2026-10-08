"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "./icon-button";
import { useModalDialog } from "./use-modal-dialog";

interface DialogContextValue {
  close: () => void;
  titleId: string;
  descriptionId: string;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialogContext(component: string): DialogContextValue {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error(`<${component}> must be used inside <Dialog>`);
  return ctx;
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl" | "full";
  /** Escape / backdrop click close the dialog (default true). */
  dismissible?: boolean;
  /** Class for the panel. */
  className?: string;
}

const sizes = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  xl: "sm:max-w-4xl",
  full: "sm:max-w-[calc(100vw-4rem)]",
} as const;

/**
 * Modal dialog on the native `<dialog>` element — focus trapping, inert
 * background and Escape handling come from the platform. Content is only
 * mounted while open, so forms reset naturally.
 */
export function Dialog({ open, onOpenChange, children, size = "md", dismissible = true, className }: DialogProps) {
  const { ref, handleCancel, handleClose, handleBackdropClick, close } = useModalDialog({
    open,
    onOpenChange,
    dismissible,
  });
  const titleId = React.useId();
  const descriptionId = React.useId();

  const ctx = React.useMemo<DialogContextValue>(
    () => ({ close, titleId, descriptionId }),
    [close, titleId, descriptionId],
  );

  return (
    <dialog
      ref={ref}
      onCancel={handleCancel}
      onClose={handleClose}
      onClick={handleBackdropClick}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={cn(
        "m-auto w-full max-w-[calc(100vw-2rem)] bg-transparent p-0 outline-none",
        "open:animate-scale-in",
        sizes[size],
      )}
    >
      <DialogContext.Provider value={ctx}>
        {open ? (
          <div
            className={cn(
              "flex max-h-[calc(100dvh-4rem)] flex-col overflow-hidden rounded-lg border border-border bg-surface-raised text-ink shadow-pop",
              className,
            )}
          >
            {children}
          </div>
        ) : null}
      </DialogContext.Provider>
    </dialog>
  );
}

export interface DialogHeaderProps extends React.ComponentPropsWithRef<"div"> {
  /** Hide the top-right close button. */
  hideClose?: boolean;
}

export function DialogHeader({ className, children, hideClose, ...props }: DialogHeaderProps) {
  const { close } = useDialogContext("DialogHeader");
  return (
    <div className={cn("flex items-start justify-between gap-4 px-6 pt-5 pb-3", className)} {...props}>
      <div className="min-w-0 flex-1">{children}</div>
      {!hideClose ? (
        <IconButton label="Close" size="sm" onClick={close} className="-mr-2 -mt-1">
          <X />
        </IconButton>
      ) : null}
    </div>
  );
}

export function DialogTitle({ className, ...props }: React.ComponentPropsWithRef<"h2">) {
  const { titleId } = useDialogContext("DialogTitle");
  return <h2 id={titleId} className={cn("text-lg font-semibold leading-6 text-ink", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.ComponentPropsWithRef<"p">) {
  const { descriptionId } = useDialogContext("DialogDescription");
  return <p id={descriptionId} className={cn("mt-1 text-sm text-ink-muted", className)} {...props} />;
}

/** Scrollable middle section. */
export function DialogBody({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-6 py-2 scrollbar-thin", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 border-t border-border bg-surface-sunken px-6 py-4 sm:flex-row sm:items-center sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

/** Any element that closes the dialog on click (wrap a Button). */
export function DialogClose({ children }: { children: React.ReactElement<{ onClick?: React.MouseEventHandler }> }) {
  const { close } = useDialogContext("DialogClose");
  return React.cloneElement(children, {
    onClick: (event: React.MouseEvent) => {
      children.props.onClick?.(event);
      if (!event.defaultPrevented) close();
    },
  });
}

/** Imperative access to close from nested components. */
export function useDialog() {
  return useDialogContext("useDialog");
}
