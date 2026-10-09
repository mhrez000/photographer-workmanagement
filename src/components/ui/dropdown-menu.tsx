"use client";

import * as React from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants, type ButtonProps } from "./button";
import { Spinner } from "./spinner";
import { moveFocus, useAutoFlip, useControllableOpen, useDismissable, useViewportClamp } from "./use-dismissable";

interface MenuContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  menuId: string;
}

const MenuContext = React.createContext<MenuContextValue | null>(null);

function useMenuContext(component: string): MenuContextValue {
  const ctx = React.useContext(MenuContext);
  if (!ctx) throw new Error(`<${component}> must be used inside <DropdownMenu>`);
  return ctx;
}

const ITEM_SELECTOR = '[role^="menuitem"]';

export interface DropdownMenuProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}

/** Root: owns open state and the trigger/content refs. */
export function DropdownMenu({ open, defaultOpen = false, onOpenChange, children, className }: DropdownMenuProps) {
  const [isOpen, setOpen] = useControllableOpen(open, defaultOpen, onOpenChange);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const menuId = React.useId();

  useDismissable({ open: isOpen, onDismiss: () => setOpen(false), refs: [triggerRef, contentRef] });

  const ctx = React.useMemo<MenuContextValue>(
    () => ({ open: isOpen, setOpen, triggerRef, contentRef, menuId }),
    [isOpen, setOpen, menuId],
  );

  return (
    <MenuContext.Provider value={ctx}>
      <div className={cn("relative inline-flex", className)}>{children}</div>
    </MenuContext.Provider>
  );
}

export type DropdownMenuTriggerProps = Omit<Extract<ButtonProps, { href?: undefined }>, "href">;

/** The button that opens the menu. Styled with the same variants as Button. */
export function DropdownMenuTrigger({
  variant = "outline",
  size = "md",
  className,
  children,
  onClick,
  onKeyDown,
  loading,
  leadingIcon,
  trailingIcon,
  ...props
}: DropdownMenuTriggerProps) {
  const { open, setOpen, triggerRef, menuId } = useMenuContext("DropdownMenuTrigger");

  return (
    <button
      ref={triggerRef}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-busy={loading || undefined}
      disabled={props.disabled || loading}
      data-state={open ? "open" : "closed"}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setOpen(!open);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setOpen(true);
        }
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

export interface DropdownMenuContentProps extends React.ComponentPropsWithRef<"div"> {
  align?: "start" | "end";
  side?: "top" | "bottom";
  /** Width in px / tailwind class. Defaults to min 180px. */
  width?: string;
  /** Accessible name of the menu. */
  "aria-label"?: string;
}

export function DropdownMenuContent(props: DropdownMenuContentProps) {
  const { open } = useMenuContext("DropdownMenuContent");
  if (!open) return null;
  return <MenuPanel {...props} />;
}

/** Mounted only while open, so initial focus + auto-flip run on every open. */
function MenuPanel({ align = "start", side = "bottom", width, className, children, onKeyDown, ...props }: DropdownMenuContentProps) {
  const { setOpen, triggerRef, contentRef, menuId } = useMenuContext("DropdownMenuContent");
  useAutoFlip(contentRef, side);
  useViewportClamp(contentRef, align);

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => moveFocus(contentRef.current, ITEM_SELECTOR, "first"));
    return () => cancelAnimationFrame(frame);
  }, [contentRef]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(contentRef.current, ITEM_SELECTOR, "next");
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(contentRef.current, ITEM_SELECTOR, "prev");
        break;
      case "Home":
        event.preventDefault();
        moveFocus(contentRef.current, ITEM_SELECTOR, "first");
        break;
      case "End":
        event.preventDefault();
        moveFocus(contentRef.current, ITEM_SELECTOR, "last");
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={contentRef}
      id={menuId}
      role="menu"
      tabIndex={-1}
      data-side={side}
      onKeyDown={handleKeyDown}
      className={cn(
        "absolute z-50 min-w-44 overflow-hidden rounded-md border border-border bg-surface-raised p-1 text-ink shadow-pop outline-none",
        "data-[side=bottom]:top-full data-[side=bottom]:mt-1.5 data-[side=bottom]:animate-slide-down",
        "data-[side=top]:bottom-full data-[side=top]:mb-1.5 data-[side=top]:animate-slide-up",
        align === "start" ? "left-0" : "right-0",
        className,
      )}
      style={width ? { width } : undefined}
      {...props}
    >
      {children}
    </div>
  );
}

export interface DropdownMenuItemProps
  extends Omit<React.ComponentPropsWithRef<"button">, "onSelect"> {
  icon?: React.ReactNode;
  /** Keyboard shortcut hint on the right. */
  shortcut?: string;
  destructive?: boolean;
  /** Called on activation; the menu closes afterwards unless `keepOpen`. */
  onSelect?: () => void;
  keepOpen?: boolean;
  /** Render as a Next Link. */
  href?: string;
  /** Checkable item. */
  checked?: boolean;
}

export function DropdownMenuItem({
  icon,
  shortcut,
  destructive,
  onSelect,
  keepOpen = false,
  href,
  checked,
  className,
  children,
  disabled,
  onClick,
  type = "button",
  ...props
}: DropdownMenuItemProps) {
  const { setOpen, triggerRef } = useMenuContext("DropdownMenuItem");

  const classes = cn(
    "group/item relative flex w-full cursor-pointer select-none items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left text-base outline-none",
    "transition-colors duration-(--motion-fast)",
    "hover:bg-surface-muted focus-visible:bg-surface-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
    destructive ? "text-danger hover:bg-danger-soft focus-visible:bg-danger-soft" : "text-ink",
    "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-muted",
    destructive && "[&_svg]:text-danger",
    className,
  );

  const activate = () => {
    onSelect?.();
    if (!keepOpen) {
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  const inner = (
    <>
      {checked !== undefined ? (
        <span className="flex size-4 items-center justify-center">
          {checked ? <Check aria-hidden="true" className="size-3.5 text-accent-ink" /> : null}
        </span>
      ) : (
        icon
      )}
      <span className="flex-1 truncate">{children}</span>
      {shortcut ? <span className="ml-4 text-xs text-ink-subtle">{shortcut}</span> : null}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        role="menuitem"
        tabIndex={-1}
        aria-disabled={disabled || undefined}
        data-disabled={disabled || undefined}
        className={classes}
        onClick={() => {
          if (!keepOpen) setOpen(false);
          onSelect?.();
        }}
      >
        {inner}
      </Link>
    );
  }

  return (
    <button
      type={type}
      role={checked !== undefined ? "menuitemcheckbox" : "menuitem"}
      aria-checked={checked !== undefined ? checked : undefined}
      tabIndex={-1}
      disabled={disabled}
      data-disabled={disabled || undefined}
      className={classes}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        activate();
      }}
      {...props}
    >
      {inner}
    </button>
  );
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div className={cn("px-2.5 pb-1 pt-1.5 eyebrow", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div role="separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

/** Small group wrapper for ARIA grouping. */
export function DropdownMenuGroup({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div role="group" className={cn("flex flex-col", className)} {...props} />;
}

/** Access to close from custom content. */
export function useDropdownMenu() {
  const { open, setOpen } = useMenuContext("useDropdownMenu");
  return { open, setOpen };
}
