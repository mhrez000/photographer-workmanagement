import * as React from "react";
import { ChevronRight, FolderOpen } from "lucide-react";
import { CopyButton, SectionCard } from "@/components/common";
import { ExternalLinkButton, LinkProviderIcon, linkHost } from "@/components/jobs";
import { LINK_KIND_META, type LinkKind } from "@/lib/constants";
import { formatDateShort, formatDateTime } from "@/lib/dates";
import type { LinkView, SimpleFiles } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AddLinkInline } from "./add-link-inline";

export interface FilesSectionProps {
  jobId: string;
  files: SimpleFiles;
  timeZone: string;
  /** The viewer may add a raw files link (photographers; editors in a draft). */
  canAddRaw: boolean;
  /** "Other" kinds the viewer may add (floor plan, references …). */
  otherKindsAllowed: readonly LinkKind[];
  photographerName?: string | null;
  editorName?: string | null;
  className?: string;
}

/** One link row: provider glyph · name · host · Open · Copy · who / when. */
function LinkRow({ link, timeZone, muted = false }: { link: LinkView; timeZone: string; muted?: boolean }) {
  const name = link.label?.trim() || LINK_KIND_META[link.kind].label;
  const host = linkHost(link.url);
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 py-2", muted && "opacity-80")}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <LinkProviderIcon provider={link.provider} url={link.url} className="text-ink-muted" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink" title={link.url}>
            {name}
            {host ? <span className="ml-1.5 font-normal text-ink-muted">{host}</span> : null}
          </p>
          <p className="text-xs text-ink-muted">
            {link.addedBy.name} ·{" "}
            <time dateTime={link.createdAt} title={formatDateTime(link.createdAt, timeZone)}>
              {formatDateShort(link.createdAt, timeZone)}
            </time>
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <ExternalLinkButton url={link.url} label="Open" provider={link.provider} hideHost size="sm" />
        <CopyButton value={link.url} label="Copy" successMessage="Link copied" size="sm" variant="ghost" />
      </div>
    </div>
  );
}

function Slot({ title, hint, children }: { title: string; hint?: string | null; children: React.ReactNode }) {
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {hint ? <span className="text-xs text-ink-muted">{hint}</span> : null}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/**
 * Files (plan §5): Raw files (from the photographer) · Finished photos (from
 * the editor; a new link replaces the old one, older ones sit under "Earlier
 * versions") · Other links (collapsed).
 */
export function FilesSection({ jobId, files, timeZone, canAddRaw, otherKindsAllowed, photographerName, editorName, className }: FilesSectionProps) {
  const others = files.other;
  return (
    <SectionCard id="files" title="Files" className={className} bodyClassName="divide-y divide-border">
      <Slot title="Raw files" hint={photographerName ? `from ${photographerName}` : "from the photographer"}>
        {files.raw ? (
          <LinkRow link={files.raw} timeZone={timeZone} />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 py-1">
            <p className="text-sm text-ink-muted">No raw files link yet.</p>
            {canAddRaw ? <AddLinkInline jobId={jobId} kinds={["raw_files"]} label="Add raw files link" /> : null}
          </div>
        )}
      </Slot>

      <Slot title="Finished photos" hint={editorName ? `from ${editorName}` : "from the editor"}>
        {files.finished ? <LinkRow link={files.finished} timeZone={timeZone} /> : <p className="py-1 text-sm text-ink-muted">Nothing sent for checking yet.</p>}
        {files.earlierVersions.length > 0 ? (
          <details className="group mt-1">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xs py-1 text-sm text-ink-muted hover:text-ink focus-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden="true" className="size-4 transition-transform group-open:rotate-90" />
              Earlier versions ({files.earlierVersions.length})
            </summary>
            <div className="divide-y divide-border/70 pl-5">
              {files.earlierVersions.map((l) => (
                <LinkRow key={l.id} link={l} timeZone={timeZone} muted />
              ))}
            </div>
          </details>
        ) : null}
      </Slot>

      <Slot title="Other links">
        {others.length === 0 && otherKindsAllowed.length === 0 ? (
          <p className="py-1 text-sm text-ink-muted">None.</p>
        ) : (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xs py-1 text-sm text-ink-muted hover:text-ink focus-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden="true" className="size-4 transition-transform group-open:rotate-90" />
              <FolderOpen aria-hidden="true" className="size-4" />
              {others.length === 0 ? "Floor plans, references and so on" : `${others.length} ${others.length === 1 ? "link" : "links"}`}
            </summary>
            <div className="mt-1 flex flex-col gap-2 pl-5">
              {others.length > 0 ? (
                <div className="divide-y divide-border/70">
                  {others.map((l) => (
                    <LinkRow key={l.id} link={l} timeZone={timeZone} />
                  ))}
                </div>
              ) : null}
              {otherKindsAllowed.length > 0 ? <AddLinkInline jobId={jobId} kinds={otherKindsAllowed} label="Add a link" className="self-start" /> : null}
            </div>
          </details>
        )}
      </Slot>
    </SectionCard>
  );
}
