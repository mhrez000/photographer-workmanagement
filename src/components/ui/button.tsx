import * as React from "react";
import Link from "next/link";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

export const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap",
    "font-medium tracking-snug transition-[background-color,border-color,color,box-shadow,opacity] duration-(--motion-fast) ease-out-soft",
    "focus-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg shadow-xs hover:bg-accent-hover active:bg-accent-active",
        secondary:
          "bg-surface-muted text-ink hover:bg-border/70 active:bg-border",
        outline:
          "border border-border bg-surface text-ink shadow-xs hover:border-border-hover hover:bg-surface-muted active:bg-surface-muted",
        ghost: "text-ink-secondary hover:bg-surface-muted hover:text-ink active:bg-border/60",
        danger: "bg-danger text-white shadow-xs hover:bg-danger-hover",
        link: "h-auto rounded-none p-0 text-accent-ink underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 rounded-sm px-2.5 text-sm [&_svg]:size-3.5",
        md: "h-9 rounded-md px-3.5 text-base [&_svg]:size-4",
        lg: "h-10 rounded-md px-4 text-md [&_svg]:size-4",
        icon: "size-9 rounded-md p-0 [&_svg]:size-4",
      },
    },
    compoundVariants: [
      { variant: "link", size: "sm", className: "h-auto px-0" },
      { variant: "link", size: "md", className: "h-auto px-0" },
      { variant: "link", size: "lg", className: "h-auto px-0" },
    ],
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

type ButtonVariantProps = VariantProps<typeof buttonVariants>;

interface ButtonBaseProps extends ButtonVariantProps {
  /** Shows a spinner and disables the control. */
  loading?: boolean;
  /** Icon rendered before the label. */
  leadingIcon?: React.ReactNode;
  /** Icon rendered after the label. */
  trailingIcon?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

export type ButtonAsButtonProps = ButtonBaseProps &
  Omit<React.ComponentPropsWithRef<"button">, keyof ButtonBaseProps | "href"> & {
    href?: undefined;
  };

export type ButtonAsLinkProps = ButtonBaseProps &
  Omit<React.ComponentPropsWithRef<"a">, keyof ButtonBaseProps | "href"> & {
    /** Renders a Next.js `<Link>` styled as a button. */
    href: string;
    prefetch?: boolean;
    disabled?: boolean;
  };

export type ButtonProps = ButtonAsButtonProps | ButtonAsLinkProps;

/**
 * Button — the only clickable primitive you need. Pass `href` to render a
 * Next `<Link>` with identical styling. `loading` swaps the leading icon
 * for a spinner and disables interaction.
 */
export function Button(props: ButtonProps) {
  const {
    variant,
    size,
    loading = false,
    leadingIcon,
    trailingIcon,
    className,
    children,
    ...rest
  } = props;

  const classes = cn(buttonVariants({ variant, size }), loading && "cursor-progress", className);

  const content = (
    <>
      {loading ? (
        <Spinner size={size === "sm" ? "xs" : "sm"} className="text-current" />
      ) : (
        leadingIcon
      )}
      {children}
      {trailingIcon}
    </>
  );

  if (rest.href !== undefined) {
    const { href, disabled, prefetch, ...anchorRest } = rest as ButtonAsLinkProps;
    const isDisabled = disabled || loading;
    return (
      <Link
        href={href}
        prefetch={prefetch}
        aria-disabled={isDisabled || undefined}
        tabIndex={isDisabled ? -1 : undefined}
        className={classes}
        {...anchorRest}
      >
        {content}
      </Link>
    );
  }

  const { disabled, type = "button", ...buttonRest } = rest as ButtonAsButtonProps;
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes}
      {...buttonRest}
    >
      {content}
    </button>
  );
}
