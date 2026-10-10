"use client";

import * as React from "react";
import { ExternalLink, Link2 } from "lucide-react";
import { useMutationRunner } from "@/components/jobs/mutation";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { LINK_KIND_META } from "@/lib/constants";
import type { SharingLink } from "@/lib/sharing";
import { cn } from "@/lib/utils";

/**
 * Current links with a per-link "Visible to client" switch (docs/ROLES.md §7.3):
 * nothing is visible by kind, only explicitly shared links.
 */
export function SharedLinksList({ links, clientName }: { links: SharingLink[]; clientName: string }) {
  const run = useMutationRunner();
  const [pending, setPending] = React.useState<string | null>(null);

  async function toggle(link: SharingLink, shared: boolean) {
    setPending(link.id);
    await run(() => api.post(`/api/links/${link.id}/share`, { shared }), {
      success: shared ? "Link shared with the client" : "Link hidden from the client",
      successDescription: shared ? `${clientName} can open it once the job is shared.` : undefined,
    });
    setPending(null);
  }

  if (links.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-muted">
        <Link2 aria-hidden="true" className="size-4" />
        No links on this job yet.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {links.map((l) => {
        const title = l.label?.trim() || LINK_KIND_META[l.kind].label;
        return (
          <li key={l.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-w-0 items-center gap-1 truncate text-sm font-medium text-ink hover:text-accent-ink hover:underline focus-ring"
                >
                  <span className="truncate">{title}</span>
                  <ExternalLink aria-hidden="true" className="size-3 shrink-0 text-ink-subtle" />
                </a>
                {l.label?.trim() ? (
                  <Badge size="sm" variant="neutral">
                    {LINK_KIND_META[l.kind].label}
                  </Badge>
                ) : null}
                {l.sharedWithClient ? (
                  <Badge size="sm" variant="success" dot>
                    Visible to client
                  </Badge>
                ) : null}
              </div>
              <p className="truncate text-xs text-ink-muted">Added by {l.addedByName}</p>
            </div>
            <Switch
              size="sm"
              checked={l.sharedWithClient}
              disabled={!l.canShare || pending === l.id}
              onCheckedChange={(v) => void toggle(l, v)}
              aria-label={`${l.sharedWithClient ? "Hide" : "Share"} ${title} ${l.sharedWithClient ? "from" : "with"} the client`}
              className={cn(!l.canShare && "opacity-40")}
            />
          </li>
        );
      })}
    </ul>
  );
}
