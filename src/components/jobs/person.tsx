import * as React from "react";
import Link from "next/link";
import { UserRound } from "lucide-react";
import { Avatar, type AvatarSize } from "@/components/ui/avatar";
import { ROLE_LABELS } from "@/lib/constants";
import type { UserRef } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Minimal person shape accepted by the chips (UserRef or a reduced projection). */
export type PersonRef = Pick<UserRef, "id" | "name"> & Partial<Pick<UserRef, "role" | "avatarColour" | "isActive">>;

export interface PersonChipProps {
  user: PersonRef | null;
  size?: Extract<AvatarSize, "xs" | "sm" | "md">;
  /** Small caption before the name ("Editor", "Photographer"). */
  label?: string;
  /** Text when `user` is null. */
  emptyLabel?: string;
  /** Link the chip (e.g. `/team/users/[id]`). */
  href?: string;
  /** Avatar only; the name goes to the tooltip. */
  avatarOnly?: boolean;
  className?: string;
}

/** Avatar + name for a job's photographer / editor; "Unassigned" placeholder when null. */
export function PersonChip({ user, size = "sm", label, emptyLabel = "Unassigned", href, avatarOnly = false, className }: PersonChipProps) {
  const dims = size === "xs" ? "size-5" : size === "sm" ? "size-6" : "size-8";

  if (!user) {
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-2 text-sm text-ink-subtle", className)} title={label ? `${label}: ${emptyLabel}` : emptyLabel}>
        <span
          aria-hidden="true"
          className={cn("inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-border-strong text-ink-subtle", dims)}
        >
          <UserRound className="size-3" />
        </span>
        {avatarOnly ? <span className="sr-only">{emptyLabel}</span> : <span className="truncate italic">{emptyLabel}</span>}
      </span>
    );
  }

  const inactive = user.isActive === false;
  const roleLabel = user.role ? ROLE_LABELS[user.role] : undefined;
  const title = [label, user.name, inactive ? "(deactivated)" : null].filter(Boolean).join(" · ");

  const body = (
    <>
      <Avatar
        name={user.name}
        size={size}
        colour={user.avatarColour || undefined}
        className={cn(inactive && "opacity-50 grayscale")}
      />
      {avatarOnly ? (
        <span className="sr-only">{title}</span>
      ) : (
        <span className="flex min-w-0 flex-col leading-tight">
          {label ? <span className="text-2xs text-ink-subtle">{label}</span> : null}
          <span className={cn("truncate text-sm text-ink", inactive && "text-ink-muted line-through decoration-ink-subtle")}>
            {user.name}
          </span>
        </span>
      )}
    </>
  );

  const classes = cn("inline-flex min-w-0 items-center gap-2", className);
  if (href) {
    return (
      <Link href={href} title={title || roleLabel} className={cn(classes, "rounded-sm focus-ring hover:[&_span.truncate]:underline underline-offset-2")}>
        {body}
      </Link>
    );
  }
  return (
    <span className={classes} title={title || roleLabel}>
      {body}
    </span>
  );
}

export interface PersonStackProps {
  users: (PersonRef | null | undefined)[];
  /** Avatars shown before "+N". */
  max?: number;
  size?: Extract<AvatarSize, "xs" | "sm" | "md">;
  className?: string;
}

/** Overlapping avatars for several people (photographer + editor, team members). */
export function PersonStack({ users, max = 3, size = "sm", className }: PersonStackProps) {
  const people = users.filter((u): u is PersonRef => Boolean(u));
  const seen = new Set<string>();
  const unique = people.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  if (unique.length === 0) return null;
  const shown = unique.slice(0, max);
  const rest = unique.length - shown.length;
  const label = unique.map((u) => u.name).join(", ");
  return (
    <span role="group" aria-label={label} title={label} className={cn("inline-flex items-center -space-x-1.5", className)}>
      {shown.map((u) => (
        <Avatar
          key={u.id}
          name={u.name}
          size={size}
          colour={u.avatarColour || undefined}
          className={cn("ring-2 ring-surface", u.isActive === false && "opacity-50 grayscale")}
        />
      ))}
      {rest > 0 ? (
        <span
          className={cn(
            "inline-flex items-center justify-center rounded-full bg-surface-muted font-medium text-ink-muted ring-2 ring-surface numeric",
            size === "xs" ? "size-5 text-2xs" : size === "sm" ? "size-6 text-2xs" : "size-8 text-xs",
          )}
        >
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
