import { ExternalLink, FileText, Images } from "lucide-react";
import { RelativeTime } from "@/components/jobs/relative-time";
import { EmptyState } from "@/components/ui/empty-state";
import type { LinkKind } from "@/lib/constants";
import type { PortalLink, PortalNote } from "@/lib/types";

/** Client-facing names for link kinds (the studio's own label wins when set). */
export const CLIENT_LINK_LABELS: Record<LinkKind, string> = {
  client_delivery: "Your delivery",
  gallery: "Gallery",
  finished_files: "Finished photos",
  reference: "Reference",
  raw_files: "Files",
  editing_workspace: "Files",
  other: "Link",
};

const PROVIDER_NAMES: Record<string, string> = {
  drive: "Google Drive",
  dropbox: "Dropbox",
  onedrive: "OneDrive",
  frameio: "Frame.io",
  wetransfer: "WeTransfer",
  lightroom: "Lightroom",
};

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * "View your photos": the links the studio shared (current, explicitly shared).
 * External, new tab, `rel="noopener noreferrer"` (§7.5).
 */
export function PortalDeliveryLinks({ links, emptyText }: { links: PortalLink[]; emptyText: string }) {
  if (links.length === 0) {
    return <EmptyState size="sm" bordered icon={Images} title="Nothing to open yet" description={emptyText} />;
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {links.map((l) => {
        const title = l.label?.trim() || CLIENT_LINK_LABELS[l.kind];
        const where = (l.provider && PROVIDER_NAMES[l.provider]) || hostOf(l.url);
        return (
          <li key={l.id}>
            <a
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group/link flex h-full items-center gap-3 rounded-lg border border-border bg-surface p-4 shadow-xs transition-[border-color,box-shadow] hover:border-accent/50 hover:shadow-md focus-ring"
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
                <Images aria-hidden="true" className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-semibold text-ink">{title}</span>
                <span className="block truncate text-sm text-ink-muted">{where}</span>
              </span>
              <ExternalLink aria-hidden="true" className="size-4 shrink-0 text-ink-subtle transition-colors group-hover/link:text-accent-ink" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** Delivery notes written by the studio for the client (plain text). */
export function PortalDeliveryNotes({ notes, timeZone }: { notes: PortalNote[]; timeZone: string }) {
  if (notes.length === 0) return null;
  return (
    <ul className="flex flex-col gap-3">
      {notes.map((n) => (
        <li key={n.id} className="rounded-lg border border-border bg-surface p-4">
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <FileText aria-hidden="true" className="size-3.5" />
            <span className="font-medium text-ink-secondary">{n.authorName}</span>
            <RelativeTime value={n.createdAt} timeZone={timeZone} />
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink">{n.body}</p>
        </li>
      ))}
    </ul>
  );
}
