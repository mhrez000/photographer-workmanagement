"use client";

import * as React from "react";
import { KeyRound, MoreHorizontal, UserCheck, UserX } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { SectionCard } from "@/components/common/section-card";
import { RelativeTime } from "@/components/jobs/relative-time";
import { useMutationRunner } from "@/components/jobs/mutation";
import { TempPasswordPanel } from "@/components/settings/temp-password-panel";
import { InviteClientUserDialog } from "@/components/sharing/invite-client-user-dialog";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import type { ClientPortalAccess, ClientPortalUser } from "@/lib/sharing";

export interface ClientOnlineAccessProps {
  access: ClientPortalAccess;
  studioName: string;
  timeZone: string;
}

type PendingAction = { kind: "deactivate" | "reset"; user: ClientPortalUser } | null;

/**
 * The client page's portal card in plain words (docs/SIMPLIFICATION-PLAN.md §3, §8 "Clients (with the
 * portal switch per client)"): "Client can see their work online", "Client can leave feedback", and the
 * people from the client who can sign in. Owners only (`client.manage_portal`); the page renders nothing
 * for anyone else. POST /api/clients/:id/portal with the client's version; 409 → reload toast.
 */
export function ClientOnlineAccess({ access, studioName, timeZone }: ClientOnlineAccessProps) {
  const run = useMutationRunner();
  const [saving, setSaving] = React.useState<"portal" | "feedback" | null>(null);
  const [action, setAction] = React.useState<PendingAction>(null);
  const [tempPassword, setTempPassword] = React.useState<{ user: ClientPortalUser; password: string } | null>(null);
  const activeUsers = access.users.filter((u) => u.isActive);

  async function setSwitch(which: "portal" | "feedback", value: boolean) {
    setSaving(which);
    const body = which === "portal" ? { portalEnabled: value } : { feedbackEnabled: value };
    await run(() => api.post(`/api/clients/${access.clientId}/portal`, { ...body, expectedVersion: access.version }), {
      success:
        which === "portal"
          ? value
            ? `${access.clientName} can now see their work online`
            : `${access.clientName} can no longer see their work online — their people are signed out`
          : value
            ? `${access.clientName} can leave feedback`
            : "Feedback turned off",
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
      id="client-online"
      title="Online access"
      description="A simple page where the client follows progress and gets the finished photos."
      actions={
        access.archived ? (
          <Badge variant="outline">Off while archived</Badge>
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
            label="Client can see their work online"
            description={
              access.portalEnabled
                ? `Showing ${access.sharedJobCount} ${access.sharedJobCount === 1 ? "job" : "jobs"}. You choose what to share when you approve a job.`
                : "Off: nothing is shared, and nobody from this client can sign in."
            }
          />
          <Switch
            checked={access.feedbackEnabled}
            disabled={saving !== null || access.archived || !access.portalEnabled}
            onCheckedChange={(v) => void setSwitch("feedback", v)}
            label="Client can leave feedback"
            description="Their comments show up on the job, in the From the client section."
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">
              Who can sign in <span className="font-normal text-ink-muted">({activeUsers.length})</span>
            </h3>
            <InviteClientUserDialog clientId={access.clientId} clientName={access.clientName} studioName={studioName} disabled={!access.portalEnabled || access.archived} />
          </div>
          {!access.portalEnabled && !access.archived ? <p className="text-xs text-ink-muted">Turn on online access first, then invite someone.</p> : null}
          {access.users.length === 0 ? (
            <p className="rounded-md border border-dashed border-border-strong px-3 py-4 text-center text-sm text-ink-muted">Nobody from {access.clientName} has a login yet.</p>
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
                          Can&apos;t sign in
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
                            Remove access
                          </DropdownMenuItem>
                        </>
                      ) : (
                        <DropdownMenuItem icon={<UserCheck aria-hidden="true" />} onSelect={() => void reactivate(u)}>
                          Give access back
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
        title={action?.kind === "deactivate" ? `Remove ${action.user.name}'s access?` : `Reset ${action?.user.name ?? ""}'s password?`}
        description={
          action?.kind === "deactivate"
            ? "They are signed out and can't sign in until you give access back. Their feedback stays on the jobs."
            : "They are signed out everywhere. You'll get a temporary password to send them."
        }
        confirmLabel={action?.kind === "deactivate" ? "Remove access" : "Reset password"}
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
