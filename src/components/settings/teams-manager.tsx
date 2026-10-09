"use client";

import * as React from "react";
import { Archive, Crown, History, MoreHorizontal, Pencil, Plus, UserMinus, UserPlus, UsersRound } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Avatar, AvatarGroup } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, type ApiError } from "@/lib/api-client";
import { ROLE_LABELS } from "@/lib/constants";
import { formatDate } from "@/lib/dates";
import type { TeamDetail, UserRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useConflict } from "./use-conflict";

export interface TeamsManagerProps {
  teams: TeamDetail[];
  people: UserRef[];
  canManage: boolean;
  timeZone: string;
}

/* ------------------------------------------------------------------ */
/*  Create / edit dialog                                               */
/* ------------------------------------------------------------------ */

function TeamDialog({
  open,
  onOpenChange,
  team,
  people,
  onConflict,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  team: TeamDetail | null;
  people: UserRef[];
  onConflict: (err: ApiError) => void;
}) {
  const run = useMutationRunner();
  const [name, setName] = React.useState(team?.name ?? "");
  const [description, setDescription] = React.useState(team?.description ?? "");
  const [leadId, setLeadId] = React.useState(team?.lead?.id ?? "");
  const [members, setMembers] = React.useState<string[]>([]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setPending(true);
    const res = team
      ? await run(
          () =>
            api.patch(`/api/teams/${team.id}`, {
              expectedVersion: team.version,
              name: name.trim(),
              description: description.trim() || null,
              leadUserId: leadId || null,
            }),
          {
            success: "Team updated",
            onConflict: (err) => {
              onOpenChange(false);
              onConflict(err);
            },
          },
        )
      : await run(
          () =>
            api.post("/api/teams", {
              name: name.trim(),
              description: description.trim() || null,
              leadUserId: leadId || null,
              memberIds: Array.from(new Set([...members, ...(leadId ? [leadId] : [])])),
            }),
          { success: `Team “${name.trim()}” created` },
        );
    setPending(false);
    if (res.ok) onOpenChange(false);
    else if (res.fieldErrors) setErrors(firstFieldErrors(res.fieldErrors));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (pending ? undefined : onOpenChange(o))} size="md">
      <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
        <DialogHeader>
          <DialogTitle>{team ? `Edit ${team.name}` : "Create a team"}</DialogTitle>
          <DialogDescription>Teams drive team visibility and team workloads. A person can belong to several teams.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 pb-4">
          <FormField label="Name" required error={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} placeholder="Real estate team" />
          </FormField>
          <FormField label="Description" optional error={errors.description}>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} />
          </FormField>
          <FormField label="Team lead" optional description={team ? undefined : "The lead is added as a member."} error={errors.leadUserId}>
            <Select value={leadId} onChange={(e) => setLeadId(e.target.value)}>
              <option value="">No lead</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {ROLE_LABELS[p.role]}
                </option>
              ))}
            </Select>
          </FormField>
          {!team ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-sm font-medium text-ink">
                Members <span className="font-normal text-ink-muted">({members.length} selected)</span>
              </legend>
              <div className="max-h-60 overflow-y-auto rounded-md border border-border p-2 scrollbar-thin">
                <div className="grid gap-1 sm:grid-cols-2">
                  {people.map((p) => (
                    <Checkbox
                      key={p.id}
                      size="sm"
                      checked={members.includes(p.id)}
                      onChange={(e) => setMembers((m) => (e.target.checked ? [...m, p.id] : m.filter((x) => x !== p.id)))}
                      label={
                        <span className="flex items-center gap-2">
                          <Avatar name={p.name} colour={p.avatarColour} size="xs" />
                          <span className="truncate">{p.name}</span>
                          <span className="text-xs text-ink-subtle">{ROLE_LABELS[p.role]}</span>
                        </span>
                      }
                      wrapperClassName="rounded-sm px-1.5 py-1 hover:bg-surface-muted"
                    />
                  ))}
                </div>
              </div>
            </fieldset>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            {team ? "Save team" : "Create team"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  One team                                                           */
/* ------------------------------------------------------------------ */

function TeamCard({
  team,
  people,
  canManage,
  timeZone,
  onEdit,
  onArchive,
}: {
  team: TeamDetail;
  people: UserRef[];
  canManage: boolean;
  timeZone: string;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const run = useMutationRunner();
  const [adding, setAdding] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [showHistory, setShowHistory] = React.useState(false);
  const archived = team.archivedAt !== null;
  const memberIds = new Set(team.members.map((m) => m.id));
  const addable = people.filter((p) => !memberIds.has(p.id));
  const departed = team.memberships.filter((m) => m.leftAt !== null);

  const add = async () => {
    if (!adding) return;
    setBusy("add");
    const person = people.find((p) => p.id === adding);
    const res = await run(() => api.post(`/api/teams/${team.id}/members`, { userId: adding }), { success: `${person?.name ?? "Member"} added to ${team.name}` });
    setBusy(null);
    if (res.ok) setAdding("");
  };

  const remove = async (user: UserRef) => {
    setBusy(user.id);
    await run(() => api.post(`/api/teams/${team.id}/members/${user.id}/remove`, {}), { success: `${user.name} removed from ${team.name}` });
    setBusy(null);
  };

  return (
    <Card className={cn("overflow-hidden", archived && "opacity-75")}>
      <div className="flex items-start gap-4 px-5 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-md font-semibold text-ink">{team.name}</h2>
            <Badge variant="neutral" size="sm" className="numeric">
              {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
            </Badge>
            {archived ? (
              <Badge variant="outline" size="sm">
                Archived {formatDate(team.archivedAt, timeZone)}
              </Badge>
            ) : null}
          </div>
          {team.description ? <p className="mt-0.5 text-sm text-ink-muted">{team.description}</p> : null}
          <p className="mt-1.5 flex items-center gap-1.5 text-sm text-ink-secondary">
            <Crown aria-hidden="true" className="size-3.5 text-attention" />
            {team.lead ? (
              <>
                Led by <span className="font-medium text-ink">{team.lead.name}</span>
              </>
            ) : (
              <span className="text-ink-muted">No lead</span>
            )}
          </p>
        </div>
        <AvatarGroup items={team.members.map((m) => ({ name: m.name, colour: m.avatarColour }))} max={5} size="sm" className="hidden sm:flex" />
        {canManage && !archived ? (
          <DropdownMenu>
            <DropdownMenuTrigger variant="ghost" size="icon" aria-label={`${team.name} actions`}>
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" width="12rem">
              <DropdownMenuItem icon={<Pencil />} onSelect={onEdit}>
                Rename / edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={<Archive />} destructive onSelect={onArchive}>
                Archive team
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <div className="border-t border-border">
        {team.members.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-muted">No members yet{canManage && !archived ? " — add someone below." : "."}</p>
        ) : (
          <ul className="divide-y divide-border">
            {team.members.map((m) => {
              const ledger = team.memberships.find((x) => x.user.id === m.id && x.leftAt === null);
              return (
                <li key={m.id} className="flex items-center gap-3 px-5 py-2">
                  <Avatar name={m.name} colour={m.avatarColour} size="sm" className={m.isActive ? undefined : "opacity-50 grayscale"} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-sm text-ink">
                      {m.name}
                      {team.lead?.id === m.id ? (
                        <Badge variant="attention" size="sm">
                          Lead
                        </Badge>
                      ) : null}
                      {!m.isActive ? (
                        <Badge variant="neutral" size="sm">
                          Deactivated
                        </Badge>
                      ) : null}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {ROLE_LABELS[m.role]}
                      {ledger ? <span className="numeric"> · joined {formatDate(ledger.joinedAt, timeZone)}</span> : null}
                    </p>
                  </div>
                  {canManage && !archived ? (
                    <IconButton label={`Remove ${m.name} from ${team.name}`} size="sm" variant="ghost" loading={busy === m.id} onClick={() => remove(m)}>
                      <UserMinus />
                    </IconButton>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {canManage && !archived ? (
        <div className="flex flex-col gap-2 border-t border-border bg-surface-sunken/60 px-5 py-3 sm:flex-row sm:items-center">
          <Select value={adding} onChange={(e) => setAdding(e.target.value)} size="sm" aria-label={`Add a member to ${team.name}`} wrapperClassName="sm:max-w-xs">
            <option value="">Add a member…</option>
            {addable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {ROLE_LABELS[p.role]}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="outline" leadingIcon={<UserPlus aria-hidden="true" />} onClick={add} disabled={!adding} loading={busy === "add"}>
            Add
          </Button>
          {team.memberships.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              className="sm:ml-auto"
              leadingIcon={<History aria-hidden="true" />}
              onClick={() => setShowHistory((s) => !s)}
              aria-expanded={showHistory}
            >
              {showHistory ? "Hide history" : `Membership history (${team.memberships.length})`}
            </Button>
          ) : null}
        </div>
      ) : team.memberships.length > 0 ? (
        <div className="border-t border-border px-5 py-2">
          <Button size="sm" variant="ghost" leadingIcon={<History aria-hidden="true" />} onClick={() => setShowHistory((s) => !s)} aria-expanded={showHistory}>
            {showHistory ? "Hide history" : `Membership history (${team.memberships.length})`}
          </Button>
        </div>
      ) : null}

      {showHistory ? (
        <div className="animate-fade-in border-t border-border px-5 py-3">
          <p className="mb-2 text-xs text-ink-muted">
            Every join and leave is kept{departed.length > 0 ? ` — ${departed.length} former ${departed.length === 1 ? "member" : "members"}` : ""}.
          </p>
          <ol className="flex flex-col gap-1.5 text-sm">
            {[...team.memberships]
              .sort((a, b) => (a.joinedAt < b.joinedAt ? 1 : -1))
              .map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-medium text-ink">{m.user.name}</span>
                  <span className="numeric text-ink-muted">
                    joined {formatDate(m.joinedAt, timeZone)}
                    {m.addedBy ? ` by ${m.addedBy.name}` : ""}
                  </span>
                  {m.leftAt ? (
                    <span className="numeric text-ink-muted">
                      · left {formatDate(m.leftAt, timeZone)}
                      {m.removedBy ? ` (removed by ${m.removedBy.name})` : ""}
                    </span>
                  ) : (
                    <Badge variant="success" size="sm">
                      Current
                    </Badge>
                  )}
                </li>
              ))}
          </ol>
        </div>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Page body                                                          */
/* ------------------------------------------------------------------ */

export function TeamsManager({ teams, people, canManage, timeZone }: TeamsManagerProps) {
  const run = useMutationRunner();
  const { onConflict, dialog } = useConflict("team", timeZone);
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<TeamDetail | null>(null);
  const [archiving, setArchiving] = React.useState<TeamDetail | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const active = teams.filter((t) => t.archivedAt === null);
  const archived = teams.filter((t) => t.archivedAt !== null);

  return (
    <div className="flex flex-col gap-4">
      {canManage ? (
        <div className="flex justify-end">
          <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setCreating(true)}>
            New team
          </Button>
        </div>
      ) : null}

      {active.length === 0 ? (
        <Card>
          <EmptyState
            icon={UsersRound}
            title="No teams yet"
            description="Group photographers and editors who work together. Teams power “see my team's jobs” visibility and team workloads."
            action={
              canManage ? (
                <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setCreating(true)}>
                  Create the first team
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {active.map((team) => (
            <TeamCard
              key={team.id}
              team={team}
              people={people}
              canManage={canManage}
              timeZone={timeZone}
              onEdit={() => setEditing(team)}
              onArchive={() => setArchiving(team)}
            />
          ))}
        </div>
      )}

      {archived.length > 0 ? (
        <div className="flex flex-col gap-3">
          <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowArchived((s) => !s)} aria-expanded={showArchived}>
            {showArchived ? "Hide" : "Show"} archived teams ({archived.length})
          </Button>
          {showArchived ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {archived.map((team) => (
                <TeamCard key={team.id} team={team} people={people} canManage={canManage} timeZone={timeZone} onEdit={() => undefined} onArchive={() => undefined} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {creating ? <TeamDialog open={creating} onOpenChange={setCreating} team={null} people={people} onConflict={onConflict} /> : null}
      {editing ? <TeamDialog key={editing.id} open onOpenChange={(o) => !o && setEditing(null)} team={editing} people={people} onConflict={onConflict} /> : null}

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={`Archive ${archiving?.name ?? "team"}?`}
        description="Members stop sharing team visibility through it. The team and its membership history stay on record."
        confirmLabel="Archive team"
        destructive
        onConfirm={async () => {
          if (!archiving) return true;
          const res = await run(() => api.post(`/api/teams/${archiving.id}/archive`, { expectedVersion: archiving.version }), {
            success: `${archiving.name} archived`,
            onConflict,
          });
          return res.ok || res.handled;
        }}
      />
      {dialog}
    </div>
  );
}
