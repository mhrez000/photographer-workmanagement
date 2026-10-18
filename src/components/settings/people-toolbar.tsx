"use client";

import * as React from "react";
import { UserPlus } from "lucide-react";
import { useUrlState } from "@/hooks/use-url-state";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { Role } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { InvitePersonDialog, type PortalClientOption } from "./invite-person-dialog";

export interface PeopleToolbarProps {
  canInvite: boolean;
  studioName: string;
  portalClients: PortalClientOption[];
  /** The studio's timezone (invite links show their expiry date). */
  timeZone: string;
}

/** Search + Active / Deactivated (URL state) and the invite dialog (`?invite=1`, `?invite=client`). */
export function PeopleToolbar({ canInvite, studioName, portalClients, timeZone }: PeopleToolbarProps) {
  const url = useUrlState();
  const status = url.get("status") ?? "active";
  const invite = url.get("invite");
  const inviteOpen = canInvite && (invite === "1" || invite === "client" || invite === "editor");
  const inviteRole: Role = invite === "client" ? "client" : invite === "editor" ? "editor" : "photographer";

  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-center", url.isPending && "opacity-80")}>
      <SearchInput
        key={url.get("q") ?? ""}
        defaultValue={url.get("q") ?? ""}
        onDebouncedChange={(q) => url.set("q", q.trim())}
        placeholder="Search by name or email"
        aria-label="Search people"
        className="sm:max-w-xs"
        wrapperClassName="sm:max-w-xs"
      />
      <SegmentedControl
        size="sm"
        aria-label="Who to show"
        value={status}
        onValueChange={(v) => url.set("status", v === "active" ? null : v)}
        options={[
          { value: "active", label: "Active" },
          { value: "inactive", label: "Deactivated" },
        ]}
      />
      {canInvite ? (
        <Button className="sm:ml-auto" leadingIcon={<UserPlus aria-hidden="true" />} onClick={() => url.set("invite", "1")} data-invite-button="">
          Invite someone
        </Button>
      ) : null}
      {canInvite ? (
        <InvitePersonDialog
          key={inviteRole}
          open={inviteOpen}
          onOpenChange={(open) => url.set("invite", open ? invite ?? "1" : null)}
          studioName={studioName}
          portalClients={portalClients}
          timeZone={timeZone}
          initialRole={inviteRole}
        />
      ) : null}
    </div>
  );
}
