"use client";

import * as React from "react";
import { Check, Lock, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  EDITOR_FLAGS,
  EDITOR_FLAG_META,
  MEMBER_ALWAYS_ON_ROWS,
  MEMBER_FLAGS,
  MEMBER_FLAG_META,
  type EditorFlag,
  type MemberFlag,
  type PermissionFlagMeta,
} from "@/lib/constants";
import { cn } from "@/lib/utils";

type Kind = "member" | "editor";
type FlagOf<K extends Kind> = K extends "member" ? MemberFlag : EditorFlag;

export interface PermissionSwitchesProps<K extends Kind> {
  /** Team member (non-admin photographer): 2 locked rows + 6 switches; editor: 2 switches (docs/ROLES.md §2.2). */
  kind: K;
  values: Record<FlagOf<K>, boolean>;
  /** Omit (or `readOnly`) to render a read-only list with on/off marks. */
  onToggle?: (flag: FlagOf<K>, value: boolean) => void;
  readOnly?: boolean;
  disabled?: boolean;
  /** Flag currently being saved (shows that row busy). */
  pendingFlag?: FlagOf<K> | null;
  /** Override the description per row ("you" wording on the profile page). */
  describe?: (meta: PermissionFlagMeta) => string;
  className?: string;
  /** Accessible name of the list. */
  "aria-label"?: string;
}

function Row({ label, description, control }: { label: React.ReactNode; description: React.ReactNode; control: React.ReactNode }) {
  return (
    <li className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </li>
  );
}

function StateMark({ on }: { on: boolean }) {
  return on ? (
    <Badge variant="success" size="sm">
      <Check aria-hidden="true" /> On
    </Badge>
  ) : (
    <Badge variant="neutral" size="sm">
      <Minus aria-hidden="true" /> Off
    </Badge>
  );
}

/**
 * The permission switch rows in the order of docs/ROLES.md §2.2, each with its
 * plain-English description. Team members show the two locked "Always on" rows first.
 */
export function PermissionSwitches<K extends Kind>({
  kind,
  values,
  onToggle,
  readOnly = !onToggle,
  disabled,
  pendingFlag = null,
  describe,
  className,
  ...aria
}: PermissionSwitchesProps<K>) {
  const flags = (kind === "member" ? MEMBER_FLAGS : EDITOR_FLAGS) as readonly FlagOf<K>[];
  const metaOf = (flag: FlagOf<K>): PermissionFlagMeta =>
    kind === "member" ? MEMBER_FLAG_META[flag as MemberFlag] : EDITOR_FLAG_META[flag as EditorFlag];

  return (
    <ul aria-label={aria["aria-label"]} className={cn("flex flex-col divide-y divide-border", className)} data-permission-switches={kind}>
      {kind === "member"
        ? MEMBER_ALWAYS_ON_ROWS.map((row) => (
            <Row
              key={row.label}
              label={row.label}
              description={row.description}
              control={
                <Badge variant="outline" size="sm">
                  <Lock aria-hidden="true" /> Always on
                </Badge>
              }
            />
          ))
        : null}
      {flags.map((flag) => {
        const meta = metaOf(flag);
        const on = values[flag];
        return (
          <Row
            key={flag}
            label={meta.label}
            description={describe ? describe(meta) : meta.description}
            control={
              readOnly ? (
                <StateMark on={on} />
              ) : (
                <Switch
                  checked={on}
                  aria-label={meta.label}
                  onCheckedChange={(v) => onToggle?.(flag, v)}
                  disabled={disabled || (pendingFlag !== null && pendingFlag !== flag)}
                  aria-busy={pendingFlag === flag || undefined}
                />
              )
            }
          />
        );
      })}
    </ul>
  );
}
