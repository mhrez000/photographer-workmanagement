"use client";

import * as React from "react";
import { Info, ShieldCheck, X } from "lucide-react";
import { useMutationRunner } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { pluralise } from "@/lib/utils";

export interface RolesNoticeProps {
  settingsVersion: number;
  exManagers: { id: string; name: string; version: number }[];
  exManagerCount: number;
  teamJobEditors: { id: string; name: string; version: number; canViewTeamJobs: boolean }[];
}

/**
 * One-time card after the roles v2 migration (docs/ROLES.md §1.5): former
 * managers became team members (offer "Make admin"), and the old studio-wide
 * "editors see team jobs" switch is now per editor.
 */
export function RolesMigrationNotice({ settingsVersion, exManagers, exManagerCount, teamJobEditors }: RolesNoticeProps) {
  const run = useMutationRunner();
  const [pending, setPending] = React.useState<string | null>(null);

  const makeAdmin = async (p: RolesNoticeProps["exManagers"][number]) => {
    setPending(`admin:${p.id}`);
    await run(() => api.post(`/api/users/${p.id}/admin`, { isAdmin: true, expectedVersion: p.version }), { success: `${p.name} is now an admin` });
    setPending(null);
  };
  const toggleTeamJobs = async (e: RolesNoticeProps["teamJobEditors"][number], value: boolean) => {
    setPending(`team:${e.id}`);
    await run(() => api.post(`/api/users/${e.id}/permissions`, { canViewTeamJobs: value, expectedVersion: e.version }), {
      success: value ? `${e.name} can see other editors' jobs` : `${e.name} sees only their own jobs`,
    });
    setPending(null);
  };
  const dismiss = async () => {
    setPending("dismiss");
    await run(() => api.post("/api/settings/roles-notice/dismiss", { expectedVersion: settingsVersion }), { success: "Notice dismissed" });
    setPending(null);
  };

  return (
    <section aria-labelledby="roles-notice-title" data-roles-notice="" className="rounded-lg border border-info/30 bg-info-soft/40 p-4 shadow-xs">
      <div className="flex items-start gap-3">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info-fg" />
        <div className="min-w-0 flex-1">
          <h2 id="roles-notice-title" className="text-sm font-semibold text-ink">
            Roles changed: Photographer, Editor and Client
          </h2>
          {exManagerCount > 0 ? (
            <div className="mt-2 text-sm text-ink-secondary">
              <p>
                <strong className="font-medium text-ink">{pluralise(exManagerCount, "former manager")} {exManagerCount === 1 ? "is" : "are"} now team members.</strong> They keep every
                team-member switch but manage only their own jobs. Make any of them an admin?
              </p>
              {exManagers.length > 0 ? (
                <ul className="mt-2 flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
                  {exManagers.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="truncate text-ink">{p.name}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        leadingIcon={<ShieldCheck aria-hidden="true" />}
                        loading={pending === `admin:${p.id}`}
                        disabled={pending !== null}
                        onClick={() => void makeAdmin(p)}
                      >
                        Make admin
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {teamJobEditors.length > 0 ? (
            <div className="mt-3 text-sm text-ink-secondary">
              <p>
                Editors used to see their teammates&apos; jobs. That switch is now per editor and covers all editors&apos; jobs. Turn on{" "}
                <strong className="font-medium text-ink">See other editors&apos; jobs</strong> for:
              </p>
              <ul className="mt-2 flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
                {teamJobEditors.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="truncate text-ink">{e.name}</span>
                    <Switch
                      checked={e.canViewTeamJobs}
                      aria-label={`See other editors' jobs: ${e.name}`}
                      disabled={pending !== null}
                      onCheckedChange={(v) => void toggleTeamJobs(e, v)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <Button size="sm" variant="ghost" leadingIcon={<X aria-hidden="true" />} loading={pending === "dismiss"} disabled={pending !== null} onClick={() => void dismiss()}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
