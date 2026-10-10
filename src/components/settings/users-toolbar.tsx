"use client";

import * as React from "react";
import { UserPlus } from "lucide-react";
import { useUrlState } from "@/hooks/use-url-state";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { PERSONA_LABELS, type Role } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { InviteUserDialog, type PortalClientOption } from "./invite-user-dialog";

/** Personas listed on the Team tab (clients have their own tab). */
export const TEAM_PERSONA_FILTERS = ["admin", "member", "editor"] as const;
export type TeamPersonaFilter = (typeof TEAM_PERSONA_FILTERS)[number];

export interface UsersToolbarProps {
  /** "team" (photographers + editors) or "clients" (client portal users). */
  tab: "team" | "clients";
  canInvite: boolean;
  defaultCapacity: number;
  studioName: string;
  portalClients: PortalClientOption[];
}

/** Search / persona / status filters (URL state) + the invite dialog (`?invite=1`, `?invite=client`). */
export function UsersToolbar({ tab, canInvite, defaultCapacity, studioName, portalClients }: UsersToolbarProps) {
  const url = useUrlState();
  const status = url.get("status") ?? "active";
  const invite = url.get("invite");
  const inviteOpen = canInvite && (invite === "1" || invite === "client");
  const inviteRole: Role = invite === "client" || tab === "clients" ? "client" : "photographer";

  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-center", url.isPending && "opacity-80")}>
      <SearchInput
        key={url.get("q") ?? ""}
        defaultValue={url.get("q") ?? ""}
        onDebouncedChange={(q) => url.set("q", q.trim())}
        placeholder="Search name or email"
        aria-label="Search users"
        className="sm:max-w-xs"
        wrapperClassName="sm:max-w-xs"
      />
      {tab === "team" ? (
        <Select
          value={url.get("persona") ?? ""}
          onChange={(e) => url.set("persona", e.target.value)}
          aria-label="Filter by role"
          wrapperClassName="sm:w-56 sm:shrink-0"
        >
          <option value="">Everyone</option>
          {TEAM_PERSONA_FILTERS.map((p) => (
            <option key={p} value={p}>
              {PERSONA_LABELS[p]}
            </option>
          ))}
        </Select>
      ) : null}
      <SegmentedControl
        size="sm"
        aria-label="Account status"
        value={status}
        onValueChange={(v) => url.set("status", v === "active" ? null : v)}
        options={[
          { value: "active", label: "Active" },
          { value: "inactive", label: "Deactivated" },
          { value: "all", label: "All" },
        ]}
      />
      {canInvite ? (
        <Button className="sm:ml-auto" leadingIcon={<UserPlus aria-hidden="true" />} onClick={() => url.set("invite", tab === "clients" ? "client" : "1")}>
          {tab === "clients" ? "Invite client user" : "Invite someone"}
        </Button>
      ) : null}
      {canInvite ? (
        <InviteUserDialog
          key={inviteRole}
          open={inviteOpen}
          onOpenChange={(open) => url.set("invite", open ? (inviteRole === "client" ? "client" : "1") : null)}
          defaultCapacity={defaultCapacity}
          studioName={studioName}
          portalClients={portalClients}
          initialRole={inviteRole}
        />
      ) : null}
    </div>
  );
}
