"use client";

import * as React from "react";
import { Lock } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { useMutationRunner } from "@/components/jobs/mutation";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api-client";
import type { NotificationType } from "@/lib/constants";
import type { NotificationPrefView } from "@/lib/types";

const GROUPS: { id: string; title: string; description: string; types: NotificationType[] }[] = [
  {
    id: "assignments",
    title: "Assignments",
    description: "Work coming to you or leaving you.",
    types: ["job_assigned", "job_reassigned", "job_unassigned", "job_declined"],
  },
  {
    id: "review",
    title: "Review & revisions",
    description: "Hand-offs between editing and review.",
    types: ["revision_requested", "work_submitted", "work_resubmitted", "work_approved"],
  },
  { id: "conversation", title: "Conversation", description: "Comments and mentions on jobs you're part of.", types: ["mentioned", "comment_added"] },
  {
    id: "deadlines",
    title: "Deadlines & priority",
    description: "Changes to when work is due and how urgent it is.",
    types: ["deadline_changed", "priority_changed", "job_overdue", "review_overdue"],
  },
  { id: "lifecycle", title: "Job lifecycle", description: "Completion, reopening, cancellation and pauses.", types: ["job_completed", "job_reopened", "job_cancelled", "job_paused"] },
  {
    id: "team",
    title: "Team & automations",
    description: "Mostly for owners and managers.",
    types: ["workload_threshold", "editor_unavailable", "automation"],
  },
];

const MANDATORY_REASON: Partial<Record<NotificationType, string>> = {
  job_assigned: "You always hear about work assigned to you.",
  job_reassigned: "You always hear when work moves away from you.",
  job_unassigned: "You always hear when you're taken off a job.",
  mentioned: "Someone asked for you directly.",
  revision_requested: "Revisions are assigned to you and have deadlines.",
};

/** Per-type in-app notification toggles (mandatory types locked on). */
export function NotificationPrefsForm({ userId, prefs }: { userId: string; prefs: NotificationPrefView[] }) {
  const run = useMutationRunner();
  const [overrides, setOverrides] = React.useState<Partial<Record<NotificationType, boolean>>>({});
  const [pending, setPending] = React.useState<NotificationType | null>(null);
  const byType = new Map(prefs.map((p) => [p.type, p]));
  const enabledCount = prefs.filter((p) => overrides[p.type] ?? p.enabled).length;

  const toggle = async (type: NotificationType, next: boolean) => {
    setOverrides((o) => ({ ...o, [type]: next }));
    setPending(type);
    const res = await run(() => api.put(`/api/users/${userId}/notification-prefs`, { prefs: { [type]: next } }), {
      success: next ? "Turned on" : "Turned off",
      successDescription: byType.get(type)?.label,
    });
    setPending(null);
    setOverrides((o) => {
      const copy = { ...o };
      if (res.ok) return copy; // the refreshed server value takes over
      delete copy[type];
      return copy;
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted" aria-live="polite">
        <span className="numeric font-medium text-ink">{enabledCount}</span> of <span className="numeric">{prefs.length}</span> notification types on.
      </p>
      {GROUPS.map((group) => {
        const items = group.types.map((t) => byType.get(t)).filter((p): p is NotificationPrefView => Boolean(p));
        if (items.length === 0) return null;
        return (
          <SectionCard key={group.id} title={group.title} description={group.description} as="h2">
            <ul className="flex flex-col divide-y divide-border">
              {items.map((p) => {
                const checked = overrides[p.type] ?? p.enabled;
                return (
                  <li key={p.type} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p id={`pref-${p.type}`} className="flex items-center gap-1.5 text-base text-ink">
                        {p.label}
                        {p.mandatory ? (
                          <Tooltip content={MANDATORY_REASON[p.type] ?? "Required so important work never slips."}>
                            <span tabIndex={0} className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-1.5 py-0.5 text-2xs font-medium text-ink-muted focus-ring">
                              <Lock aria-hidden="true" className="size-3" />
                              Always on
                            </span>
                          </Tooltip>
                        ) : null}
                      </p>
                      {p.mandatory ? <p className="mt-0.5 text-xs text-ink-muted">{MANDATORY_REASON[p.type] ?? "Required so important work never slips."}</p> : null}
                    </div>
                    <Switch
                      checked={checked}
                      onCheckedChange={(v) => toggle(p.type, v)}
                      disabled={p.mandatory || pending === p.type}
                      aria-labelledby={`pref-${p.type}`}
                    />
                  </li>
                );
              })}
            </ul>
          </SectionCard>
        );
      })}
    </div>
  );
}
