import * as React from "react";
import { ChevronRight, FolderCheck, History, Plus } from "lucide-react";
import { ExternalLinkButton, LinkProviderIcon, PersonChip } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { LINK_KIND_META } from "@/lib/constants";
import { formatDate, formatDateTime } from "@/lib/dates";
import type { LinkSlot, LinkView } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Older versions of a link's slot, newest first (excluding the current row). */
export function previousVersions(slots: readonly LinkSlot[], link: LinkView): LinkView[] {
  const slot = slots.find((s) => s.history.some((h) => h.id === link.id));
  if (!slot) return [];
  return slot.history.filter((h) => h.id !== link.id).reverse();
}

function VersionRow({ link, timeZone }: { link: LinkView; timeZone: string }) {
  return (
    <li className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 items-center gap-2">
        <LinkProviderIcon provider={link.provider} url={link.url} className="size-3.5 shrink-0 text-ink-subtle" />
        <a href={link.url} target="_blank" rel="noopener noreferrer" className="truncate text-sm text-ink-secondary underline-offset-2 hover:text-ink hover:underline focus-ring rounded-xs" title={link.url}>
          {link.label ?? link.url}
        </a>
      </div>
      <div className="shrink-0 text-xs text-ink-muted numeric">
        Added by {link.addedBy.name} · {formatDate(link.createdAt, timeZone)}
        {link.supersededAt ? ` · replaced ${formatDate(link.supersededAt, timeZone)}` : ""}
        {link.removedAt ? ` · removed ${formatDate(link.removedAt, timeZone)}${link.removedBy ? ` by ${link.removedBy.name}` : ""}` : ""}
      </div>
    </li>
  );
}

/** One finished-work link: where it is, who added it and when, plus its earlier versions. */
export function FinishedWorkItem({ link, previous, timeZone, prominent }: { link: LinkView; previous: LinkView[]; timeZone: string; prominent: boolean }) {
  return (
    <li className={cn("flex flex-col gap-3 py-4 first:pt-0 last:pb-0")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md ring-1 ring-inset", prominent ? "bg-surface text-accent-ink ring-accent/20" : "bg-surface-muted text-ink-muted ring-border")}>
            <LinkProviderIcon provider={link.provider} url={link.url} className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="eyebrow">{LINK_KIND_META[link.kind].label}</p>
            <p className="truncate text-md font-medium text-ink" title={link.url}>
              {link.label ?? link.url}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-muted">
              <span>Added by</span>
              <PersonChip user={link.addedBy} size="xs" className="[&_.truncate]:text-xs" />
              <span aria-hidden="true">·</span>
              <time dateTime={link.createdAt} className="numeric" title={formatDateTime(link.createdAt, timeZone)}>
                {formatDateTime(link.createdAt, timeZone)}
              </time>
            </p>
          </div>
        </div>
        <ExternalLinkButton url={link.url} label="View finished work" provider={link.provider} size="md" variant={prominent ? "secondary" : "outline"} hideHost className="shrink-0 sm:w-auto" />
      </div>
      {previous.length > 0 ? (
        <details className="group rounded-md border border-border bg-surface-sunken/70 px-3">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 py-2 text-xs font-medium text-ink-secondary focus-ring rounded-xs [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-90" />
            <History aria-hidden="true" className="size-3.5" />
            {previous.length} previous {previous.length === 1 ? "version" : "versions"}
          </summary>
          <ul className="divide-y divide-border border-t border-border pb-1">
            {previous.map((p) => (
              <VersionRow key={p.id} link={p} timeZone={timeZone} />
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

export interface FinishedWorkPanelProps {
  links: LinkView[];
  slots: LinkSlot[];
  timeZone: string;
  /** Category ∈ DONE: shown first and emphasised (spec §35). */
  prominent: boolean;
  /** Viewer may add a finished-work link. */
  canAdd: boolean;
  addHref: string;
}

/** The "Finished Work" section: gallery / Dropbox / Drive / Frame.io / delivery links with history. */
export function FinishedWorkPanel({ links, slots, timeZone, prominent, canAdd, addHref }: FinishedWorkPanelProps) {
  return (
    <section aria-labelledby="finished-work-title">
      <Card tone={prominent ? "accent" : "default"} className={cn(prominent && "shadow-sm")}>
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
          <div className="flex items-center gap-3">
            <span className={cn("flex size-9 items-center justify-center rounded-full", prominent ? "bg-accent text-accent-fg" : "bg-surface-muted text-ink-muted")}>
              <FolderCheck aria-hidden="true" className="size-4.5" />
            </span>
            <div>
              <h2 id="finished-work-title" className="text-md font-semibold text-ink">
                Finished work
              </h2>
              <p className="text-sm text-ink-muted">
                {links.length > 0
                  ? `${links.length} ${links.length === 1 ? "place" : "places"} to find the delivered files`
                  : "Where the edited files and client delivery live"}
              </p>
            </div>
          </div>
          {canAdd ? (
            <Button href={addHref} variant="ghost" size="sm" leadingIcon={<Plus aria-hidden="true" />}>
              Add link
            </Button>
          ) : null}
        </div>
        <div className="px-5 pb-5">
          {links.length === 0 ? (
            <EmptyState
              size="sm"
              bordered
              icon={FolderCheck}
              title="No finished work linked yet"
              description="When the edit is done, add the gallery, Dropbox, Drive or Frame.io link here so everyone can find it without hunting."
              action={canAdd ? <Button href={addHref} size="sm" leadingIcon={<Plus aria-hidden="true" />}>Add finished work link</Button> : null}
            />
          ) : (
            <ul className="divide-y divide-border/70">
              {links.map((l) => (
                <FinishedWorkItem key={l.id} link={l} previous={previousVersions(slots, l)} timeZone={timeZone} prominent={prominent} />
              ))}
            </ul>
          )}
        </div>
      </Card>
    </section>
  );
}
