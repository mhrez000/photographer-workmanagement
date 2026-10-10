"use client";

import * as React from "react";
import Link from "next/link";
import { EyeOff, KeyRound, RotateCcw, UserMinus, UserX } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { SectionCard } from "@/components/common/section-card";
import { useMutationRunner } from "@/components/jobs/mutation";
import { useUserOptions } from "@/components/jobs/use-user-options";
import { WorkloadBand } from "@/components/jobs/workload-band";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, type ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { UserProfile } from "@/lib/types";
import { TempPasswordPanel } from "./temp-password-panel";
import { useConflict } from "./use-conflict";

export interface OpenJobBrief {
  id: string;
  jobNumber: string;
  name: string;
  statusName: string;
  statusColour: string;
}

/** What the viewer may do to this account (computed server-side with `can()`, docs/ROLES.md §3.3–§3.4). */
export interface LifecycleAccess {
  resetPassword: boolean;
  deactivate: boolean;
  reactivate: boolean;
  anonymise: boolean;
  /** Why every control is locked (e.g. "Only Hannah Brooks can change their own account"). */
  lockedReason?: string | null;
}

export interface UserLifecycleProps {
  profile: UserProfile;
  access: LifecycleAccess;
  isSelf: boolean;
  /** Deactivating an admin also removes admin (docs/ROLES.md §3.4). */
  targetIsAdmin?: boolean;
  editorJobs: OpenJobBrief[];
  photographerJobs: OpenJobBrief[];
  timeZone: string;
}

function JobList({ jobs, max = 8 }: { jobs: OpenJobBrief[]; max?: number }) {
  const shown = jobs.slice(0, max);
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {shown.map((j) => (
        <li key={j.id} className="flex items-center gap-3 px-3 py-2 text-sm">
          <span className="font-mono text-xs text-ink-muted numeric">{j.jobNumber}</span>
          <Link href={`/jobs/${j.id}`} className="min-w-0 flex-1 truncate text-ink hover:text-accent-ink focus-ring rounded-xs" target="_blank">
            {j.name}
          </Link>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-ink-muted">
            <span className="size-1.5 rounded-full" style={{ backgroundColor: j.statusColour }} aria-hidden="true" />
            {j.statusName}
          </span>
        </li>
      ))}
      {jobs.length > max ? <li className="px-3 py-2 text-xs text-ink-muted">and {jobs.length - max} more…</li> : null}
    </ul>
  );
}

/* ------------------------------------------------------------------ */

