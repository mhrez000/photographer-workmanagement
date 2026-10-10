"use client";

import * as React from "react";
import Link from "next/link";
import { Globe, Lock } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { useMutationRunner } from "@/components/jobs/mutation";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import type { ProjectClientSharing } from "@/lib/sharing";

/** Project page: "Share every job in this project with the client" (admin, docs/ROLES.md §7.2, §11). */
export function ProjectShareCard({ sharing, canManagePortal }: { sharing: ProjectClientSharing; canManagePortal: boolean }) {
  const run = useMutationRunner();
  const [pending, setPending] = React.useState(false);
  const { client } = sharing;

  async function toggle(shared: boolean) {
    setPending(true);
    await run(() => api.post(`/api/projects/${sharing.projectId}/share`, { shared, expectedVersion: sharing.version }), {
      success: shared ? `Project shared with ${client.name}` : `Project no longer shared`,
      successDescription: shared
        ? `${sharing.jobCount} ${sharing.jobCount === 1 ? "job is" : "jobs are"} now visible in their portal.`
        : sharing.individuallySharedJobs > 0
          ? `${sharing.individuallySharedJobs} individually shared ${sharing.individuallySharedJobs === 1 ? "job stays" : "jobs stay"} visible.`
          : undefined,
    });
    setPending(false);
  }

  return (
    <SectionCard
      id="client-sharing"
      title="Client access"
      actions={
        sharing.sharedWithClient && client.portalEnabled && !client.archived ? (
          <Badge variant="success" dot>
            Shared with {client.name}
          </Badge>
        ) : !client.portalEnabled ? (
          <Badge variant="neutral">
            <Lock aria-hidden="true" />
            Portal off
          </Badge>
        ) : null
      }
    >
      <div className="flex flex-col gap-3">
        <Switch
          checked={sharing.sharedWithClient}
          disabled={!sharing.canShare || pending}
          onCheckedChange={(v) => void toggle(v)}
          label="Share every job in this project with the client"
          description="Jobs added later are shared too. The client sees job names, milestones and agreed dates; links only when you share them."
        />
        {!sharing.canShare ? <p className="text-xs text-ink-muted">Only an admin can share a whole project.</p> : null}
        {sharing.individuallySharedJobs > 0 && !sharing.sharedWithClient ? (
          <p className="text-sm text-ink-muted">
            {sharing.individuallySharedJobs} {sharing.individuallySharedJobs === 1 ? "job is" : "jobs are"} shared one by one.
          </p>
        ) : null}
        {!client.portalEnabled && !client.archived ? (
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-ink-secondary">
            <Globe aria-hidden="true" className="size-4 text-ink-subtle" />
            {client.name} has no portal access yet.
            {canManagePortal ? (
              <Link href={`/clients/${client.id}#client-portal`} className="font-medium text-accent-ink hover:underline">
                Turn it on
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}
