"use client";

import * as React from "react";
import { KeyRound, MoreHorizontal, UserCheck, UserX, Users } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { SectionCard } from "@/components/common/section-card";
import { RelativeTime } from "@/components/jobs/relative-time";
import { useMutationRunner } from "@/components/jobs/mutation";
import { TempPasswordPanel } from "@/components/settings/temp-password-panel";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import type { ClientPortalAccess, ClientPortalUser } from "@/lib/sharing";
import { InviteClientUserDialog } from "./invite-client-user-dialog";

export interface ClientPortalCardProps {
  access: ClientPortalAccess;
  studioName: string;
  timeZone: string;
}

type PendingAction = { kind: "deactivate" | "reset"; user: ClientPortalUser } | null;

/**
 * Client page "Client portal" card (admin, docs/ROLES.md §7.1): portal access
 * and feedback switches, and the client's portal users (invite, deactivate,
 * reactivate, reset password).
 */
export function ClientPortalCard({ access, studioName, timeZone }: ClientPortalCardProps) {
  const run = useMutationRunner();
  const [saving, setSaving] = React.useState<"portal" | "feedback" | null>(null);
  const [action, setAction] = React.useState<PendingAction>(null);
  const [tempPassword, setTempPassword] = React.useState<{ user: ClientPortalUser; password: string } | null>(null);
  const activeUsers = access.users.filter((u) => u.isActive).length;

  async function setSwitch(which: "portal" | "feedback", value: boolean) {
    setSaving(which);
    const body = which === "portal" ? { portalEnabled: value } : { feedbackEnabled: value };
    await run(() => api.post(`/api/clients/${access.clientId}/portal`, { ...body, expectedVersion: access.version }), {
      success:
        which === "portal"
          ? value
            ? `Portal on for ${access.clientName}`
            : `Portal off — ${access.clientName}'s users are logged out`
          : value
            ? "Client feedback on"
            : "Client feedback off",
    });
    setSaving(null);
  }

  async function deactivate(user: ClientPortalUser) {
    await run(() => api.post(`/api/users/${user.id}/deactivate`, { expectedVersion: user.version }), { success: `${user.name} can no longer sign in` });
  }

  async function reactivate(user: ClientPortalUser) {
    await run(() => api.post(`/api/users/${user.id}/reactivate`, { expectedVersion: user.version }), { success: `${user.name} can sign in again` });
  }

  async function resetPassword(user: ClientPortalUser) {
    const res = await run(() => api.post<{ userId: string; tempPassword: string }>(`/api/users/${user.id}/reset-password`, {}), {
      success: "Temporary password created",
    });
    if (res.ok) setTempPassword({ user, password: res.data.tempPassword });
  }

  return (
    <SectionCard
      id="client-portal"
      title="Client portal"
      description="A simple, read-only view of the work you share with this client."
      actions={
        access.archived ? (
          <Badge variant="outline">Closed while archived</Badge>
        ) : access.portalEnabled ? (
          <Badge variant="success" dot>
            On
          </Badge>
        ) : (
          <Badge variant="neutral">Off</Badge>
        )
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <Switch
            checked={access.portalEnabled}
            disabled={saving !== null || access.archived}
            onCheckedChange={(v) => void setSwitch("portal", v)}
            label="Portal access"
            description="Their users can sign in and see shared jobs, milestones and delivered links. Turning it off logs them out."
          />
          <Switch
            checked={access.feedbackEnabled}
            disabled={saving !== null || access.archived}
            onCheckedChange={(v) => void setSwitch("feedback", v)}
            label="Allow feedback"
            description="Their users can leave feedback on shared jobs. You and the job's reviewer are notified."
          />
          <p className="text-sm text-ink-muted">
            Shared now: {access.sharedProjectCount} {access.sharedProjectCount === 1 ? "project" : "projects"} · {access.sharedJobCount}{" "}
            {access.sharedJobCount === 1 ? "job" : "jobs"}. Share from a project or job page.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Users aria-hidden="true" className="size-4 text-ink-subtle" />
              Portal users
              <span className="font-normal text-ink-muted">({activeUsers} active)</span>
            </h3>
            <InviteClientUserDialog clientId={access.clientId} clientName={access.clientName} studioName={studioName} disabled={!access.portalEnabled || access.archived} />
          </div>
          {!access.portalEnabled && !access.archived ? <p className="text-xs text-ink-muted">Turn on portal access to invite people.</p> : null}
          {access.users.length === 0 ? (
            <p className="rounded-md border border-dashed border-border-strong px-3 py-4 text-center text-sm text-ink-muted">
              No one from {access.clientName} has a portal account yet.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {access.users.map((u) => (
                <li key={u.id} className="flex items-center gap-3 px-3 py-2.5">
                  <Avatar name={u.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-ink">{u.name}</span>
                      {!u.isActive ? (
                        <Badge size="sm" variant="outline">
                          Deactivated
                        </Badge>
                      ) : null}
                    </div>
                    <p className="truncate text-xs text-ink-muted">
                      {u.email} ·{" "}
                      {u.lastLoginAt ? (
                        <>
                          last signed in <RelativeTime value={u.lastLoginAt} timeZone={timeZone} />
                        </>
                      ) : (
                        "never signed in"
                      )}
                    </p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger variant="ghost" size="icon" aria-label={`Actions for ${u.name}`}>
                      <MoreHorizontal aria-hidden="true" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" aria-label={`Actions for ${u.name}`}>
                      {u.isActive ? (
                        <>
                          <DropdownMenuItem icon={<KeyRound aria-hidden="true" />} onSelect={() => setAction({ kind: "reset", user: u })}>
                            Reset password
                          </DropdownMenuItem>
                          <DropdownMenuItem destructive icon={<UserX aria-hidden="true" />} onSelect={() => setAction({ kind: "deactivate", user: u })}>
                            Deactivate
                          </DropdownMenuItem>
                        </>
                      ) : (
                        <DropdownMenuItem icon={<UserCheck aria-hidden="true" />} onSelect={() => void reactivate(u)}>
                          Reactivate
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={action !== null}
        onOpenChange={(o) => {
          if (!o) setAction(null);
        }}
        title={action?.kind === "deactivate" ? `Deactivate ${action.user.name}?` : `Reset ${action?.user.name ?? ""}'s password?`}
        description={
          action?.kind === "deactivate"
            ? "They are logged out and can't sign in until you reactivate them. Their feedback stays on the jobs."
            : "They are logged out everywhere. You'll get a temporary password to send them."
        }
        confirmLabel={action?.kind === "deactivate" ? "Deactivate" : "Reset password"}
        destructive={action?.kind === "deactivate"}
        onConfirm={() => (action ? (action.kind === "deactivate" ? deactivate(action.user) : resetPassword(action.user)) : undefined)}
      />

      <Dialog open={tempPassword !== null} onOpenChange={(o) => (o ? undefined : setTempPassword(null))}>
        <DialogHeader>
          <DialogTitle>New temporary password</DialogTitle>
        </DialogHeader>
        <DialogBody>{tempPassword ? <TempPasswordPanel name={tempPassword.user.name} email={tempPassword.user.email} password={tempPassword.password} /> : null}</DialogBody>
        <DialogFooter>
          <Button onClick={() => setTempPassword(null)}>Done</Button>
        </DialogFooter>
      </Dialog>
    </SectionCard>
  );
}
