"use client";

import * as React from "react";
import { Ban, KeyRound, MoreHorizontal, Send, UserCheck, UserX } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { SectionCard } from "@/components/common/section-card";
import { RelativeTime } from "@/components/jobs/relative-time";
import { useMutationRunner } from "@/components/jobs/mutation";
import { InviteLinkPanel, type InviteNotSentReason } from "@/components/settings/invite-link-panel";
import { TempPasswordPanel } from "@/components/settings/temp-password-panel";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/dates";
import { isDemoAccountEmail } from "@/lib/constants";
import type { ClientPortalAccess, ClientPortalUser } from "@/lib/sharing";
import { ClientInviteDialog } from "./client-invite-dialog";

/** Front door: a portal user who has not opened their invite link yet. `live` = a link still works. */
export interface ClientUserInvite {
  live: { expiresAt: string } | null;
}

export interface ClientOnlineAccessProps {
  access: ClientPortalAccess;
  studioName: string;
  timeZone: string;
  /** Pending invites by user id (people with `accepted_at` null); anyone missing has joined. */
  invites?: Record<string, ClientUserInvite>;
  /**
   * The demo studio (docs/ACCOUNTS.md §7): invites and password resets are refused there (403), so those controls are
   * not offered and the Invite button says why.
   */
  demo?: boolean;
}

type PendingAction = { kind: "deactivate" | "reset" | "resend" | "revoke"; user: ClientPortalUser } | null;

interface ResendResult {
  inviteUrl: string;
  emailed: boolean;
  expiresAt: string;
  /** Why it was not emailed ("unconfirmed_sender": the owner's own email is not confirmed yet). */
  notSentReason?: InviteNotSentReason | null;
}

/**
 * The client page's portal card in plain words (docs/SIMPLIFICATION-PLAN.md §3, §8 "Clients (with the
 * portal switch per client)"): "Client can see their work online", "Client can leave feedback", and the
 * people from the client who can sign in. Owners only (`client.manage_portal`); the page renders nothing
 * for anyone else. POST /api/clients/:id/portal with the client's version; 409 → reload toast.
 * Invites (front door): the default is a LINK; a pending person shows "Invite pending · expires …" with
 * Send a new link / Revoke invite in their menu. Copying never invalidates a link; only a new one does.
 */
