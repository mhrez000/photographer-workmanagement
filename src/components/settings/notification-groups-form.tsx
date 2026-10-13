"use client";

import * as React from "react";
import { BellRing, CheckCheck, ChevronDown, Lock, RotateCcw } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { useMutationRunner } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import {
  NOTIFICATION_GROUPS,
  NOTIFICATION_GROUP_LABELS,
  NOTIFICATION_TYPE_META,
  notificationTypesOfGroup,
  type NotificationGroup,
  type NotificationType,
  type Role,
} from "@/lib/constants";
import type { NotificationPrefView } from "@/lib/types";
import { cn } from "@/lib/utils";

/** One line under each of the 8 groups (docs/SIMPLIFICATION-PLAN.md §8), written for the person reading it. */
const OWNER_HINT: Record<NotificationGroup, string> = {
  job_given: "A job was given to you to shoot or check.",
  ready_to_check: "An editor sent a job back: your turn.",
  changes_asked: "Changes were asked on a job you are on.",
  approved: "A job you are on was approved.",
  message: "Someone wrote on a job or @mentioned you.",
  client_feedback: "A client left feedback, or the studio replied.",
  late_summary: "One summary a day of jobs past their due date.",
  taken_off: "A job was moved to someone else, taken back or cancelled.",
};

const EDITOR_HINT: Record<NotificationGroup, string> = {
  job_given: "A job lands on your desk.",
  ready_to_check: "The photographer hears when you send a job for checking.",
  changes_asked: "The photographer asked for changes — you hear straight away.",
  approved: "A job you sent was approved.",
  message: "Someone wrote on one of your jobs or @mentioned you.",
  client_feedback: "A client left feedback on one of your jobs.",
  late_summary: "One summary a day of your jobs past their due date.",
  taken_off: "A job was moved to someone else, taken back or cancelled.",
};

/** Groups that never fire for an editor (they tell the photographer something about the editor's work). */
const NOT_FOR_EDITORS: readonly NotificationGroup[] = ["ready_to_check", "client_feedback"];

export interface NotificationGroupsFormProps {
  userId: string;
  prefs: NotificationPrefView[];
  /** Unread notices of the now-hidden types (for "Mark old updates as read"). */
  oldUnreadCount: number;
  /** Who is reading: the descriptions are written for them (editors never see the groups that are not for them). */
  role?: Role;
}

/**
 * My account → Notifications: the 8 groups as plain toggles. A group is on when every type in it
 * that CAN be switched is on; types that are always on show a lock. The hidden types sit under
 * "More updates", off by default, each still selectable; the line says the REAL state and offers
 * "Use the 8 defaults" when any of them is on (plan §8).
 */
