import * as React from "react";
import Link from "next/link";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

export const iconButtonVariants = cva(
  [
    "relative inline-flex shrink-0 select-none items-center justify-center",
    "transition-[background-color,border-color,color,box-shadow,opacity] duration-(--motion-fast) ease-out-soft",
    "focus-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        ghost: "text-ink-muted hover:bg-surface-muted hover:text-ink active:bg-border/60",
        outline:
          "border border-border bg-surface text-ink-secondary shadow-xs hover:border-border-hover hover:bg-surface-muted hover:text-ink",
        secondary: "bg-surface-muted text-ink hover:bg-border/70",
        primary: "bg-accent text-accent-fg shadow-xs hover:bg-accent-hover",
        danger: "text-danger hover:bg-danger-soft",
      },
      size: {
        xs: "size-6 pointer-coarse:size-8 rounded-xs [&_svg]:size-3.5",
        sm: "size-7 pointer-coarse:size-9 rounded-sm [&_svg]:size-4",
        md: "size-9 pointer-coarse:size-10 rounded-md [&_svg]:size-4",
        lg: "size-10 rounded-md [&_svg]:size-5",
      },
    },
    defaultVariants: {
      variant: "ghost",
      size: "md",
    },
  },
);

interface IconButtonBaseProps extends VariantProps<typeof iconButtonVariants> {
  /** Required: the accessible name (there is no visible label). */
  label: string;
  loading?: boolean;
  className?: string;
  children: React.ReactNode;
}

export type IconButtonProps = IconButtonBaseProps &
  (
    | (Omit<React.ComponentPropsWithRef<"button">, keyof IconButtonBaseProps | "href"> & {
        href?: undefined;
      })
    | (Omit<React.ComponentPropsWithRef<"a">, keyof IconButtonBaseProps | "href"> & {
        href: string;
        disabled?: boolean;
      })
  );

/** Square, icon-only button. Always pass `label` for screen readers. */
export function IconButton(props: IconButtonProps) {
  const { label, variant, size, loading = false, className, children, ...rest } = props;
  const classes = cn(iconButtonVariants({ variant, size }), className);
  const inner = loading ? <Spinner size="xs" className="text-current" /> : children;

  if (rest.href !== undefined) {
    const { href, disabled, ...anchorRest } = rest as Extract<IconButtonProps, { href: string }>;
    return (
      <Link
        href={href}
        aria-label={label}
        title={label}
        aria-disabled={disabled || loading || undefined}
        tabIndex={disabled || loading ? -1 : undefined}
        className={classes}
        {...anchorRest}
      >
        {inner}
      </Link>
    );
  }

  const { disabled, type = "button", ...buttonRest } = rest as Extract<
    IconButtonProps,
    { href?: undefined }
  >;
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes}
      {...buttonRest}
    >
      {inner}
    </button>
  );
}
