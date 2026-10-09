"use client";

import * as React from "react";
import { UserPlus } from "lucide-react";
import { useUrlState } from "@/hooks/use-url-state";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { ROLES, ROLE_LABELS, type Role } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { InviteUserDialog } from "./invite-user-dialog";

export interface UsersToolbarProps {
  viewerRole: Role;
  canInvite: boolean;
  defaultCapacity: number;
}

/** Search / role / status filters (URL state) + the invite dialog (`?invite=1`). */
export function UsersToolbar({ viewerRole, canInvite, defaultCapacity }: UsersToolbarProps) {
  const url = useUrlState();
  const status = url.get("status") ?? "active";
  const inviteOpen = canInvite && url.get("invite") === "1";

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
      <Select
        value={url.get("role") ?? ""}
        onChange={(e) => url.set("role", e.target.value)}
        aria-label="Filter by role"
        wrapperClassName="sm:w-44"
      >
        <option value="">All roles</option>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}s
          </option>
        ))}
      </Select>
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
        <Button className="sm:ml-auto" leadingIcon={<UserPlus aria-hidden="true" />} onClick={() => url.set("invite", "1")}>
          Invite user
        </Button>
      ) : null}
      {canInvite ? (
        <InviteUserDialog
          open={inviteOpen}
          onOpenChange={(open) => url.set("invite", open ? "1" : null)}
          viewerRole={viewerRole}
          defaultCapacity={defaultCapacity}
        />
      ) : null}
    </div>
  );
}