export function ClientOnlineAccess({ access, studioName, timeZone, invites = {}, demo = false }: ClientOnlineAccessProps) {
  const run = useMutationRunner();
  const [saving, setSaving] = React.useState<"portal" | "feedback" | null>(null);
  const [action, setAction] = React.useState<PendingAction>(null);
  const [tempPassword, setTempPassword] = React.useState<{ user: ClientPortalUser; password: string } | null>(null);
  const [freshLink, setFreshLink] = React.useState<{ user: ClientPortalUser; link: ResendResult } | null>(null);
  const activeUsers = access.users.filter((u) => u.isActive);
  // The demo's Client persona belongs to this client (SEC-07 / DEMO-01): its online access can't be switched off and
  // its people can't be removed — the services refuse both (403), so the screen doesn't offer them.
  const demoPersonaClient = demo && access.users.some((u) => isDemoAccountEmail(u.email));

  async function setSwitch(which: "portal" | "feedback", value: boolean) {
    setSaving(which);
    const body = which === "portal" ? { portalEnabled: value } : { feedbackEnabled: value };
    await run(() => api.post(`/api/clients/${access.clientId}/portal`, { ...body, expectedVersion: access.version }), {
      success:
        which === "portal"
          ? value
            ? `${access.clientName} can now see their work online`
            : `${access.clientName} can no longer see their work online — their people are logged out`
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

  async function resendInvite(user: ClientPortalUser) {
    const res = await run(() => api.post<ResendResult>(`/api/users/${user.id}/invite/resend`, {}), { success: `New invite link for ${user.name}` });
    if (res.ok) setFreshLink({ user, link: res.data });
  }

  async function revokeInvite(user: ClientPortalUser) {
    await run(() => api.post<{ userId: string; revoked: number }>(`/api/users/${user.id}/invite/revoke`, {}), { success: `${user.name}'s invite link no longer works` });
  }

  const confirmCopy: Record<NonNullable<PendingAction>["kind"], { title: (n: string) => string; description: string; confirm: string; destructive: boolean }> = {
    deactivate: {
      title: (n) => `Remove ${n}'s access?`,
      description: "They are logged out and can't sign in until you give access back. Their feedback stays on the jobs.",
      confirm: "Remove access",
      destructive: true,
    },
    reset: {
      title: (n) => `Reset ${n}'s password?`,
      description: "They are logged out everywhere. You'll get a temporary password to send them.",
      confirm: "Reset password",
      destructive: false,
    },
    resend: {
      title: (n) => `Send ${n} a new invite link?`,
      description: "Any link they already have stops working. You can copy the new one here, and it is emailed when your studio has email set up.",
      confirm: "Send a new link",
      destructive: false,
    },
    revoke: {
      title: (n) => `Revoke ${n}'s invite?`,
      description: "Their link stops working and they have no way in until you send a new one. The account stays.",
      confirm: "Revoke invite",
      destructive: true,
    },
  };
  const current = action ? confirmCopy[action.kind] : null;

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
            disabled={saving !== null || access.archived || (demoPersonaClient && access.portalEnabled)}
            onCheckedChange={(v) => void setSwitch("portal", v)}
            label="Client can see their work online"
            description={
              demoPersonaClient && access.portalEnabled
                ? "Stays on in the demo studio: it is how visitors look around as the client."
                : access.portalEnabled
                  ? `Showing ${access.sharedJobCount} ${access.sharedJobCount === 1 ? "job" : "jobs"}. You choose what to share when you approve a job.`
                  : "Off: nothing is shared, and nobody from this client can sign in."
            }
            data-demo-locked={demoPersonaClient ? "" : undefined}
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
            <ClientInviteDialog clientId={access.clientId} clientName={access.clientName} studioName={studioName} timeZone={timeZone} disabled={demo || !access.portalEnabled || access.archived} />
          </div>
          {demo ? (
            <p className="text-xs text-ink-muted" data-demo-invites-off="">
              Invites are turned off in the demo studio.
            </p>
          ) : !access.portalEnabled && !access.archived ? (
            <p className="text-xs text-ink-muted">Turn on online access first, then invite someone.</p>
          ) : null}
          {access.users.length === 0 ? (
            <p className="rounded-md border border-dashed border-border-strong px-3 py-4 text-center text-sm text-ink-muted">Nobody from {access.clientName} has a login yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {access.users.map((u) => {
                const invite = u.isActive ? invites[u.id] : undefined;
                // DEMO-03: the demo accounts can't be changed (403), so their row offers nothing that would fail.
                const persona = demo && isDemoAccountEmail(u.email);
                return (
                  <li key={u.id} className="flex items-center gap-3 px-3 py-2.5">
                    <Avatar name={u.name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-ink">{u.name}</span>
                        {!u.isActive ? (
                          <Badge size="sm" variant="outline">
                            Can&apos;t sign in
                          </Badge>
                        ) : invite ? (
                          invite.live ? (
                            <Badge size="sm" variant="warning" dot data-invite-pending="live">
                              Invite pending · expires {formatDate(invite.live.expiresAt, timeZone)}
                            </Badge>
                          ) : (
                            <Badge size="sm" variant="neutral" data-invite-pending="stale">
                              Invite pending · needs a new link
                            </Badge>
                          )
                        ) : null}
                      </div>
                      <p className="truncate text-xs text-ink-muted">
                        {u.email} ·{" "}
                        {u.lastLoginAt ? (
                          <>
                            last signed in <RelativeTime value={u.lastLoginAt} timeZone={timeZone} />
                          </>
                        ) : invite ? (
                          "not joined yet"
                        ) : (
                          "never signed in"
                        )}
                      </p>
                    </div>
                    {persona ? (
                      <Badge size="sm" variant="outline" data-demo-persona-row="">
                        Demo account
                      </Badge>
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger variant="ghost" size="icon" aria-label={`Actions for ${u.name}`}>
                          <MoreHorizontal aria-hidden="true" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" aria-label={`Actions for ${u.name}`}>
                          {u.isActive ? (
                            <>
                              {invite && !demo ? (
                                <>
                                  <DropdownMenuItem icon={<Send aria-hidden="true" />} onSelect={() => setAction({ kind: "resend", user: u })}>
                                    Send a new link
                                  </DropdownMenuItem>
                                  {invite.live ? (
                                    <DropdownMenuItem icon={<Ban aria-hidden="true" />} onSelect={() => setAction({ kind: "revoke", user: u })}>
                                      Revoke invite
                                    </DropdownMenuItem>
                                  ) : null}
                                </>
                              ) : null}
                              {demo ? null : (
                                <DropdownMenuItem icon={<KeyRound aria-hidden="true" />} onSelect={() => setAction({ kind: "reset", user: u })}>
                                  {invite ? "Set a temporary password" : "Reset password"}
                                </DropdownMenuItem>
                              )}
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
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={action !== null}
        onOpenChange={(o) => {
          if (!o) setAction(null);
        }}
        title={action && current ? current.title(action.user.name) : ""}
        description={current?.description}
        confirmLabel={current?.confirm ?? "Confirm"}
        destructive={current?.destructive ?? false}
        onConfirm={() => {
          if (!action) return undefined;
          switch (action.kind) {
            case "deactivate":
              return deactivate(action.user);
            case "reset":
              return resetPassword(action.user);
            case "resend":
              return resendInvite(action.user);
            case "revoke":
              return revokeInvite(action.user);
          }
        }}
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

      <Dialog open={freshLink !== null} onOpenChange={(o) => (o ? undefined : setFreshLink(null))} size="lg">
        <DialogHeader>
          <DialogTitle>{freshLink ? `Invite link for ${freshLink.user.name}` : "Invite link"}</DialogTitle>
          <DialogDescription>Their older links stopped working. Copy this one before you close it.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {freshLink ? (
            <InviteLinkPanel
              name={freshLink.user.name}
              email={freshLink.user.email}
              inviteUrl={freshLink.link.inviteUrl}
              emailed={freshLink.link.emailed}
              notSentReason={freshLink.link.notSentReason}
              expiresAt={freshLink.link.expiresAt}
              timeZone={timeZone}
            />
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setFreshLink(null)}>Done</Button>
        </DialogFooter>
      </Dialog>
    </SectionCard>
  );
}
