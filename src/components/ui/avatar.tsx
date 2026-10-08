import * as React from "react";
import { cn, hueFromString, initials, type CSSVariables } from "@/lib/utils";

export const avatarSizes = {
  xs: "size-5 text-2xs",
  sm: "size-6 text-2xs",
  md: "size-8 text-xs",
  lg: "size-10 text-sm",
  xl: "size-14 text-lg",
} as const;

export type AvatarSize = keyof typeof avatarSizes;

export interface AvatarProps extends Omit<React.ComponentPropsWithRef<"span">, "children"> {
  /** Full name — drives initials and the deterministic tint. */
  name: string;
  size?: AvatarSize;
  /** Override the tint with any CSS colour (e.g. a stored `avatarColour`). */
  colour?: string;
  /** Square-ish (rounded) instead of circular — e.g. for clients/orgs. */
  shape?: "circle" | "rounded";
  /** Presence dot. */
  status?: "online" | "away" | "busy" | "offline";
}

const statusDot: Record<NonNullable<AvatarProps["status"]>, string> = {
  online: "bg-success",
  away: "bg-warning",
  busy: "bg-danger",
  offline: "bg-ink-subtle",
};

/**
 * Initials avatar with a colour derived deterministically from the name,
 * so the same person always looks the same across the product.
 */
export function Avatar({
  name,
  size = "md",
  colour,
  shape = "circle",
  status,
  className,
  style,
  ...props
}: AvatarProps) {
  const hue = hueFromString(name);
  const vars: CSSVariables = { "--avatar-h": hue, ...style };
  if (colour) {
    vars.backgroundColor = colour;
    vars.color = "#fff";
  }

  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center font-semibold uppercase leading-none tracking-wide avatar-tone ring-1 ring-inset ring-black/5",
        shape === "circle" ? "rounded-full" : "rounded-md",
        avatarSizes[size],
        className,
      )}
      style={vars}
      {...props}
    >
      {initials(name)}
      {status ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute -bottom-px -right-px block rounded-full ring-2 ring-surface",
            size === "xs" || size === "sm" ? "size-2" : "size-2.5",
            statusDot[status],
          )}
        />
      ) : null}
    </span>
  );
}

export interface AvatarGroupItem {
  name: string;
  colour?: string;
}

export interface AvatarGroupProps extends React.ComponentPropsWithRef<"div"> {
  items: AvatarGroupItem[];
  /** How many to show before collapsing into "+N". */
  max?: number;
  size?: AvatarSize;
}

/** Overlapping avatars with a "+N" overflow counter. */
export function AvatarGroup({ items, max = 4, size = "sm", className, ...props }: AvatarGroupProps) {
  const visible = items.slice(0, max);
  const overflow = items.length - visible.length;
  const names = items.map((i) => i.name).join(", ");

  return (
    <div
      className={cn("flex items-center -space-x-1.5", className)}
      role="group"
      aria-label={names}
      {...props}
    >
      {visible.map((item, index) => (
        <Avatar
          key={`${item.name}-${index}`}
          name={item.name}
          colour={item.colour}
          size={size}
          className="ring-2 ring-surface"
        />
      ))}
      {overflow > 0 ? (
        <span
          className={cn(
            "relative inline-flex shrink-0 items-center justify-center rounded-full bg-surface-muted font-medium text-ink-muted ring-2 ring-surface",
            avatarSizes[size],
          )}
          title={items.slice(max).map((i) => i.name).join(", ")}
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}