export function NotificationGroupsForm({ userId, prefs, oldUnreadCount, role = "photographer" }: NotificationGroupsFormProps) {
  const run = useMutationRunner();
  const [overrides, setOverrides] = React.useState<Partial<Record<NotificationType, boolean>>>({});
  const [pending, setPending] = React.useState<string | null>(null);
  const [showMore, setShowMore] = React.useState(false);
  const [marked, setMarked] = React.useState(false);
  const byType = new Map(prefs.map((p) => [p.type, p]));
  const isOn = (t: NotificationType) => overrides[t] ?? byType.get(t)?.enabled ?? false;
  const editor = role === "editor";
  const hint = editor ? EDITOR_HINT : OWNER_HINT;
  const groups = NOTIFICATION_GROUPS.filter((g) => !editor || !NOT_FOR_EDITORS.includes(g));

  const grouped = new Set<NotificationType>(NOTIFICATION_GROUPS.flatMap((g) => notificationTypesOfGroup(g)));
  const more = prefs.filter((p) => !grouped.has(p.type));
  const moreOn = more.filter((p) => isOn(p.type)).length;

  const put = async (changes: Partial<Record<NotificationType, boolean>>, key: string, success: string) => {
    setOverrides((o) => ({ ...o, ...changes }));
    setPending(key);
    const res = await run(() => api.put(`/api/users/${userId}/notification-prefs`, { prefs: changes }), { success });
    setPending(null);
    setOverrides((o) => {
      const copy = { ...o };
      for (const k of Object.keys(changes) as NotificationType[]) delete copy[k];
      return copy;
    });
    return res.ok;
  };

  const toggleGroup = async (group: NotificationGroup, next: boolean) => {
    const types = notificationTypesOfGroup(group).filter((t) => byType.has(t) && !byType.get(t)?.mandatory);
    if (types.length === 0) return;
    await put(Object.fromEntries(types.map((t) => [t, next])), group, `${NOTIFICATION_GROUP_LABELS[group]}: ${next ? "on" : "off"}`);
  };

  /** Back to the plan's defaults: every group on, every "More updates" type off. */
  const resetToDefaults = async () => {
    const changes: Partial<Record<NotificationType, boolean>> = {};
    for (const p of more) if (!p.mandatory && isOn(p.type)) changes[p.type] = false;
    for (const g of NOTIFICATION_GROUPS) for (const t of notificationTypesOfGroup(g)) if (byType.has(t) && !byType.get(t)?.mandatory && !isOn(t)) changes[t] = true;
    if (Object.keys(changes).length === 0) return;
    await put(changes, "defaults", "Back to the 8 defaults");
  };

  const markOld = async () => {
    setPending("mark-old");
    const res = await run(() => api.post<{ updated: number }>("/api/me/mark-old-updates-read", {}), {
      success: "Old updates marked as read",
    });
    setPending(null);
    if (res.ok) setMarked(true);
  };

  return (
    <SectionCard
      id="notifications"
      title="Notifications"
      description="Eight kinds are on by default, so a red badge always means something needs you. Changes apply straight away and only to you."
      actions={<BellRing aria-hidden="true" className="size-4 text-ink-subtle" />}
    >
      <ul className="flex flex-col divide-y divide-border" data-notification-groups="">
        {groups.map((group) => {
          const types = notificationTypesOfGroup(group).filter((t) => byType.has(t));
          if (types.length === 0) return null;
          const switchable = types.filter((t) => !byType.get(t)?.mandatory);
          const locked = switchable.length === 0;
          const on = locked ? true : switchable.every(isOn);
          const partlyLocked = !locked && switchable.length < types.length;
          return (
            <li key={group} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p id={`group-${group}`} className="flex flex-wrap items-center gap-1.5 text-base text-ink">
                  {NOTIFICATION_GROUP_LABELS[group]}
                  {locked ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-1.5 py-0.5 text-2xs font-medium text-ink-muted">
                      <Lock aria-hidden="true" className="size-3" />
                      Always on
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-sm text-ink-muted">
                  {hint[group]}
                  {partlyLocked ? <span className="text-ink-subtle"> (@mentions and jobs taken off you are always on.)</span> : null}
                </p>
              </div>
              <Switch
                checked={on}
                onCheckedChange={(v) => void toggleGroup(group, v)}
                disabled={locked || pending !== null}
                aria-labelledby={`group-${group}`}
                aria-busy={pending === group || undefined}
              />
            </li>
          );
        })}
      </ul>

      {more.length > 0 ? (
        <div className="mt-5 border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setShowMore((s) => !s)}
            aria-expanded={showMore}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-ink hover:underline focus-ring rounded-xs"
          >
            <ChevronDown aria-hidden="true" className={cn("size-4 transition-transform duration-(--motion-fast)", showMore && "rotate-180")} />
            More updates ({moreOn} of {more.length} on)
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted" data-more-state={moreOn === 0 ? "defaults" : "custom"}>
            <span>
              {moreOn === 0
                ? "All off, as they are for everyone by default. Turn one on if you want to hear about it."
                : `${moreOn === more.length ? "All" : moreOn} on for you (off by default). Turn off the ones you don't need, or go back to the defaults.`}
            </span>
            {moreOn > 0 ? (
              <Button variant="outline" size="sm" leadingIcon={<RotateCcw aria-hidden="true" />} onClick={() => void resetToDefaults()} loading={pending === "defaults"} disabled={pending !== null} data-use-defaults="">
                Use the 8 defaults
              </Button>
            ) : null}
          </div>
          {showMore ? (
            <ul className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border px-3" data-more-notifications="">
              {more.map((p) => (
                <li key={p.type} className="flex items-center justify-between gap-4 py-2.5">
                  <p id={`pref-${p.type}`} className="text-sm text-ink">
                    {NOTIFICATION_TYPE_META[p.type]?.label ?? p.label}
                  </p>
                  <Switch
                    size="sm"
                    checked={isOn(p.type)}
                    onCheckedChange={(v) => void put({ [p.type]: v }, p.type, v ? "Turned on" : "Turned off")}
                    disabled={p.mandatory || pending !== null}
                    aria-labelledby={`pref-${p.type}`}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 flex flex-col gap-3 rounded-md bg-surface-sunken px-3 py-2.5 text-sm text-ink-secondary sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-start gap-2">
          <CheckCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
          {marked || oldUnreadCount === 0 ? "No old updates waiting. Nothing is ever deleted." : `${oldUnreadCount} older ${oldUnreadCount === 1 ? "update" : "updates"} of the kinds that are now off are still unread.`}
        </span>
        <Button variant="outline" size="sm" onClick={() => void markOld()} loading={pending === "mark-old"} disabled={marked || oldUnreadCount === 0} className="shrink-0" data-mark-old-read="">
          Mark old updates as read
        </Button>
      </div>
    </SectionCard>
  );
}