function DeactivateDialog({
  open,
  onOpenChange,
  profile,
  editorJobs,
  photographerJobs,
  onConflict,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: UserProfile;
  editorJobs: OpenJobBrief[];
  photographerJobs: OpenJobBrief[];
  onConflict: (err: ApiError) => void;
}) {
  const run = useMutationRunner();
  const hasEditorJobs = editorJobs.length > 0;
  const [mode, setMode] = React.useState<"reassign" | "unassign">("reassign");
  const [reassignTo, setReassignTo] = React.useState<string>("");
  const [reason, setReason] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const editors = useUserOptions("editor", { enabled: open && hasEditorJobs });
  const candidates = editors.options.filter((o) => o.id !== profile.id && o.isActive);

  const submit = async () => {
    setError(null);
    if (hasEditorJobs && mode === "reassign" && !reassignTo) {
      setError("Choose who takes over, or unassign the jobs instead.");
      return;
    }
    setPending(true);
    const body: Record<string, unknown> = { expectedVersion: profile.version, reason: reason.trim() || null };
    if (hasEditorJobs && mode === "reassign") body.reassignTo = reassignTo;
    if (hasEditorJobs && mode === "unassign") body.unassign = true;
    const res = await run(() => api.post(`/api/users/${profile.id}/deactivate`, body), {
      success: `${profile.name} deactivated`,
      successDescription: hasEditorJobs
        ? mode === "reassign"
          ? `${editorJobs.length} job${editorJobs.length === 1 ? "" : "s"} handed over.`
          : `${editorJobs.length} job${editorJobs.length === 1 ? "" : "s"} back to Ready for assignment.`
        : "They've been signed out everywhere.",
      onConflict: (err) => {
        onOpenChange(false);
        onConflict(err);
      },
    });
    setPending(false);
    if (res.ok) onOpenChange(false);
    else if (res.fieldErrors) setError(Object.values(res.fieldErrors)[0]?.[0] ?? "Check the form");
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (pending ? undefined : onOpenChange(o))} size="md">
      <DialogHeader>
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-danger-soft text-danger ring-1 ring-inset ring-danger/15">
          <UserX aria-hidden="true" className="size-5" />
        </div>
        <DialogTitle>Deactivate {profile.name}?</DialogTitle>
        <DialogDescription>
          They’re signed out immediately and can’t sign in again. Their history, comments and completed work stay exactly as they are.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-5 pb-4">
        {hasEditorJobs ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium text-ink">
              {profile.name.split(" ")[0]} is editing <span className="numeric">{editorJobs.length}</span> open job{editorJobs.length === 1 ? "" : "s"}
            </p>
            <JobList jobs={editorJobs} />
            <div role="radiogroup" aria-label="What happens to these jobs" className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["reassign", "Reassign to an editor", "Work continues; stage time moves to the new editor."],
                  ["unassign", "Unassign", "Jobs go back to Ready for assignment."],
                ] as const
              ).map(([value, title, desc]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={mode === value}
                  onClick={() => setMode(value)}
                  className={cn(
                    "flex flex-col items-start rounded-md border px-3 py-2.5 text-left transition-colors duration-(--motion-fast) focus-ring",
                    mode === value ? "border-accent bg-accent-soft/50" : "border-border hover:border-border-hover",
                  )}
                >
                  <span className="text-sm font-medium text-ink">{title}</span>
                  <span className="text-xs text-ink-muted">{desc}</span>
                </button>
              ))}
            </div>
            {mode === "reassign" ? (
              <FormField label="New editor" error={error ?? undefined}>
                {(field) => (
                  <div {...field} role="listbox" aria-label="New editor" className="max-h-56 overflow-y-auto rounded-md border border-border scrollbar-thin">
                    {editors.loading ? (
                      <p className="px-3 py-3 text-sm text-ink-muted">Loading editors…</p>
                    ) : candidates.length === 0 ? (
                      <p className="px-3 py-3 text-sm text-ink-muted">No other active editors. Unassign instead.</p>
                    ) : (
                      candidates.map((o) => (
                        <button
                          key={o.id}
                          type="button"
                          role="option"
                          aria-selected={reassignTo === o.id}
                          onClick={() => setReassignTo(o.id)}
                          className={cn(
                            "flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left text-sm last:border-0 focus-ring-inset",
                            reassignTo === o.id ? "bg-accent-soft/60" : "hover:bg-surface-muted",
                          )}
                        >
                          <Avatar name={o.name} colour={o.avatarColour || undefined} size="sm" />
                          <span className="min-w-0 flex-1 truncate text-ink">{o.name}</span>
                          {o.activeJobs !== null ? <span className="text-xs text-ink-muted numeric">{o.activeJobs} active</span> : null}
                          {o.band ? <WorkloadBand band={o.band} size="sm" /> : null}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </FormField>
            ) : error ? (
              <p className="text-sm text-danger">{error}</p>
            ) : null}
          </div>
        ) : (
          <p className="rounded-md bg-surface-sunken px-3 py-2.5 text-sm text-ink-secondary">No open editing jobs — nothing needs to be handed over.</p>
        )}

        {photographerJobs.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-ink">
              Photographer on <span className="numeric">{photographerJobs.length}</span> open job{photographerJobs.length === 1 ? "" : "s"}
            </p>
            <p className="text-xs text-ink-muted">These keep {profile.name.split(" ")[0]} as photographer. Reassign them from each job if someone else should review.</p>
            <JobList jobs={photographerJobs} max={4} />
          </div>
        ) : null}

        <FormField label="Reason" optional description="Recorded in the activity log.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} placeholder="e.g. Contract ended" />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
          Cancel
        </Button>
        <Button variant="danger" onClick={submit} loading={pending}>
          Deactivate
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */

function AnonymiseDialog({ open, onOpenChange, profile, onConflict }: { open: boolean; onOpenChange: (o: boolean) => void; profile: UserProfile; onConflict: (err: ApiError) => void }) {
  const run = useMutationRunner();
  const [typed, setTyped] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const matches = typed.trim() === profile.name.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!matches) return;
    setPending(true);
    const res = await run(() => api.post(`/api/users/${profile.id}/anonymise`, { expectedVersion: profile.version }), {
      success: "User anonymised",
      successDescription: "Their name and email were replaced. History is intact.",
      onConflict: (err) => {
        onOpenChange(false);
        onConflict(err);
      },
    });
    setPending(false);
    if (res.ok) onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return;
        onOpenChange(o);
        if (!o) setTyped("");
      }}
      size="sm"
    >
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <DialogHeader>
          <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-danger-soft text-danger ring-1 ring-inset ring-danger/15">
            <EyeOff aria-hidden="true" className="size-5" />
          </div>
          <DialogTitle>Anonymise {profile.name}?</DialogTitle>
          <DialogDescription>
            Their name, email and title are replaced everywhere, permanently. Jobs, events and metrics stay intact but show “Former user”. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="pb-4">
          <FormField label={<>Type <span className="font-mono text-ink">{profile.name}</span> to confirm</>}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={pending} disabled={!matches}>
            Anonymise permanently
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */

/** Password reset, deactivate / reactivate, anonymise. */
export function UserLifecycleCard({ profile, access, isSelf, targetIsAdmin = false, editorJobs, photographerJobs, timeZone }: UserLifecycleProps) {
  const run = useMutationRunner();
  const { onConflict, dialog } = useConflict("user", timeZone);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [tempPassword, setTempPassword] = React.useState<string | null>(null);
  const [deactivateOpen, setDeactivateOpen] = React.useState(false);
  const [reactivateOpen, setReactivateOpen] = React.useState(false);
  const [anonymiseOpen, setAnonymiseOpen] = React.useState(false);

  const anonymised = Boolean(profile.anonymisedAt);
  if (isSelf) {
    return (
      <SectionCard title="Account" description="This is you.">
        <p className="text-sm text-ink-muted">
          Change your own name, avatar and password from{" "}
          <Link href="/settings/profile" className="font-medium text-accent-ink hover:underline">
            your profile
          </Link>
          . Another admin must deactivate you; nobody can deactivate the primary owner.
        </p>
      </SectionCard>
    );
  }
  const anyControl = access.resetPassword || access.deactivate || access.reactivate || access.anonymise;
  if (!anyControl) {
    return (
      <SectionCard title="Account">
        <p className="text-sm text-ink-muted">{access.lockedReason ?? "Only an admin can manage this person’s account."}</p>
      </SectionCard>
    );
  }

  const reset = async () => {
    const res = await run(() => api.post<{ userId: string; tempPassword: string }>(`/api/users/${profile.id}/reset-password`, {}), { noRefresh: false });
    if (res.ok) {
      setTempPassword(res.data.tempPassword);
      return false; // keep the dialog open to show the password
    }
    return true;
  };

  return (
    <SectionCard title="Account" description="Sign-in, access and data retention." tone={profile.isActive ? "default" : "muted"}>
      <div className="flex flex-col divide-y divide-border">
        {!anonymised && access.resetPassword ? (
          <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-base font-medium text-ink">Reset password</p>
              <p className="text-sm text-ink-muted">Creates a temporary password and signs them out everywhere.</p>
            </div>
            <Button variant="outline" size="sm" leadingIcon={<KeyRound aria-hidden="true" />} onClick={() => setResetOpen(true)}>
              Reset password
            </Button>
          </div>
        ) : null}

        {profile.isActive && access.deactivate ? (
          <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-base font-medium text-ink">Deactivate</p>
              <p className="text-sm text-ink-muted">
                Removes access immediately{editorJobs.length > 0 ? ` and hands over ${editorJobs.length} open job${editorJobs.length === 1 ? "" : "s"}` : ""}.
                {targetIsAdmin ? " It also removes their admin access; reactivating brings them back as a team member." : ""}
              </p>
            </div>
            <Button variant="danger" size="sm" leadingIcon={<UserMinus aria-hidden="true" />} onClick={() => setDeactivateOpen(true)}>
              Deactivate…
            </Button>
          </div>
        ) : !profile.isActive && !anonymised && access.reactivate ? (
          <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-base font-medium text-ink">Reactivate</p>
              <p className="text-sm text-ink-muted">Restores sign-in. Jobs handed over at deactivation stay with their new editors.</p>
            </div>
            <Button variant="outline" size="sm" leadingIcon={<RotateCcw aria-hidden="true" />} onClick={() => setReactivateOpen(true)}>
              Reactivate
            </Button>
          </div>
        ) : null}

        {!anonymised && (access.anonymise || (profile.isActive && access.deactivate)) ? (
          <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-base font-medium text-ink">Anonymise</p>
              <p className="text-sm text-ink-muted">
                {profile.isActive ? "Deactivate first. " : ""}Permanently replaces personal details; history and metrics are kept.
              </p>
            </div>
            <Button variant="outline" size="sm" leadingIcon={<EyeOff aria-hidden="true" />} onClick={() => setAnonymiseOpen(true)} disabled={profile.isActive}>
              Anonymise…
            </Button>
          </div>
        ) : null}

        {anonymised ? <p className="text-sm text-ink-muted">This account was anonymised and can no longer be changed.</p> : null}
      </div>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={(o) => {
          setResetOpen(o);
          if (!o) setTempPassword(null);
        }}
        title={tempPassword ? "New temporary password" : `Reset ${profile.name}'s password?`}
        description={tempPassword ? undefined : "Their current password stops working and every session is signed out."}
        confirmLabel={tempPassword ? "Done" : "Reset password"}
        onConfirm={tempPassword ? () => true : reset}
      >
        {tempPassword ? <TempPasswordPanel name={profile.name} email={profile.email} password={tempPassword} /> : null}
      </ConfirmDialog>

      <DeactivateDialog
        open={deactivateOpen}
        onOpenChange={setDeactivateOpen}
        profile={profile}
        editorJobs={editorJobs}
        photographerJobs={photographerJobs}
        onConflict={onConflict}
      />

      <ConfirmDialog
        open={reactivateOpen}
        onOpenChange={setReactivateOpen}
        title={`Reactivate ${profile.name}?`}
        description="They can sign in again with their existing password (or reset it first)."
        confirmLabel="Reactivate"
        onConfirm={async () => {
          const res = await run(() => api.post(`/api/users/${profile.id}/reactivate`, { expectedVersion: profile.version }), {
            success: `${profile.name} reactivated`,
            onConflict,
          });
          return res.ok || res.handled;
        }}
      />

      {access.anonymise ? <AnonymiseDialog open={anonymiseOpen} onOpenChange={setAnonymiseOpen} profile={profile} onConflict={onConflict} /> : null}
      {dialog}
    </SectionCard>
  );
}
